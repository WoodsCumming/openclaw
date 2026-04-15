# Gateway 模块架构文档

> 文件路径：`src/gateway/`
> 本文档描述 OpenClaw Gateway 的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

Gateway 是 OpenClaw 的**神经中枢**，以 WebSocket 服务器（默认 `ws://127.0.0.1:18789`）形式运行。它接受来自 Web UI、原生 App（macOS/iOS/Android）和 CLI 客户端的连接，并将 RPC 消息路由到对应处理器，同时向所有客户端广播系统事件。

---

## 2. 目录结构

```
src/gateway/
├── server.impl.ts           # 主服务实现（startGatewayServer 入口）
├── server.ts                # 服务导出
├── boot.ts                  # 启动流程编排
├── server-http.ts           # HTTP 服务器（OpenAI 兼容、Webhook、静态资源）
├── server-ws-runtime.ts     # WebSocket 运行时（连接处理入口）
├── server-methods.ts        # RPC 方法路由与权限验证
├── server-methods/          # 各 RPC 方法处理器（agent、chat、cron、config 等）
├── server-broadcast.ts      # 事件广播系统
├── server-channels.ts       # 渠道运行时管理（启动/停止/重试）
├── server-lanes.ts          # 并发控制（Lane 系统）
├── server-cron.ts           # 内置 Cron 服务
├── server-plugins.ts        # 插件加载
├── auth.ts                  # 认证核心逻辑
├── auth-rate-limit.ts       # 速率限制（防暴力破解）
├── credentials.ts           # 凭证管理
├── config-reload.ts         # 配置热重载
├── origin-check.ts          # WebSocket 来源校验
├── control-ui-csp.ts        # Web UI Content Security Policy
├── exec-approval-manager.ts # 高风险命令审批
├── openai-http.ts           # OpenAI 兼容 HTTP 接口
├── openresponses-http.ts    # OpenResponses 接口
├── node-registry.ts         # 原生节点注册表
├── server/
│   ├── ws-connection.ts     # WebSocket 连接处理
│   ├── ws-types.ts          # WS 客户端类型定义
│   ├── health-state.ts      # 健康状态追踪
│   └── presence-events.ts   # 在线状态事件
└── protocol/                # 协议类型与 schema 定义
```

---

## 3. 核心组件

### 3.1 认证系统（`auth.ts`）

认证支持四种模式，通过 `ResolvedGatewayAuth` 结构描述当前模式：

```typescript
// src/gateway/auth.ts:22-37
export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
export type ResolvedGatewayAuthModeSource =
  | "override"
  | "config"
  | "password"
  | "token"
  | "default";

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};
```

认证结果类型，包含认证方法、用户信息和速率限制状态：

```typescript
// src/gateway/auth.ts:39-48
export type GatewayAuthResult = {
  ok: boolean;
  method?: "none" | "token" | "password" | "tailscale" | "device-token" | "trusted-proxy";
  user?: string;
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};
```

认证参数，支持 Tailscale 白名单身份、速率限制和可信代理：

```typescript
// src/gateway/auth.ts:57-76
export type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
  /**
   * Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled.
   * WS Control UI enables it intentionally for tokenless trusted-host login.
   */
  authSurface?: GatewayAuthSurface;
  /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
  rateLimiter?: AuthRateLimiter;
  /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
  clientIp?: string;
  /** Optional limiter scope; defaults to shared-secret auth scope. */
  rateLimitScope?: string;
  /** Trust X-Real-IP only when explicitly enabled. */
  allowRealIpFallback?: boolean;
};
```

**认证模式说明：**

| 模式 | 说明 |
|------|------|
| `none` | 仅限 loopback，无需认证 |
| `token` | Bearer token 验证 |
| `password` | HTTP Basic Auth |
| `trusted-proxy` | 信任反向代理 X-Forwarded-For 头 |
| Tailscale | 通过 `tailscaleWhois` 解析 Tailscale 身份 |

---

### 3.2 事件广播系统（`server-broadcast.ts`）

广播系统将事件推送给所有连接的 WebSocket 客户端，支持作用域权限控制：

```typescript
// src/gateway/server-broadcast.ts:5-16
const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

// 敏感事件需要特定 scope 才能接收
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};
```

广播选项类型，支持慢客户端丢包和状态版本号：

```typescript
// src/gateway/server-broadcast.ts:18-32
export type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;        // 慢速客户端（缓冲区满）时丢弃该帧
  stateVersion?: GatewayBroadcastStateVersion;  // 附带状态版本号，客户端用于去重
};

export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;
```

广播内部实现：序列号递增、JSON 序列化、慢客户端检测：

```typescript
// src/gateway/server-broadcast.ts:57-77
export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ) => {
    if (params.clients.size === 0) {
      return;
    }
    const isTargeted = Boolean(targetConnIds);
    const eventSeq = isTargeted ? undefined : ++seq;  // 定向广播不递增全局序列号
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    // ...（遍历客户端，检查 scope 权限，检查缓冲区大小）
  };
```

---

### 3.3 并发控制（`server-lanes.ts`）

通过 `CommandLane` 枚举将 agent 执行分为不同优先级队列：

```typescript
// src/gateway/server-lanes.ts:1-10
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

// 从配置中读取并发数，应用到各 Lane
export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
```

**Lane 类型说明：**

| Lane | 说明 | 默认并发 |
|------|------|---------|
| `CommandLane.Main` | 主 agent 执行队列 | 1 |
| `CommandLane.Cron` | Cron 定时任务队列 | 1（可配置） |
| `CommandLane.Subagent` | 子 agent 并发队列 | 可配置 |
| `CommandLane.Nested` | 嵌套调用队列 | — |

---

### 3.4 渠道管理（`server-channels.ts`）

渠道管理器负责渠道的启动、停止和带指数退避的重启：

```typescript
// src/gateway/server-channels.ts:12-18
const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,       // 初始重试间隔 5 秒
  maxMs: 5 * 60_000,      // 最大重试间隔 5 分钟
  factor: 2,              // 指数退避因子
  jitter: 0.1,            // 10% 随机抖动，防止惊群
};
const MAX_RESTART_ATTEMPTS = 10;  // 最多重试 10 次
```

渠道运行时快照，记录每个渠道的当前账户状态：

```typescript
// src/gateway/server-channels.ts:20-23
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
```

渠道管理器接口，提供完整的渠道生命周期管理：

```typescript
// src/gateway/server-channels.ts:69-77
export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;        // 启动所有已配置渠道
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
};
```

---

### 3.5 RPC 方法系统（`server-methods.ts`）

Gateway 支持 70+ 个 RPC 方法，按功能分组：

| 方法组 | 示例方法 | 说明 |
|--------|---------|------|
| `chat.*` | `chat.send`, `chat.history` | 消息发送和历史 |
| `sessions.*` | `sessions.list`, `sessions.resolve` | 会话管理 |
| `agents.*` | `agents.list`, `agents.run` | Agent 管理 |
| `cron.*` | `cron.list`, `cron.add` | 定时任务 |
| `node.*` | `node.event`, `node.invoke` | 原生节点通信 |
| `config.*` | `config.get`, `config.apply` | 配置管理 |
| `skills.*` | `skills.list`, `skills.install` | 技能管理 |
| `channels.*` | `channels.status`, `channels.start` | 渠道管理 |

---

## 4. 启动流程

Gateway 启动流程（`server.impl.ts` → `startGatewayServer`）：

```
1. 加载配置（loadConfig）+ 迁移旧配置（legacy-migrate）
2. 加载插件注册表（loadOpenClawPlugins）
3. 启动 sidecars：
   - browser control（浏览器控制服务）
   - Gmail watcher（Gmail 监听）
   - internal hooks（内部钩子）
4. 初始化渠道管理器（createChannelManager）
5. 启动各渠道运行时（startChannels）
6. 绑定 WebSocket 处理器（attachGatewayWsHandlers）
7. 绑定 HTTP 处理器（server-http.ts）
8. 启动 Cron 服务（server-cron.ts）
9. 启动 Bonjour 服务发现
10. 启动 Tailscale 暴露（可选）
11. 启动心跳和维护定时器
```

---

## 5. 角色体系

WebSocket 连接按 `role` 授权：

| 角色 | 权限 |
|------|------|
| `operator` | 完整操作权限（默认） |
| `node` | 原生节点权限（iOS/Android/macOS） |
| `admin` | 包含 `operator.admin` scope |

---

## 6. 关键接口文件

| 文件 | 说明 |
|------|------|
| `src/gateway/server-methods/types.ts` | RPC handler 类型定义 |
| `src/gateway/server/ws-types.ts` | WebSocket 客户端类型 |
| `src/gateway/protocol/index.ts` | 协议错误码和帧结构 |
| `src/gateway/auth.ts` | 认证类型和逻辑 |
| `src/gateway/server-broadcast.ts` | 广播函数类型 |

---

## 7. 安全边界

- **`origin-check.ts`**：校验 WebSocket 连接来源，防止 CSRF
- **`control-ui-csp.ts`**：为 Web UI 设置 Content Security Policy 头
- **`auth-rate-limit.ts`**：防暴力破解速率限制（按 IP 追踪失败次数）
- **`exec-approval-manager.ts`**：高风险命令（bash 执行等）需用户审批
- **`server-methods.ts`**：每个 RPC 方法调用前检查角色和 scope 权限
