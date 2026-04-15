# 渠道系统架构文档

> 文件路径：`src/channels/` + `extensions/*/`
> 本文档描述 OpenClaw 渠道插件系统的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

渠道系统是 OpenClaw 连接外部消息平台的**适配器层**。每个渠道（Telegram、Discord、Slack、WhatsApp 等）实现统一的 `ChannelPlugin` 接口，Gateway 在启动时扫描并加载所有已启用渠道。

---

## 2. 目录结构

```
src/channels/
├── plugins/
│   ├── types.plugin.ts      # ChannelPlugin 主接口定义
│   ├── types.adapters.ts    # 各适配器接口（Config、Outbound、Gateway 等）
│   ├── types.core.ts        # 核心类型（ChannelId、ChannelMeta、Capabilities）
│   ├── types.ts             # 类型聚合导出
│   ├── index.ts             # 插件注册表（listChannelPlugins、getChannelPlugin）
│   ├── channel-config.ts    # 渠道条目配置匹配
│   ├── helpers.ts           # 辅助函数
│   ├── normalize/           # 各渠道消息格式标准化
│   ├── outbound/            # 各渠道出站消息处理
│   ├── onboarding/          # 各渠道 CLI 配置向导
│   └── status-issues/       # 各渠道健康状态检测
├── allowlists/
│   └── resolve-utils.ts     # 白名单条目规范化和去重
├── registry.ts              # 渠道 ID 注册表和顺序定义
├── chat-type.ts             # 聊天类型（direct/group/thread）
├── dock.ts                  # 渠道停靠（消息入站处理入口）
├── session.ts               # 渠道会话管理
├── typing.ts                # 打字状态管理
└── ...

extensions/                  # 扩展渠道（独立 npm workspace package）
├── msteams/                 # Microsoft Teams
├── matrix/                  # Matrix 协议
├── zalo/                    # Zalo（群组）
├── zalouser/                # Zalo（个人）
├── googlechat/              # Google Chat
├── feishu/                  # 飞书
├── line/                    # LINE
├── irc/                     # IRC
├── mattermost/              # Mattermost
├── nextcloud-talk/          # Nextcloud Talk
├── nostr/                   # Nostr 协议
├── tlon/                    # Tlon
├── twitch/                  # Twitch
├── synology-chat/           # Synology Chat
├── bluebubbles/             # BlueBubbles（iMessage 替代）
└── ...（共 38 个扩展包）
```

---

## 3. 核心接口

### 3.1 ChannelPlugin 接口（`src/channels/plugins/types.plugin.ts`）

每个渠道必须实现 `ChannelPlugin` 接口。接口通过泛型参数 `ResolvedAccount` 支持不同渠道的账户类型：

```typescript
// src/channels/plugins/types.plugin.ts:49-85
// oxlint-disable-next-line typescript/no-explicit-any
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;             // 渠道唯一标识（如 "telegram"、"discord"）
  meta: ChannelMeta;         // 渠道元信息（名称、图标、顺序）
  capabilities: ChannelCapabilities;  // 渠道能力声明（支持哪些功能）
  defaults?: {
    queue?: {
      debounceMs?: number;   // 消息防抖间隔（毫秒）
    };
  };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  // CLI 配置向导钩子
  onboarding?: ChannelOnboardingAdapter;
  // 必须实现：账户配置管理
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  // 可选适配器：
  setup?: ChannelSetupAdapter;          // 账户初始化向导
  pairing?: ChannelPairingAdapter;      // 设备配对
  security?: ChannelSecurityAdapter<ResolvedAccount>;  // DM 策略、allowFrom 检查
  groups?: ChannelGroupAdapter;         // 群组功能
  mentions?: ChannelMentionAdapter;     // @提及处理
  outbound?: ChannelOutboundAdapter;    // 消息出站发送
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;  // 健康探测
  gatewayMethods?: string[];            // 注册的自定义 RPC 方法名
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;  // 自定义 RPC 处理
  auth?: ChannelAuthAdapter;            // 认证流程
  elevated?: ChannelElevatedAdapter;    // 提升权限操作
  commands?: ChannelCommandAdapter;     // 频道命令（/reset 等）
  streaming?: ChannelStreamingAdapter;  // 流式打字状态
  threading?: ChannelThreadingAdapter;  // 线程绑定
  messaging?: ChannelMessagingAdapter;  // 消息格式化
  agentPrompt?: ChannelAgentPromptAdapter;  // 渠道专用 system prompt 片段
  directory?: ChannelDirectoryAdapter;  // 联系人/群组目录
  resolver?: ChannelResolverAdapter;    // 用户/群组 ID 解析
  actions?: ChannelMessageActionAdapter;  // 消息操作（反应、编辑等）
  heartbeat?: ChannelHeartbeatAdapter;  // 心跳检测
  // 渠道专属 agent 工具（如 WhatsApp 登录工具）
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
```

UI 配置提示，用于 Web 控制台渲染配置表单：

```typescript
// src/channels/plugins/types.plugin.ts:33-41
export type ChannelConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;     // 敏感字段（密码、token）
  placeholder?: string;
  itemTemplate?: unknown;
};
```

---

### 3.2 适配器接口（`src/channels/plugins/types.adapters.ts`）

**ChannelConfigAdapter** — 账户配置管理（必须实现）：

```typescript
// src/channels/plugins/types.adapters.ts（ChannelConfigAdapter 部分）
export type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  defaultAccountId?: (cfg: OpenClawConfig) => string;
  setAccountEnabled?: (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => OpenClawConfig;
  deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
  isEnabled?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
  isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
  describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
  resolveAllowFrom?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => Array<string | number> | undefined;
  formatAllowFrom?: (params: { cfg: OpenClawConfig; accountId?: string | null; allowFrom: Array<string | number> }) => string[];
};
```

**ChannelOutboundAdapter** — 消息出站发送：

```typescript
// src/channels/plugins/types.adapters.ts（ChannelOutboundAdapter 部分）
export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";  // 发送模式
  chunker?: ((text: string, limit: number) => string[]) | null;  // 文本分块器
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  pollMaxOptions?: number;
  resolveTarget?: (params: { cfg?: OpenClawConfig; to?: string; allowFrom?: string[]; accountId?: string | null; mode?: ChannelOutboundTargetMode }) => { ok: true; to: string } | { ok: false; error: Error };
  sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
};
```

**ChannelGatewayAdapter** — 自定义 RPC 方法处理：

```typescript
// src/channels/plugins/types.adapters.ts（ChannelGatewayAdapter 部分）
export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  loginWithQrStart?: (params: { accountId?: string; force?: boolean; timeoutMs?: number; verbose?: boolean }) => Promise<ChannelLoginWithQrStartResult>;
  loginWithQrWait?: (params: { accountId?: string; timeoutMs?: number }) => Promise<ChannelLoginWithQrWaitResult>;
  logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
};
```

**ChannelDirectoryAdapter** — 联系人/群组目录：

```typescript
// src/channels/plugins/types.adapters.ts（ChannelDirectoryAdapter 部分）
export type ChannelDirectoryAdapter = {
  self?: (params: ChannelDirectorySelfParams) => Promise<ChannelDirectoryEntry | null>;
  listPeers?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroups?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroupMembers?: (params: ChannelDirectoryListGroupMembersParams) => Promise<ChannelDirectoryEntry[]>;
};
```

---

### 3.3 插件注册表（`src/channels/plugins/index.ts`）

插件注册表通过 `requireActivePluginRegistry()` 获取运行时注册的所有渠道插件，并提供排序、去重和查找功能：

```typescript
// src/channels/plugins/index.ts:5-40
function listPluginChannels(): ChannelPlugin[] {
  const registry = requireActivePluginRegistry();
  return registry.channels.map((entry) => entry.plugin);
}

// 按 meta.order 或 CHAT_CHANNEL_ORDER 排序，去重
export function listChannelPlugins(): ChannelPlugin[] {
  const combined = dedupeChannels(listPluginChannels());
  return combined.toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
}

// 按 ID 快速查找渠道插件
export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = String(id).trim();
  if (!resolvedId) {
    return undefined;
  }
  return listChannelPlugins().find((plugin) => plugin.id === resolvedId);
}
```

---

## 4. 内置渠道

| 渠道 | 目录 | 说明 |
|------|------|------|
| Telegram | `src/telegram/` | 机器人 API，支持群组、频道、线程 |
| Discord | `src/discord/` | 机器人 + Slash Commands |
| Slack | `src/slack/` | Socket Mode + OAuth |
| Signal | `src/signal/` | signal-cli 集成 |
| iMessage | `src/imessage/` | BlueBubbles/AppleScript |
| WhatsApp | `src/web/` | whatsapp-web.js |

---

## 5. 扩展渠道列表

共 38 个扩展渠道包（`extensions/*/`）：

| 扩展包 | 平台 |
|--------|------|
| `msteams` | Microsoft Teams |
| `matrix` | Matrix 协议 |
| `zalo` / `zalouser` | Zalo（越南） |
| `googlechat` | Google Chat |
| `feishu` | 飞书 |
| `line` | LINE |
| `irc` | IRC |
| `mattermost` | Mattermost |
| `nextcloud-talk` | Nextcloud Talk |
| `nostr` | Nostr 去中心化协议 |
| `tlon` | Tlon |
| `twitch` | Twitch 聊天 |
| `synology-chat` | Synology Chat |
| `bluebubbles` | BlueBubbles iMessage |
| `voice-call` | 语音通话 |
| `acpx` | ACP 扩展渠道 |

---

## 6. 白名单系统（`src/channels/allowlists/`）

白名单控制哪些用户/群组可以触发 agent。`resolve-utils.ts` 提供规范化和去重工具：

```typescript
// src/channels/allowlists/resolve-utils.ts（mergeAllowlist 函数）
export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  return dedupeAllowlistEntries([
    ...(params.existing ?? []).map((entry) => String(entry)),
    ...params.additions,
  ]);
}
```

---

## 7. 渠道开发指南

### 创建新渠道扩展

1. 在 `extensions/<channel-id>/` 创建 workspace package
2. 实现 `ChannelPlugin` 接口，导出为默认导出
3. 在 `src/channels/plugins/index.ts` 通过插件注册表注册
4. 运行时依赖放 `dependencies`，`openclaw` 放 `peerDependencies`（避免 `workspace:*`）
5. 在 `.github/labeler.yml` 添加对应标签规则

### 渠道能力声明

`ChannelCapabilities` 声明渠道支持的功能，Gateway 据此决定是否调用对应适配器：

- `markdown`：支持 Markdown 格式
- `images`：支持图片发送
- `files`：支持文件发送
- `reactions`：支持消息反应
- `threads`：支持线程回复
- `streaming`：支持流式打字状态
