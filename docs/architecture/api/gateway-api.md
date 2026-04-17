# Gateway 模块 API 参考

> 源码路径：`src/gateway/`
> 本文档由源码 TSDoc 注释整理，标注对应源码行号。

## 目录

- [server-methods.ts — RPC 方法分发](#server-methodsts--rpc-方法分发)
  - [常量](#常量)
    - [CONTROL_PLANE_WRITE_METHODS](#control_plane_write_methods)
  - [Export 常量](#export-常量)
    - [coreGatewayHandlers](#coregatewayhandlers)
  - [内部函数](#内部函数)
    - [authorizeGatewayMethod](#authorizegatewaymethod)
  - [Export 函数](#export-函数-server-methods)
    - [handleGatewayRequest](#handlegatewayrequest)
- [server-broadcast.ts — 事件广播](#server-broadcastts--事件广播)
  - [类型定义](#类型定义-server-broadcast)
    - [GatewayBroadcastStateVersion](#gatewaybroadcaststateversion)
    - [GatewayBroadcastOpts](#gatewaybroadcastopts)
    - [GatewayBroadcastFn](#gatewaybroadcastfn)
    - [GatewayBroadcastToConnIdsFn](#gatewaybroadcasttoconnidsfn)
  - [内部常量](#内部常量-server-broadcast)
    - [ADMIN_SCOPE / APPROVALS_SCOPE / PAIRING_SCOPE](#admin_scope--approvals_scope--pairing_scope)
    - [EVENT_SCOPE_GUARDS](#event_scope_guards)
  - [内部函数](#内部函数-server-broadcast)
    - [hasEventScope](#haseventscope)
    - [broadcastInternal](#broadcastinternal)
  - [Export 函数](#export-函数-server-broadcast)
    - [createGatewayBroadcaster](#creategatewaybroadcaster)
- [server-channels.ts — 渠道生命周期管理](#server-channelsts--渠道生命周期管理)
  - [常量](#常量-server-channels)
    - [CHANNEL_RESTART_POLICY](#channel_restart_policy)
    - [MAX_RESTART_ATTEMPTS](#max_restart_attempts)
  - [类型定义](#类型定义-server-channels)
    - [ChannelRuntimeSnapshot](#channelruntimesnapshot)
    - [ChannelRuntimeStore](#channelruntimestore)
    - [ChannelManagerOptions](#channelmanageroptions)
    - [StartChannelOptions](#startchanneloptions)
    - [ChannelManager](#channelmanager)
  - [内部函数](#内部函数-server-channels)
    - [createRuntimeStore](#createruntimestore)
    - [isAccountEnabled](#isaccountenabled)
    - [resolveDefaultRuntime](#resolvedefaultruntime)
    - [cloneDefaultRuntime](#clonedefaultruntime)
    - [startChannelInternal](#startchannel-internal)
  - [Export 函数](#export-函数-server-channels)
    - [createChannelManager](#createchannelmanager)
      - [getRuntimeSnapshot](#getruntimesnapshot)
      - [startChannels](#startchannels)
      - [startChannel](#startchannel)
      - [stopChannel](#stopchannel)
      - [markChannelLoggedOut](#markchannelloggedout)
      - [isManuallyStopped](#ismanuallystopped)
      - [resetRestartAttempts](#resetrestartattempts)
- [auth.ts — Gateway 认证](#authts--gateway-认证)
  - [类型定义](#类型定义-auth)
    - [ResolvedGatewayAuthMode](#resolvedgatewayauthmode)
    - [ResolvedGatewayAuthModeSource](#resolvedgatewayauthmodesource)
    - [ResolvedGatewayAuth](#resolvedgatewayauth)
    - [GatewayAuthResult](#gatewayauthresult)
    - [GatewayAuthSurface](#gatewayauthsurface)
    - [AuthorizeGatewayConnectParams](#authorizegatewayconnectparams)
  - [内部函数](#内部函数-auth)
    - [normalizeLogin](#normalizelogin)
    - [headerValue](#headervalue)
    - [resolveTailscaleClientIp](#resolvetailscaleclientip)
    - [resolveRequestClientIp](#resolverequestclientip)
    - [getTailscaleUser](#gettailscaleuser)
    - [hasTailscaleProxyHeaders](#hastailscaleproxyheaders)
    - [isTailscaleProxyRequest](#istailscaleproxyrequest)
    - [resolveVerifiedTailscaleUser](#reverseverifiedtailscaleuser)
    - [authorizeTrustedProxy](#authorizetrustedproxy)
    - [shouldAllowTailscaleHeaderAuth](#shouldallowtailscaleheaderauth)
  - [Export 函数](#export-函数-auth)
    - [isLocalDirectRequest](#islocaldirectrequest)
    - [resolveGatewayAuth](#resolvegatewayauth)
    - [assertGatewayAuthConfigured](#assertgatewayauthconfigured)
    - [authorizeGatewayConnect](#authorizegatewayconnect)
    - [authorizeHttpGatewayConnect](#authorizehttpgatewayconnect)
    - [authorizeWsControlUiGatewayConnect](#authorizewscontroluigatewayconnect)

---

## server-methods.ts — RPC 方法分发

> 源码：`src/gateway/server-methods.ts`

该文件是 Gateway WebSocket RPC 系统的核心入口，负责汇聚所有子模块处理器、校验调用权限、执行速率限制并将请求路由到对应处理函数。

---

### 常量

#### `CONTROL_PLANE_WRITE_METHODS`

- **位置**：`src/gateway/server-methods.ts:37`
- **类型**：`Set<string>`（内部常量，未 export）
- **值**：`new Set(["config.apply", "config.patch", "update.run"])`
- **说明**：需要控制平面写入预算的方法集合。这些方法会修改全局配置，限速为每 60 秒最多 3 次，防止配置被频繁覆盖。超出配额时，`handleGatewayRequest` 会返回 `UNAVAILABLE` 错误并附带 `retryAfterMs`。

---

### Export 常量

#### `coreGatewayHandlers`

- **位置**：`src/gateway/server-methods.ts:87`
- **类型**：`GatewayRequestHandlers`
- **说明**：核心 Gateway RPC 处理器注册表，将所有子模块的处理器合并为一个扁平映射，供 `handleGatewayRequest` 按方法名查找。插件可通过 `extraHandlers` 参数注入自定义方法，优先级高于核心处理器。

  包含以下子模块处理器（按注册顺序）：

  | 子模块 | 模块文件 |
  |---|---|
  | `connectHandlers` | `server-methods/connect.js` |
  | `logsHandlers` | `server-methods/logs.js` |
  | `voicewakeHandlers` | `server-methods/voicewake.js` |
  | `healthHandlers` | `server-methods/health.js` |
  | `channelsHandlers` | `server-methods/channels.js` |
  | `chatHandlers` | `server-methods/chat.js` |
  | `cronHandlers` | `server-methods/cron.js` |
  | `deviceHandlers` | `server-methods/devices.js` |
  | `doctorHandlers` | `server-methods/doctor.js` |
  | `execApprovalsHandlers` | `server-methods/exec-approvals.js` |
  | `webHandlers` | `server-methods/web.js` |
  | `modelsHandlers` | `server-methods/models.js` |
  | `configHandlers` | `server-methods/config.js` |
  | `wizardHandlers` | `server-methods/wizard.js` |
  | `talkHandlers` | `server-methods/talk.js` |
  | `toolsCatalogHandlers` | `server-methods/tools-catalog.js` |
  | `ttsHandlers` | `server-methods/tts.js` |
  | `skillsHandlers` | `server-methods/skills.js` |
  | `sessionsHandlers` | `server-methods/sessions.js` |
  | `systemHandlers` | `server-methods/system.js` |
  | `updateHandlers` | `server-methods/update.js` |
  | `nodeHandlers` | `server-methods/nodes.js` |
  | `pushHandlers` | `server-methods/push.js` |
  | `sendHandlers` | `server-methods/send.js` |
  | `usageHandlers` | `server-methods/usage.js` |
  | `agentHandlers` | `server-methods/agent.js` |
  | `agentsHandlers` | `server-methods/agents.js` |
  | `browserHandlers` | `server-methods/browser.js` |

---

### 内部函数

#### `authorizeGatewayMethod`

- **位置**：`src/gateway/server-methods.ts:51`
- **标注**：[内部]
- **签名**：
  ```ts
  function authorizeGatewayMethod(
    method: string,
    client: GatewayRequestOptions["client"]
  ): ErrorShape | null
  ```
- **说明**：校验 Gateway RPC 方法调用的权限。按以下顺序检查：
  1. 连接是否已建立（`client.connect` 存在），若未建立则直接放行（`null`）
  2. `health` 方法无需授权，直接放行
  3. 解析并验证 role（`operator` / `node` / `admin`）；role 无效返回错误
  4. operator role 还需检查 scopes；持有 `operator.admin` scope 可跳过具体 scope 检查
- **参数**：
  - `method` — RPC 方法名，如 `"chat.send"`、`"config.apply"`
  - `client` — 发起请求的 WebSocket 客户端信息，含 `connect.role`、`connect.scopes`
- **返回**：授权失败时返回错误 `ErrorShape`，授权通过返回 `null`

---

### Export 函数 {#export-函数-server-methods}

#### `handleGatewayRequest`

- **位置**：`src/gateway/server-methods.ts:130`
- **签名**：
  ```ts
  export async function handleGatewayRequest(
    opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers }
  ): Promise<void>
  ```
- **说明**：Gateway WebSocket RPC 请求的统一入口分发器。所有来自 WebSocket 客户端的 RPC 调用都经由此函数处理。

  执行流程：
  1. 调用 `authorizeGatewayMethod` 检查角色和 scope 权限，失败则立即返回错误
  2. 对控制平面写入方法（`CONTROL_PLANE_WRITE_METHODS`）检查速率限制预算（每 60 秒 3 次）
  3. 若速率受限，记录 warn 日志并返回 `UNAVAILABLE` 错误，附带 `retryAfterMs` 和 `limit` 详情
  4. 从 `opts.extraHandlers`（优先）或 `coreGatewayHandlers` 中查找对应处理器
  5. 调用处理器并传入完整请求上下文（`req`, `params`, `client`, `isWebchatConnect`, `respond`, `context`）

- **参数**（`opts` 字段）：
  - `req` — RPC 请求体，含 `method` 和 `params`
  - `respond` — 回复函数，签名 `(ok: boolean, result?: unknown, error?: ErrorShape) => void`
  - `client` — WebSocket 客户端连接信息
  - `isWebchatConnect` — 是否为 webchat 连接
  - `context` — Gateway 运行时上下文，含日志、配置等
  - `extraHandlers?` — 插件注入的额外处理器，优先级高于 `coreGatewayHandlers`
- **返回**：`Promise<void>`，回复通过 `respond` 回调传递
- **备注**：若方法未注册，返回 `INVALID_REQUEST` 错误而非抛出异常

---

## server-broadcast.ts — 事件广播

> 源码：`src/gateway/server-broadcast.ts`

该文件实现 Gateway 的事件广播机制，向已连接的 WebSocket 客户端推送服务端事件，并提供基于 scope 的事件过滤和慢消费者保护。

---

### 类型定义 {#类型定义-server-broadcast}

#### `GatewayBroadcastStateVersion`

- **位置**：`src/gateway/server-broadcast.ts:27`
- **说明**：广播事件携带的状态版本号，用于客户端去重和增量更新。版本号递增表示对应状态有更新，客户端可据此决定是否重新拉取完整状态。

  ```ts
  export type GatewayBroadcastStateVersion = {
    presence?: number;  // presence（在线状态）版本号
    health?: number;    // health（健康状态）版本号
  };
  ```

#### `GatewayBroadcastOpts`

- **位置**：`src/gateway/server-broadcast.ts:37`
- **说明**：Gateway 事件广播选项，控制慢消费者行为和状态版本附加。

  ```ts
  export type GatewayBroadcastOpts = {
    dropIfSlow?: boolean;                   // 若客户端缓冲区已满（慢消费者），丢弃此帧而非关闭连接
    stateVersion?: GatewayBroadcastStateVersion;  // 附带的状态版本号
  };
  ```

  - `dropIfSlow`：默认 `false`（关闭慢消费者连接，code 1008），设为 `true` 时静默跳过缓冲区满的客户端
  - `stateVersion`：附加到帧中，客户端收到后可判断是否需要重新拉取状态

#### `GatewayBroadcastFn`

- **位置**：`src/gateway/server-broadcast.ts:42`
- **说明**：全量广播函数类型签名。向所有已连接客户端广播事件。

  ```ts
  export type GatewayBroadcastFn = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
  ) => void;
  ```

#### `GatewayBroadcastToConnIdsFn`

- **位置**：`src/gateway/server-broadcast.ts:48`
- **说明**：定向广播函数类型签名。仅向指定 `connId` 集合广播事件。

  ```ts
  export type GatewayBroadcastToConnIdsFn = (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: GatewayBroadcastOpts,
  ) => void;
  ```

---

### 内部常量 {#内部常量-server-broadcast}

#### `ADMIN_SCOPE` / `APPROVALS_SCOPE` / `PAIRING_SCOPE`

- **位置**：`src/gateway/server-broadcast.ts:5-7`
- **标注**：[内部]
- **类型**：`string`（字面量常量）
- **值**：
  - `ADMIN_SCOPE = "operator.admin"` — 管理员全权 scope
  - `APPROVALS_SCOPE = "operator.approvals"` — 执行审批 scope
  - `PAIRING_SCOPE = "operator.pairing"` — 设备配对 scope

#### `EVENT_SCOPE_GUARDS`

- **位置**：`src/gateway/server-broadcast.ts:14`
- **标注**：[内部]
- **类型**：`Record<string, string[]>`
- **说明**：敏感事件的 scope 守卫映射。只有持有对应 scope 的 operator 才能接收这些事件推送。未在此表中注册的事件对所有客户端开放。

  | 事件名 | 所需 scope |
  |---|---|
  | `exec.approval.requested` | `operator.approvals` |
  | `exec.approval.resolved` | `operator.approvals` |
  | `device.pair.requested` | `operator.pairing` |
  | `device.pair.resolved` | `operator.pairing` |
  | `node.pair.requested` | `operator.pairing` |
  | `node.pair.resolved` | `operator.pairing` |

---

### 内部函数 {#内部函数-server-broadcast}

#### `hasEventScope`

- **位置**：`src/gateway/server-broadcast.ts:68`
- **标注**：[内部]
- **签名**：
  ```ts
  function hasEventScope(client: GatewayWsClient, event: string): boolean
  ```
- **说明**：检查客户端是否有权限接收指定事件。

  逻辑：
  - 事件未在 `EVENT_SCOPE_GUARDS` 中注册 → 所有客户端均可接收（返回 `true`）
  - `node` role → 无法接收受保护事件（返回 `false`）
  - 持有 `operator.admin` scope → 可接收所有受保护事件
  - 其他 operator → 需持有事件对应的具体 scope

- **参数**：
  - `client` — WebSocket 客户端，含 `connect.role` 和 `connect.scopes`
  - `event` — 事件名称
- **返回**：客户端有权接收该事件时返回 `true`

#### `broadcastInternal`

- **位置**：`src/gateway/server-broadcast.ts:101`（`createGatewayBroadcaster` 内部闭包）
- **标注**：[内部]
- **签名**：
  ```ts
  function broadcastInternal(
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ): void
  ```
- **说明**：实际执行广播逻辑的内部函数，被 `broadcast` 和 `broadcastToConnIds` 共用。

  关键行为：
  - 全量广播（`targetConnIds` 为 `undefined`）时递增全局序列号 `seq`，定向广播时不递增
  - 序列化 frame：`{type: "event", event, payload, seq, stateVersion}`
  - 若启用了 `ws-log`，记录广播元信息（含 `summarizeAgentEventForWsLog` 对 agent 事件的摘要）
  - 对每个客户端：过滤目标集合 → 检查 scope → 检查缓冲区（慢消费者处理）→ 发送

---

### Export 函数 {#export-函数-server-broadcast}

#### `createGatewayBroadcaster`

- **位置**：`src/gateway/server-broadcast.ts:98`
- **签名**：
  ```ts
  export function createGatewayBroadcaster(params: {
    clients: Set<GatewayWsClient>;
  }): {
    broadcast: GatewayBroadcastFn;
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  }
  ```
- **说明**：创建 Gateway 事件广播器工厂，返回两个广播函数的对象。

  返回值说明：
  - `broadcast(event, payload, opts?)` — 向所有连接客户端广播，按 scope 过滤，附带全局递增序列号；若 `clients` 为空立即返回
  - `broadcastToConnIds(event, payload, connIds, opts?)` — 仅向 `connIds` 集合中的客户端广播，不递增全局序列号；若 `connIds` 为空立即返回

  慢消费者策略（`socket.bufferedAmount > MAX_BUFFERED_BYTES`）：
  - `dropIfSlow=true`：静默跳过，不发送也不关闭
  - `dropIfSlow=false`（默认）：调用 `socket.close(1008, "slow consumer")` 关闭连接

- **参数**：
  - `params.clients` — 当前所有活跃 WebSocket 客户端集合（引用，实时读取）
- **返回**：`{ broadcast, broadcastToConnIds }` 对象

---

## server-channels.ts — 渠道生命周期管理

> 源码：`src/gateway/server-channels.ts`

该文件实现渠道（channel）生命周期管理器，控制所有渠道账户的启动、停止、自动重启和运行时状态追踪。

---

### 常量 {#常量-server-channels}

#### `CHANNEL_RESTART_POLICY`

- **位置**：`src/gateway/server-channels.ts:16`
- **标注**：[内部]
- **类型**：`BackoffPolicy`
- **值**：`{ initialMs: 5_000, maxMs: 5 * 60_000, factor: 2, jitter: 0.1 }`
- **说明**：渠道崩溃后的指数退避重启策略。初始等待 5 秒，每次翻倍，最长等待 5 分钟，附加 10% 随机抖动防止惊群效应（thundering herd）。

#### `MAX_RESTART_ATTEMPTS`

- **位置**：`src/gateway/server-channels.ts:23`
- **标注**：[内部]
- **类型**：`number`
- **值**：`10`
- **说明**：渠道自动重启的最大尝试次数。超过此次数后停止重启并记录 error 日志，防止无限重试消耗资源。

---

### 类型定义 {#类型定义-server-channels}

#### `ChannelRuntimeSnapshot`

- **位置**：`src/gateway/server-channels.ts:25`
- **说明**：渠道运行时快照，描述所有渠道账户的当前状态。由 `getRuntimeSnapshot()` 返回，供 Gateway health/status 接口使用。

  ```ts
  export type ChannelRuntimeSnapshot = {
    channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;        // 每个渠道的默认账户快照
    channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;  // 每个渠道的所有账户快照
  };
  ```

  - `channels`：以渠道 ID 为键，值为该渠道默认账户的快照
  - `channelAccounts`：以渠道 ID 为键，值为该渠道所有账户 ID 到快照的映射

#### `ChannelRuntimeStore`

- **位置**：`src/gateway/server-channels.ts:32`
- **标注**：[内部]
- **说明**：单个渠道的运行时存储结构，追踪该渠道所有账户的 abort 控制器、运行 task 和快照。

  ```ts
  type ChannelRuntimeStore = {
    aborts: Map<string, AbortController>;          // accountId → AbortController
    tasks: Map<string, Promise<unknown>>;           // accountId → 运行中的 Promise
    runtimes: Map<string, ChannelAccountSnapshot>; // accountId → 当前快照
  };
  ```

#### `ChannelManagerOptions`

- **位置**：`src/gateway/server-channels.ts:80`
- **标注**：[内部]
- **说明**：`createChannelManager` 的构造参数。

  ```ts
  type ChannelManagerOptions = {
    loadConfig: () => OpenClawConfig;                       // 动态加载最新配置
    channelLogs: Record<ChannelId, SubsystemLogger>;        // 各渠道子系统日志
    channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;     // 各渠道运行时环境
  };
  ```

#### `StartChannelOptions`

- **位置**：`src/gateway/server-channels.ts:86`
- **标注**：[内部]
- **说明**：`startChannelInternal` 的选项，控制重启行为。

  ```ts
  type StartChannelOptions = {
    preserveRestartAttempts?: boolean;  // 是否保留已有重启计数（重启时为 true）
    preserveManualStop?: boolean;       // 是否保留手动停止标记（重启时为 true）
  };
  ```

#### `ChannelManager`

- **位置**：`src/gateway/server-channels.ts:91`
- **说明**：`createChannelManager` 返回的渠道管理器接口。

  ```ts
  export type ChannelManager = {
    getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
    startChannels: () => Promise<void>;
    startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
    stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
    markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
    isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
    resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  };
  ```

---

### 内部函数 {#内部函数-server-channels}

#### `createRuntimeStore`

- **位置**：`src/gateway/server-channels.ts:45`
- **标注**：[内部]
- **签名**：`function createRuntimeStore(): ChannelRuntimeStore`
- **说明**：创建空的渠道运行时存储。初始化三个空 Map：`aborts`、`tasks`、`runtimes`。每个渠道在首次访问时调用此函数初始化独立存储。

#### `isAccountEnabled`

- **位置**：`src/gateway/server-channels.ts:59`
- **标注**：[内部]
- **签名**：`function isAccountEnabled(account: unknown): boolean`
- **说明**：判断账户配置是否处于启用状态。若账户对象不存在、非对象类型，或未设置 `enabled` 字段，默认视为启用（`true`）。仅当 `enabled === false` 时返回 `false`。

#### `resolveDefaultRuntime`

- **位置**：`src/gateway/server-channels.ts:71`
- **标注**：[内部]
- **签名**：`function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot`
- **说明**：获取渠道的默认运行时快照，用于初始化尚未运行的账户状态。优先使用插件定义的 `plugin.status.defaultRuntime`，回退到仅含 `{ accountId: DEFAULT_ACCOUNT_ID }` 的最小快照。

#### `cloneDefaultRuntime`

- **位置**：`src/gateway/server-channels.ts:76`
- **标注**：[内部]
- **签名**：`function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot`
- **说明**：克隆默认运行时快照并覆盖 `accountId`，用于为特定账户创建独立的初始快照（避免多账户共享同一对象引用）。

#### `startChannelInternal` {#startchannel-internal}

- **位置**：`src/gateway/server-channels.ts:156`
- **标注**：[内部]
- **签名**：
  ```ts
  async function startChannelInternal(
    channelId: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ): Promise<void>
  ```
- **说明**：启动渠道账户的核心内部实现。

  执行逻辑：
  1. 获取插件的 `startAccount` 钩子，若无钩子直接返回
  2. 加载最新配置，重置目录缓存
  3. 解析目标账户 ID 列表（指定 `accountId` 时只处理该账户）
  4. 对每个账户（并发）：
     - 若已在运行（`store.tasks.has(id)`），跳过
     - 检查 `enabled` 状态，未启用则设置 disabled 快照并跳过
     - 检查 `configured` 状态，未配置则设置 unconfigured 快照并跳过
     - 创建 `AbortController`，更新快照为 running 状态
     - 调用 `plugin.gateway.startAccount(...)` 并追踪 Promise
  5. Promise settled 后自动重启（按 `CHANNEL_RESTART_POLICY` 退避，最多 `MAX_RESTART_ATTEMPTS` 次）
  6. 若在 `manuallyStopped` 集合中，不重启

---

### Export 函数 {#export-函数-server-channels}

#### `createChannelManager`

- **位置**：`src/gateway/server-channels.ts:118`
- **签名**：
  ```ts
  export function createChannelManager(opts: ChannelManagerOptions): ChannelManager
  ```
- **说明**：创建渠道生命周期管理器，是 Gateway 中渠道运行时的唯一控制点。管理所有渠道账户的启动、停止和自动重启。

  内部状态：
  - `channelStores: Map<ChannelId, ChannelRuntimeStore>` — 按渠道存储运行时数据
  - `restartAttempts: Map<string, number>` — 按 `channelId:accountId` 追踪重启次数，成功后重置
  - `manuallyStopped: Set<string>` — 手动停止的账户集合，防止自动重启

  返回以下方法（均为 `ChannelManager` 接口成员）：

##### `getRuntimeSnapshot`

- **位置**：`src/gateway/server-channels.ts:424`
- **签名**：`getRuntimeSnapshot(): ChannelRuntimeSnapshot`
- **说明**：获取所有渠道账户的当前运行时快照。遍历所有已注册渠道插件，合并持久化的 `runtimes` 状态与插件的 `describeAccount` 描述，并应用 `enabled`/`configured` 逻辑填充缺省的 `lastError`。返回按渠道 ID 索引的 `{ channels, channelAccounts }` 对象。

##### `startChannels`

- **位置**：`src/gateway/server-channels.ts:381`
- **签名**：`startChannels(): Promise<void>`
- **说明**：按注册顺序依次启动所有已注册渠道插件的账户。Gateway 初始化时调用。顺序执行（非并发），避免渠道间资源竞争。

##### `startChannel`

- **位置**：`src/gateway/server-channels.ts:310`
- **签名**：`startChannel(channelId: ChannelId, accountId?: string): Promise<void>`
- **说明**：启动指定渠道的一个或所有账户。若账户已在运行中（`tasks` Map 存在对应项），跳过不重复启动。`accountId` 为空时启动该渠道所有账户。

##### `stopChannel`

- **位置**：`src/gateway/server-channels.ts:321`
- **签名**：`stopChannel(channelId: ChannelId, accountId?: string): Promise<void>`
- **说明**：停止指定渠道的一个或所有账户。将账户加入 `manuallyStopped` 集合（阻止自动重启），依次触发 `AbortController.abort()`、调用 `plugin.gateway.stopAccount`（如有），最后等待运行 task 完成。提供快速路径：若无 `stopAccount` 钩子且无运行中的 abort/task，直接返回。

##### `markChannelLoggedOut`

- **位置**：`src/gateway/server-channels.ts:394`
- **签名**：`markChannelLoggedOut(channelId: ChannelId, cleared: boolean, accountId?: string): void`
- **说明**：标记渠道账户已登出（会话失效）。更新运行时快照：`running=false`，若原快照有 `connected` 字段则置为 `false`。`cleared=true` 时将 `lastError` 设为 `"logged out"`；否则保留原有错误信息。`accountId` 为空时使用渠道默认账户。

##### `isManuallyStopped`

- **位置**：`src/gateway/server-channels.ts:465`
- **签名**：`isManuallyStopped(channelId: ChannelId, accountId: string): boolean`
- **说明**：查询指定渠道账户是否处于手动停止状态（在 `manuallyStopped` 集合中）。手动停止的账户不会触发自动重启。

##### `resetRestartAttempts`

- **位置**：`src/gateway/server-channels.ts:469`
- **签名**：`resetRestartAttempts(channelId: ChannelId, accountId: string): void`
- **说明**：重置指定渠道账户的重启计数。从 `restartAttempts` Map 中删除对应键，使下次崩溃重启时从第 1 次开始计数（享有完整的 `MAX_RESTART_ATTEMPTS` 配额）。通常在外部重新配置后调用。

---

## auth.ts — Gateway 认证

> 源码：`src/gateway/auth.ts`

该文件实现 Gateway WebSocket/HTTP 连接的认证逻辑，支持 token、password、Tailscale、trusted-proxy 四种认证模式，以及速率限制保护。

---

### 类型定义 {#类型定义-auth}

#### `ResolvedGatewayAuthMode`

- **位置**：`src/gateway/auth.ts:22`
- **说明**：Gateway 生效的认证模式枚举。

  ```ts
  export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
  ```

  | 值 | 说明 |
  |---|---|
  | `"none"` | 无需认证，直接放行所有连接 |
  | `"token"` | Bearer token 认证（默认模式） |
  | `"password"` | 密码认证 |
  | `"trusted-proxy"` | 信任代理认证，从指定 header 提取用户名 |

#### `ResolvedGatewayAuthModeSource`

- **位置**：`src/gateway/auth.ts:23`
- **说明**：认证模式来源，用于调试日志（优先级由高到低）。

  ```ts
  export type ResolvedGatewayAuthModeSource =
    | "override"    // 运行时覆盖（CLI 参数）
    | "config"      // 配置文件显式指定
    | "password"    // 由 password 凭据推断
    | "token"       // 由 token 凭据推断
    | "default";    // 默认值（无凭据时）
  ```

#### `ResolvedGatewayAuth`

- **位置**：`src/gateway/auth.ts:37`
- **说明**：Gateway 认证解析结果，描述当前生效的认证模式和凭据。由 `resolveGatewayAuth` 计算得出，传入 `authorizeGatewayConnect` 使用。

  ```ts
  export type ResolvedGatewayAuth = {
    mode: ResolvedGatewayAuthMode;            // 当前认证模式
    modeSource?: ResolvedGatewayAuthModeSource; // 模式来源（调试用）
    token?: string;                           // token 凭据
    password?: string;                        // password 凭据
    allowTailscale: boolean;                  // 是否允许 Tailscale 身份认证
    trustedProxy?: GatewayTrustedProxyConfig; // trusted-proxy 配置
  };
  ```

#### `GatewayAuthResult`

- **位置**：`src/gateway/auth.ts:55`
- **说明**：认证函数的返回结果，描述本次连接认证是否通过及详情。

  ```ts
  export type GatewayAuthResult = {
    ok: boolean;                                                                  // 认证是否通过
    method?: "none" | "token" | "password" | "tailscale" | "device-token" | "trusted-proxy";  // 实际使用的认证方式
    user?: string;                                                                // 认证用户标识
    reason?: string;                                                              // 失败原因代码
    rateLimited?: boolean;                                                        // 是否被速率限制拦截
    retryAfterMs?: number;                                                        // 速率限制时建议等待时间（毫秒）
  };
  ```

  常见 `reason` 值：`"token_mismatch"`、`"token_missing"`、`"token_missing_config"`、`"password_mismatch"`、`"password_missing"`、`"password_missing_config"`、`"rate_limited"`、`"tailscale_user_missing"`、`"tailscale_proxy_missing"`、`"tailscale_whois_failed"`、`"tailscale_user_mismatch"`、`"trusted_proxy_untrusted_source"`、`"trusted_proxy_user_missing"`、`"trusted_proxy_user_not_allowed"`、`"unauthorized"`

#### `GatewayAuthSurface`

- **位置**：`src/gateway/auth.ts:71`
- **说明**：认证表面（入口类型），决定是否启用 Tailscale header 认证。

  ```ts
  export type GatewayAuthSurface = "http" | "ws-control-ui";
  ```

  - `"http"`：HTTP 表面，禁用 Tailscale header 认证（防止 SSRF 攻击）
  - `"ws-control-ui"`：WebSocket 控制 UI 表面，允许 Tailscale header 认证（支持 tokenless 本地登录）

#### `AuthorizeGatewayConnectParams`

- **位置**：`src/gateway/auth.ts:73`
- **说明**：`authorizeGatewayConnect` 的参数对象类型。

  ```ts
  export type AuthorizeGatewayConnectParams = {
    auth: ResolvedGatewayAuth;               // 解析后的认证配置
    connectAuth?: ConnectAuth | null;         // 客户端提供的凭据（token 或 password）
    req?: IncomingMessage;                    // HTTP/WS 请求对象
    trustedProxies?: string[];               // 可信代理 IP 列表
    tailscaleWhois?: TailscaleWhoisLookup;   // Tailscale whois 查询函数
    authSurface?: GatewayAuthSurface;        // 认证表面（默认 "http"）
    rateLimiter?: AuthRateLimiter;           // 速率限制器实例
    clientIp?: string;                       // 客户端 IP（用于速率限制，可覆盖自动解析）
    rateLimitScope?: string;                 // 速率限制 scope（默认 shared-secret 范围）
    allowRealIpFallback?: boolean;           // 是否信任 X-Real-IP 头（需显式启用）
  };
  ```

---

### 内部函数 {#内部函数-auth}

#### `normalizeLogin`

- **位置**：`src/gateway/auth.ts:103`
- **标注**：[内部]
- **签名**：`function normalizeLogin(login: string): string`
- **说明**：规范化登录名：`trim()` + `toLowerCase()`。用于 Tailscale 用户名比对，确保大小写不敏感匹配。

#### `headerValue`

- **位置**：`src/gateway/auth.ts:108`
- **标注**：[内部]
- **签名**：`function headerValue(value: string | string[] | undefined): string | undefined`
- **说明**：从 HTTP header 值中取第一个字符串（处理数组形式的 header）。Node.js `IncomingMessage.headers` 中某些 header 可能为数组，此函数统一返回第一个值。

#### `resolveTailscaleClientIp`

- **位置**：`src/gateway/auth.ts:119`
- **标注**：[内部]
- **签名**：`function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined`
- **说明**：从请求中解析 Tailscale 客户端 IP。信任来自 loopback（`127.0.0.1` / `::1`）的 `X-Forwarded-For`，因为 Tailscale serve 代理始终运行在本机。`req` 为 undefined 时返回 undefined。

#### `resolveRequestClientIp`

- **位置**：`src/gateway/auth.ts:136`
- **标注**：[内部]
- **签名**：
  ```ts
  function resolveRequestClientIp(
    req?: IncomingMessage,
    trustedProxies?: string[],
    allowRealIpFallback?: boolean,
  ): string | undefined
  ```
- **说明**：从请求中解析真实客户端 IP，支持可信代理的 `X-Forwarded-For` 穿透。`allowRealIpFallback=true` 时额外信任 `X-Real-IP` 头（默认 `false`）。

#### `getTailscaleUser`

- **位置**：`src/gateway/auth.ts:191`
- **标注**：[内部]
- **签名**：`function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null`
- **说明**：从请求头中提取 Tailscale 用户信息。Tailscale serve 代理会注入 `tailscale-user-login`、`tailscale-user-name`、`tailscale-user-profile-pic` 等头。若 `req` 为 undefined 或 `tailscale-user-login` 头不存在/为空，返回 `null`。

#### `hasTailscaleProxyHeaders`

- **位置**：`src/gateway/auth.ts:209`
- **标注**：[内部]
- **签名**：`function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean`
- **说明**：检查请求是否同时包含 `X-Forwarded-For`、`X-Forwarded-Proto`、`X-Forwarded-Host` 三个头。用于辅助判断是否经由 Tailscale serve 代理转发。

#### `isTailscaleProxyRequest`

- **位置**：`src/gateway/auth.ts:224`
- **标注**：[内部]
- **签名**：`function isTailscaleProxyRequest(req?: IncomingMessage): boolean`
- **说明**：判断请求是否经由 Tailscale serve 代理转发。条件：remote address 为 loopback 地址，且同时存在三个 `X-Forwarded-*` 代理头。用于防止外部伪造 Tailscale header。

#### `resolveVerifiedTailscaleUser` {#reverseverifiedtailscaleuser}

- **位置**：`src/gateway/auth.ts:242`
- **标注**：[内部]
- **签名**：
  ```ts
  async function resolveVerifiedTailscaleUser(params: {
    req?: IncomingMessage;
    tailscaleWhois: TailscaleWhoisLookup;
  }): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }>
  ```
- **说明**：通过 Tailscale whois API 验证请求头中的用户身份，防止 header 伪造。

  验证流程：
  1. 从请求头提取 `tailscale-user-login`（失败 → `tailscale_user_missing`）
  2. 确认请求来自 Tailscale 代理（失败 → `tailscale_proxy_missing`）
  3. 解析 Tailscale 客户端 IP，调用 `tailscaleWhois(ip)` 获取真实身份（失败 → `tailscale_whois_failed`）
  4. 比对头中的 login 与 whois 返回的 login（不匹配 → `tailscale_user_mismatch`）
  5. 成功时使用 whois 的 name 覆盖头中的 name（更可信）

#### `authorizeTrustedProxy`

- **位置**：`src/gateway/auth.ts:401`
- **标注**：[内部]
- **签名**：
  ```ts
  function authorizeTrustedProxy(params: {
    req?: IncomingMessage;
    trustedProxies?: string[];
    trustedProxyConfig: GatewayTrustedProxyConfig;
  }): { user: string } | { reason: string }
  ```
- **说明**：检查请求是否来自可信代理并提取用户身份。

  验证步骤：
  1. 检查 remote address 在 `trustedProxies` 列表中（失败 → `trusted_proxy_untrusted_source`）
  2. 检查所有 `requiredHeaders` 均存在且非空（失败 → `trusted_proxy_missing_header_<name>`）
  3. 提取 `userHeader` 值（失败 → `trusted_proxy_user_missing`）
  4. 若配置了 `allowUsers`，检查用户在白名单中（失败 → `trusted_proxy_user_not_allowed`）
  5. 返回 `{ user }` 或 `{ reason }`

#### `shouldAllowTailscaleHeaderAuth`

- **位置**：`src/gateway/auth.ts:440`
- **标注**：[内部]
- **签名**：`function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean`
- **说明**：判断给定认证表面是否允许 Tailscale header 认证。仅 `"ws-control-ui"` 表面返回 `true`，`"http"` 表面返回 `false`（防止 SSRF）。

---

### Export 函数 {#export-函数-auth}

#### `isLocalDirectRequest`

- **位置**：`src/gateway/auth.ts:163`
- **签名**：
  ```ts
  export function isLocalDirectRequest(
    req?: IncomingMessage,
    trustedProxies?: string[],
    allowRealIpFallback?: boolean,
  ): boolean
  ```
- **说明**：判断请求是否来自本机直连（非通过代理转发）。满足以下所有条件时返回 `true`：
  1. 客户端 IP 是 loopback 地址（`127.x` / `::1`）
  2. `Host` 是本地地址（`localhost`、`127.x`、`::1`）
  3. 没有转发头，或转发头来自可信代理（`isTrustedProxyAddress`）

  用于决定是否允许无 token 的 loopback 访问，以及在 Tailscale 认证中区分本地直连和 Tailscale 代理连接。

- **参数**：
  - `req` — HTTP/WS 请求对象
  - `trustedProxies` — 可信代理 IP 列表
  - `allowRealIpFallback` — 是否信任 `X-Real-IP` 头（默认 `false`）
- **返回**：本机直连时返回 `true`

#### `resolveGatewayAuth`

- **位置**：`src/gateway/auth.ts:291`
- **签名**：
  ```ts
  export function resolveGatewayAuth(params: {
    authConfig?: GatewayAuthConfig | null;
    authOverride?: GatewayAuthConfig | null;
    env?: NodeJS.ProcessEnv;
    tailscaleMode?: GatewayTailscaleMode;
  }): ResolvedGatewayAuth
  ```
- **说明**：从配置和环境变量计算 Gateway 认证配置，是认证系统的配置解析入口。

  优先级（高到低）：
  1. `authOverride`（运行时覆盖，如 CLI 参数；仅覆盖已设置的字段）
  2. `authConfig`（配置文件中的 `gateway.auth`）
  3. 环境变量（通过 `resolveGatewayCredentialsFromValues` 读取 `OPENCLAW_GATEWAY_TOKEN` 等）

  模式推断（未显式设置 `mode` 时）：有 password → `"password"`；有 token → `"token"`；否则 `"token"`（无凭据，`modeSource="default"`）。

  `allowTailscale` 推断：未显式配置时，当 `tailscaleMode === "serve"` 且 `mode` 不是 `"password"` 或 `"trusted-proxy"` 时自动启用。

- **参数**：
  - `authConfig` — 配置文件中的认证配置
  - `authOverride` — 运行时覆盖配置（CLI 参数）
  - `env` — 环境变量（默认 `process.env`）
  - `tailscaleMode` — Tailscale 集成模式
- **返回**：`ResolvedGatewayAuth` 认证配置对象

#### `assertGatewayAuthConfigured`

- **位置**：`src/gateway/auth.ts:371`
- **签名**：`export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void`
- **说明**：断言 Gateway 认证配置完整有效。在 Gateway 启动时调用，若配置不完整则抛出含具体提示的 `Error`。

  检查规则：
  - `mode === "token"` 且无 token，且未启用 Tailscale → 抛出错误，提示设置 `gateway.auth.token` 或 `OPENCLAW_GATEWAY_TOKEN`
  - `mode === "password"` 且无 password → 抛出错误
  - `mode === "trusted-proxy"` 且无 `trustedProxy` 配置，或 `userHeader` 为空 → 抛出错误，提示设置 `gateway.auth.trustedProxy.userHeader`

- **参数**：`auth` — 由 `resolveGatewayAuth` 返回的认证配置
- **抛出**：`Error`（配置不完整时）

#### `authorizeGatewayConnect`

- **位置**：`src/gateway/auth.ts:457`
- **签名**：
  ```ts
  export async function authorizeGatewayConnect(
    params: AuthorizeGatewayConnectParams,
  ): Promise<GatewayAuthResult>
  ```
- **说明**：核心认证函数，验证 WebSocket/HTTP 连接请求是否有权访问 Gateway。

  认证流程（按模式）：

  **trusted-proxy 模式**：
  1. 验证 `trustedProxy` 配置存在
  2. 验证 `trustedProxies` 列表非空
  3. 调用 `authorizeTrustedProxy` 验证来源 IP 和用户 header

  **none 模式**：直接返回 `{ ok: true, method: "none" }`

  **token / password 模式**：
  1. 若配置了 `rateLimiter`，检查速率限制；被限制时返回 `{ ok: false, reason: "rate_limited", rateLimited: true, retryAfterMs }`
  2. 若 `authSurface === "ws-control-ui"` 且 `allowTailscale=true` 且非本地直连，尝试 Tailscale whois 验证；成功则重置速率限制计数并返回
  3. **token 模式**：比较 `connectAuth.token` 与 `auth.token`（常量时间比较，防止时序攻击）
  4. **password 模式**：比较 `connectAuth.password` 与 `auth.password`（常量时间比较）
  5. 认证失败时调用 `rateLimiter.recordFailure`；成功时调用 `rateLimiter.reset`

- **参数**：见 `AuthorizeGatewayConnectParams`
- **返回**：`Promise<GatewayAuthResult>`

#### `authorizeHttpGatewayConnect`

- **位置**：`src/gateway/auth.ts:569`
- **签名**：
  ```ts
  export async function authorizeHttpGatewayConnect(
    params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
  ): Promise<GatewayAuthResult>
  ```
- **说明**：HTTP 表面的 Gateway 认证入口，是 `authorizeGatewayConnect` 的表面特化版本。固定 `authSurface="http"`（禁用 Tailscale header 认证，防止 SSRF 攻击），其余参数透传。
- **参数**：同 `AuthorizeGatewayConnectParams`，但不含 `authSurface`
- **返回**：`Promise<GatewayAuthResult>`

#### `authorizeWsControlUiGatewayConnect`

- **位置**：`src/gateway/auth.ts:583`
- **签名**：
  ```ts
  export async function authorizeWsControlUiGatewayConnect(
    params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
  ): Promise<GatewayAuthResult>
  ```
- **说明**：WebSocket Control UI 表面的 Gateway 认证入口，是 `authorizeGatewayConnect` 的表面特化版本。固定 `authSurface="ws-control-ui"`（允许 Tailscale header 认证，支持 tokenless 本地登录场景），其余参数透传。
- **参数**：同 `AuthorizeGatewayConnectParams`，但不含 `authSurface`
- **返回**：`Promise<GatewayAuthResult>`
