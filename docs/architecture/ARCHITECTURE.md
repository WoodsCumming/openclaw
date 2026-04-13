# OpenClaw 架构文档

> 本文档描述 OpenClaw 的整体架构，供开发者快速建立系统全貌。

---

## 1. 系统定位

OpenClaw 是一个**多渠道 AI 网关**——本地优先的控制平面，将 AI 智能体（Pi runtime，通过 ACP 协议）与消息平台（WhatsApp、Telegram、Slack、Discord、Signal、iMessage、Microsoft Teams、Google Chat、Matrix、Zalo、WebChat 等）连接起来。

核心流程：

```
用户消息 → 渠道适配器 → Gateway → 路由解析 → Agent 执行 → 回复分发 → 用户
```

Gateway 以 WebSocket 服务器形式运行（默认 `ws://127.0.0.1:18789`），原生应用（macOS/iOS/Android）作为客户端连接。

---

## 2. 顶层目录结构

```
openclaw/
├── src/                  # 核心源码（TypeScript ESM）
│   ├── gateway/          # WebSocket 控制平面
│   ├── channels/         # 渠道基础设施（适配器接口、注册表）
│   ├── agents/           # Pi agent 运行时集成
│   ├── routing/          # 多级路由解析
│   ├── plugins/          # 插件/钩子系统
│   ├── acp/              # Agent Client Protocol 服务端
│   ├── canvas-host/      # Canvas/A2UI 可视化工作区
│   ├── auto-reply/       # 消息入站分发与回复调度
│   ├── cron/             # 定时任务服务
│   ├── memory/           # 向量记忆后端（嵌入 + 检索）
│   ├── cli/              # CLI 程序骨架（Commander.js）
│   ├── commands/         # 各子命令实现
│   ├── config/           # 配置加载、校验、迁移
│   ├── infra/            # 通用基础设施（网络、Bonjour、事件、心跳…）
│   ├── security/         # 审计、DM 策略、工具策略
│   ├── pairing/          # 设备配对
│   ├── sessions/         # 会话级策略（发送策略、模型覆盖…）
│   ├── media/            # 媒体处理管道
│   ├── tts/              # 文字转语音
│   ├── plugin-sdk/       # 插件公共 SDK（对外 API 面）
│   └── ...               # 各渠道目录（telegram/discord/slack/…）
├── extensions/           # 渠道/功能扩展（workspace packages）
├── apps/                 # 原生应用（macos/ios/android/shared）
├── ui/                   # Web 控制台前端（Vite + TypeScript）
├── docs/                 # 文档（Mintlify）
└── packages/             # 内部共享包
```

---

## 3. 核心架构层

### 3.1 Gateway（`src/gateway/`）

Gateway 是整个系统的**神经中枢**，负责：

- **WebSocket 服务器**（`server-ws-runtime.ts`）：接受来自 Web UI、原生 App、CLI 客户端的连接；每个连接按 role 授权（`operator` / `node` / `admin`）。
- **HTTP 服务器**（`server-http.ts`）：
  - `/v1/chat/completions`：OpenAI 兼容接口（`openai-http.ts`）
  - `/v1/responses`：OpenResponses 接口（`openresponses-http.ts`）
  - Webhook 入站（hooks）
  - Control UI 静态资源服务
  - Slack HTTP 事件
- **RPC 方法分发**（`server-methods.ts`）：将 WebSocket 消息路由到对应 handler，共 70+ 个方法，分组为 `chat.*`、`sessions.*`、`agents.*`、`cron.*`、`node.*`、`config.*`、`skills.*` 等。
- **事件广播**（`server-broadcast.ts`）：向所有连接的客户端推送 `agent`、`chat`、`presence`、`health`、`cron`、`node.*`、`exec.approval.*` 等事件。
- **并发控制**（`server-lanes.ts`）：通过 `CommandLane`（Main / Cron / Subagent / Nested）限制并发 agent 执行数。
- **渠道管理**（`server-channels.ts`）：启动/重启各渠道运行时，带指数退避重试（最多 10 次）。
- **Cron 服务**（`server-cron.ts`）：内置定时任务调度，支持 webhook 回调。
- **Config 热重载**（`config-reload.ts`）：监听配置文件变化，无需重启 Gateway。
- **认证**（`auth.ts`、`auth-rate-limit.ts`）：支持 token / password / Tailscale / trusted-proxy 四种模式，带速率限制防暴力破解。

**启动流程**（`server.impl.ts` → `startGatewayServer`）：

1. 加载配置 + 迁移旧配置
2. 加载插件注册表
3. 启动 sidecars（browser control、Gmail watcher、内部 hooks）
4. 启动渠道
5. 绑定 WebSocket + HTTP 处理器
6. 启动 Cron、Bonjour 发现、Tailscale 暴露、心跳、维护定时器

---

### 3.2 渠道系统（`src/channels/` + `extensions/*/`）

每个渠道是一个**插件**，实现 `ChannelPlugin<ResolvedAccount>` 接口（`src/channels/plugins/types.plugin.ts`）：

```typescript
type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;      // 账户列表、配置读写
  setup?: ChannelSetupAdapter;       // 入站配置向导
  security?: ChannelSecurityAdapter; // DM 策略、allowFrom 检查
  messaging?: ChannelMessagingAdapter; // 消息格式化
  outbound?: ChannelOutboundAdapter;   // 回复发送
  status?: ChannelStatusAdapter;       // 健康探测
  commands?: ChannelCommandAdapter;    // 频道命令（/reset 等）
  streaming?: ChannelStreamingAdapter; // 流式打字状态
  threading?: ChannelThreadingAdapter; // 线程绑定
  gateway?: ChannelGatewayAdapter;     // 自定义 RPC 方法
  pairing?: ChannelPairingAdapter;     // 设备配对
  ...
}
```

**内置渠道**（`src/telegram`、`src/discord`、`src/slack`、`src/signal`、`src/imessage`、`src/web`（WhatsApp））

**扩展渠道**（`extensions/`）：msteams、matrix、zalo、zalouser、googlechat、feishu、line、irc、mattermost、nextcloud-talk、nostr、tlon、twitch、synology-chat 等，每个是独立 npm workspace package。

渠道插件通过 `src/channels/plugins/index.ts` 统一注册，Gateway 在启动时扫描并加载所有已启用渠道。

---

### 3.3 Agent 运行时（`src/agents/`）

Agent 层负责将消息转化为 LLM 调用并处理工具执行，是系统最复杂的层。

#### Pi Embedded Runner（核心执行引擎）

入口：`pi-embedded-runner/run.ts` → `runEmbeddedPiAgent()`

执行流程：
1. **模型解析**（`run/model.ts`）：从配置解析 provider + model，支持 failover 轮换
2. **Auth Profile 轮换**（`model-auth.ts`、`auth-profiles.ts`）：多 API key 轮换，带冷却期
3. **Session 管理**（`@mariozechner/pi-coding-agent` 的 `SessionManager`）：维护 Pi DAG 会话转录
4. **System Prompt 构建**（`run/attempt.ts`）：合并 bootstrap 文件、技能提示、渠道能力、工具提示
5. **工具执行**（`pi-tools.ts`、`bash-tools.ts`）：文件系统工具、Bash 执行（可选沙箱）、渠道工具、子 Agent 工具
6. **流式订阅**（`pi-embedded-subscribe.ts`）：处理 LLM 流式输出，分块推送到渠道

#### 关键子模块

| 模块 | 职责 |
|------|------|
| `model-catalog.ts` | 统一模型目录，聚合所有 provider 的模型列表 |
| `models-config.providers.ts` | 各 provider 配置（Anthropic、OpenAI、Gemini、Ollama、Bedrock、BytePlus、HuggingFace 等 20+ 个） |
| `auth-profiles.ts` | API key 轮换策略，含冷却期、故障标记、round-robin 排序 |
| `sandbox/` | Docker 沙箱配置，隔离 bash 工具执行 |
| `subagent-registry.ts` | 子 Agent 生命周期管理（spawn、announce、cleanup） |
| `skills.ts` | 技能（Skills）加载、合并、快照 |
| `compaction.ts` | 会话历史压缩（上下文窗口管理） |
| `context-window-guard.ts` | 上下文窗口监控，接近限制时触发压缩 |

#### 并发控制（Lane 系统）

```
CommandLane.Main     → 主 agent 并发（默认 1）
CommandLane.Cron     → Cron 任务并发（默认 1）
CommandLane.Subagent → 子 agent 并发（可配置）
CommandLane.Nested   → 嵌套调用
```

所有 agent 调用通过 `command-queue.ts` 入队，按 Lane 限流。

---

### 3.4 路由系统（`src/routing/`）

路由解析将一条消息（channel + peer + guild + roles）映射到具体的 `(agentId, sessionKey)`。

**解析优先级**（`resolve-route.ts`）：

```
1. binding.peer          — 精确匹配 peer ID
2. binding.peer.parent   — 匹配父 peer（线程继承）
3. binding.guild+roles   — 匹配 guild + 成员角色
4. binding.guild         — 匹配 guild
5. binding.team          — 匹配 team
6. binding.account       — 匹配账户
7. binding.channel       — 匹配渠道
8. default               — 默认 agent
```

**Session Key 格式**：

```
agent-{id}:account-{acctId}:channel-{ch}:peer-{peerId}:type-{chatType}
```

主会话（DM 折叠）：`agent-{id}:main`

DM 作用域（`dmScope`）：`main` / `per-peer` / `per-channel-peer` / `per-account-channel-peer`

---

### 3.5 插件系统（`src/plugins/`）

插件是可扩展 OpenClaw 行为的 npm 包，通过 `loadOpenClawPlugins()` 在 Gateway 启动时加载（使用 `jiti` 运行时解析，支持 TypeScript 源码直接加载）。

#### 钩子点（20+）

| 钩子名 | 触发时机 |
|--------|---------|
| `gateway.start` / `gateway.stop` | Gateway 启停 |
| `before.agent.start` | Agent 执行前（可修改 system prompt、模型） |
| `before.model.resolve` | 模型解析前（可覆盖模型选择） |
| `before.prompt.build` | System prompt 构建前 |
| `before.tool.call` | 工具调用前（可拦截/修改） |
| `after.tool.call` | 工具调用后 |
| `llm.input` / `llm.output` | LLM 调用前/后 |
| `agent.end` | Agent 执行完成 |
| `before.compaction` / `after.compaction` | 会话压缩前/后 |
| `message.received` | 收到消息 |
| `message.sending` / `message.sent` | 发送消息前/后（可修改内容） |
| `session.start` / `session.end` | 会话开始/结束 |
| `subagent.spawning` / `subagent.spawned` / `subagent.ended` | 子 Agent 生命周期 |
| `tool.result.persist` | 工具结果持久化 |
| `before.message.write` | 消息写入前 |

#### 插件能力

- 注册自定义 Gateway RPC 方法（`gatewayHandlers`）
- 提供自定义 Agent 工具（`toolFactory`）
- 注册内部钩子（`internalHooks`）
- 提供 CLI 命令（`commands`）
- 提供 OAuth 认证流程（`providerAuth`）
- 注册记忆后端（`memory` 类型插件）

**Plugin SDK 公共面**：`src/plugin-sdk/index.ts`，运行时通过 jiti alias 解析 `openclaw/plugin-sdk`。

---

### 3.6 ACP 服务（`src/acp/`）

ACP（Agent Client Protocol）是 OpenClaw 与外部 AI agent 运行时（如 Pi CLI、Claude Code 等）通信的标准协议（基于 `@agentclientprotocol/sdk`）。

`src/acp/server.ts` 中的 `serveAcpGateway()` 启动一个 ACP 服务端，将 ACP 协议消息翻译为 Gateway WebSocket 调用（通过 `AcpGatewayAgent` 翻译层）。

ACP 会话与 Gateway 会话通过 `session-mapper.ts` 双向映射。

---

### 3.7 Canvas / A2UI（`src/canvas-host/`）

Canvas 是 Agent 驱动的可视化工作区，用于渲染富媒体界面（图表、交互式 UI 等）。

- `server.ts`：独立 Express + WebSocket 服务器，托管 A2UI 静态资源
- `a2ui.ts`：A2UI bundle 处理（`src/canvas-host/a2ui/`），支持 live reload
- Gateway 通过 `node.canvas.capability.refresh` RPC 方法管理 Canvas URL 授权

---

### 3.8 自动回复与消息分发（`src/auto-reply/`）

消息入站后的处理链：

```
渠道收到消息
  → allowlist 检查（src/channels/allowlists/）
  → inbound-debounce（防抖合并）
  → dispatch.ts（dispatchInboundMessage）
  → 路由解析 → 找到 agentId + sessionKey
  → 命令检测（/reset、/stop 等）
  → 入队 CommandLane
  → runEmbeddedPiAgent()
  → reply dispatcher（回复分发到渠道）
```

`src/auto-reply/reply/` 包含回复分发器，支持：
- 流式分块推送（`block-streaming`）
- 指令解析（`reply-directives`）：`@model`、`@think` 等内联指令
- Heartbeat 过滤
- 媒体附件处理

---

### 3.9 记忆系统（`src/memory/`）

向量记忆后端，支持多种存储和嵌入 provider：

**嵌入 Provider**：OpenAI、Gemini、Voyage、Mistral、HuggingFace（本地）
**向量存储**：SQLite-vec（本地）、LanceDB（`extensions/memory-lancedb`）、远程 HTTP
**检索策略**：MMR（最大边际相关性）、混合检索、时序衰减

记忆通过 `manager.ts` 统一管理，支持增量同步、原子重索引、批量嵌入。

---

### 3.10 Cron 系统（`src/cron/`）

内置定时任务调度，每个任务可绑定到特定 agent 会话：

- `service.ts`（`CronService`）：任务注册、调度、执行
- `isolated-agent.ts`：在独立 agent 上下文中运行定时任务
- 支持 webhook 回调、每日/每周/自定义 cron 表达式
- 支持 top-of-hour stagger（错峰执行）

---

### 3.11 CLI（`src/cli/` + `src/commands/`）

CLI 程序通过 `buildProgram()` 构建（`src/cli/program.ts`），使用 Commander.js。

主要命令组：

| 命令 | 说明 |
|------|------|
| `openclaw gateway run` | 启动 Gateway |
| `openclaw agent` | 直接运行 agent |
| `openclaw message send` | 发送消息到渠道 |
| `openclaw channels status` | 渠道状态 |
| `openclaw models list` | 列出可用模型 |
| `openclaw config get/set` | 配置管理 |
| `openclaw sessions list` | 会话列表 |
| `openclaw cron list/add` | 定时任务 |
| `openclaw onboard` | 交互式配置向导 |
| `openclaw doctor` | 诊断工具 |
| `openclaw skills install` | 技能安装 |
| `openclaw nodes` | 原生节点管理 |
| `openclaw browser` | 浏览器控制 |

依赖注入通过 `createDefaultDeps()`（`src/cli/deps.ts`）传递，避免全局状态。

---

## 4. 数据流：消息处理全链路

```
[外部消息平台]
      │
      ▼
[渠道适配器] (extensions/*/src/channel.ts)
  - 接收消息（polling / webhook / WebSocket）
  - 格式化为内部 ReplyPayload
      │
      ▼
[auto-reply/dispatch.ts]
  - allowlist 过滤
  - 防抖合并
  - 命令检测
      │
      ▼
[routing/resolve-route.ts]
  - 解析 agentId + sessionKey
  - 匹配 binding 规则
      │
      ▼
[process/command-queue.ts]
  - 按 CommandLane 限流入队
      │
      ▼
[agents/pi-embedded-runner/run.ts]
  - Auth Profile 选择
  - System Prompt 构建
  - 调用 Pi SDK (SessionManager)
  - 工具执行循环
      │
      ▼
[agents/pi-embedded-subscribe.ts]
  - 订阅 LLM 流式事件
  - 分块 / 过滤 / 格式化
      │
      ▼
[auto-reply/reply/reply-dispatcher.ts]
  - 分发回复到目标渠道
  - 支持多渠道同步发送
      │
      ▼
[渠道适配器 outbound]
  - 发送到外部消息平台
```

---

## 5. 配置系统（`src/config/`）

配置文件默认位于 `~/.openclaw/config.json5`（JSON5 格式）。

主要配置结构（`OpenClawConfig`）：

```typescript
{
  gateway: { port, bind, auth, tailscale, ... }
  agents: {
    list: [{ id, name, model, ... }]
    defaults: { model, thinking, heartbeat, ... }
  }
  bindings: [{ channel, peer, agent, ... }]  // 路由规则
  models: {
    providers: { [providerId]: { apiKey, baseUrl, ... } }
  }
  cron: { jobs: [...], maxConcurrentRuns }
  plugins: { [pluginId]: { enabled, config } }
  // 各渠道配置（telegram, discord, slack, ...）
}
```

配置支持：
- 热重载（`config-reload.ts`）
- 运行时快照（`runtime-overrides.ts`）
- Zod schema 校验（`zod-schema.ts`）
- 遗留配置迁移（`legacy-migrate.ts`）
- Secret 引用（`$env:VAR_NAME`、`$file:/path`）

---

## 6. 认证体系

### Gateway 认证（连接层）

| 模式 | 说明 |
|------|------|
| `none` | 仅限 loopback，无需认证 |
| `token` | Bearer token |
| `password` | HTTP Basic Auth |
| `trusted-proxy` | 信任反向代理头 |
| Tailscale | Tailscale identity 认证 |

### 角色体系

| 角色 | 权限 |
|------|------|
| `operator` | 完整操作权限（默认） |
| `node` | 原生节点权限（iOS/Android/macOS） |
| `admin` | 包含 admin scope |

### Agent 认证（LLM Provider）

`auth-profiles.ts` 管理多 API key 轮换：
- 支持多个 profile，每个 profile 对应一个 API key 或 OAuth token
- 失败后自动冷却，按 last-used 时间排序，支持 round-robin
- 支持 Anthropic、OpenAI、Gemini、GitHub Copilot、Chutes、Kilocode 等 OAuth 流程

---

## 7. 原生应用集成（`apps/`）

原生应用作为 Gateway 的**节点**（node）连接，通过 WebSocket 与 Gateway 通信：

- **macOS**（`apps/macos/`）：Swift/SwiftUI 菜单栏应用，提供 voice wake、Canvas 渲染、camera 输入
- **iOS**（`apps/ios/`）：SwiftUI 应用，提供移动端接入
- **Android**（`apps/android/`）：Kotlin 应用
- **共享库**（`apps/shared/OpenClawKit/`）：Swift Package，iOS/macOS 共用

节点通过 `node.event` RPC 方法向 Gateway 发送事件（voice transcript、exec 结果、camera 图像等），Gateway 通过 `node.invoke` 向节点下发命令。

---

## 8. 安全边界

- **工具执行策略**（`tool-policy.ts`）：控制哪些工具在哪些上下文可执行
- **沙箱隔离**（`sandbox/`）：Docker 容器隔离 bash 执行，挂载限制工作区路径
- **Exec 审批**（`exec-approval-manager.ts`）：高风险命令需用户审批
- **DM 策略**（`security/dm-policy-shared.ts`）：控制 DM 消息的允许来源
- **SSRF 防护**（`infra/net/ssrf.ts`）：阻止 webhook 请求访问内网地址
- **Origin 检查**（`gateway/origin-check.ts`）：WebSocket 连接来源校验
- **Content Security Policy**（`gateway/control-ui-csp.ts`）：Web UI 的 CSP 头

---

## 9. 扩展开发指南

### 开发渠道扩展

1. 在 `extensions/<channel-id>/` 创建 workspace package
2. 实现 `ChannelPlugin` 接口，导出为默认导出
3. 在 `src/channels/plugins/index.ts` 注册
4. 运行时依赖放 `dependencies`，`openclaw` 放 `peerDependencies`

### 开发插件

1. 创建 npm package，实现 `OpenClawPluginDefinition`
2. 导出 `default` 或 `plugin` 命名导出
3. 通过 `openclaw/plugin-sdk` 引用公共类型
4. 在配置 `plugins` 字段启用

### 关键接口文件

| 文件 | 说明 |
|------|------|
| `src/plugin-sdk/index.ts` | 插件公共 SDK |
| `src/channels/plugins/types.plugin.ts` | 渠道插件接口 |
| `src/channels/plugins/types.adapters.ts` | 渠道适配器接口 |
| `src/plugins/types.ts` | 插件定义类型 |
| `src/gateway/server-methods/types.ts` | Gateway RPC handler 类型 |

---

## 10. 关键依赖

| 依赖 | 用途 |
|------|------|
| `@mariozechner/pi-coding-agent` | Pi agent SDK（SessionManager、工具、LLM 流） |
| `@mariozechner/pi-agent-core` | Pi agent 核心类型 |
| `@mariozechner/pi-ai` | LLM 调用（streamSimple） |
| `@agentclientprotocol/sdk` | ACP 协议 SDK |
| `ws` | WebSocket 服务器 |
| `commander` | CLI 框架 |
| `jiti` | 运行时 TypeScript 加载（插件） |
| `zod` | 配置 schema 校验 |
| `chokidar` | 文件系统监听（Canvas live reload） |
| `vitest` | 测试框架 |
