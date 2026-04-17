# Routing 与 Auto-reply 模块 API 参考

> 生成日期：2026-04-15
> 覆盖文件：
> - `src/routing/resolve-route.ts`
> - `src/routing/session-key.ts`
> - `src/auto-reply/dispatch.ts`

---

## 目录

1. [resolve-route.ts — 路由解析核心](#resolve-routets--路由解析核心)
   - [类型](#类型)
   - [常量（re-export）](#常量re-export)
   - [函数](#函数)
2. [session-key.ts — 会话 Key 构建与解析](#session-keyts--会话-key-构建与解析)
   - [常量](#常量)
   - [类型](#类型-1)
   - [函数](#函数-1)
3. [auto-reply/dispatch.ts — 入站消息分发](#auto-replydispatchts--入站消息分发)
   - [类型](#类型-2)
   - [函数](#函数-2)
4. [关键机制说明](#关键机制说明)

---

## resolve-route.ts — 路由解析核心

### 类型

#### `RoutePeerKind`

- **位置**：`src/routing/resolve-route.ts:19`
- **签名**：`export type RoutePeerKind = ChatType`
- **说明**：路由 peer 类型的别名，直接等同于 `ChatType`。**已废弃**，应改用 `src/channels/chat-type.ts` 中的 `ChatType`。
- **注意**：`@deprecated` 标注，保留仅为向后兼容。

---

#### `RoutePeer`

- **位置**：`src/routing/resolve-route.ts:26`
- **签名**：
  ```ts
  export type RoutePeer = {
    kind: ChatType;
    id: string;
  }
  ```
- **说明**：路由中一个"对话对象"的标识，由聊天类型和平台内唯一 ID 组成。
- **字段**：
  - `kind: ChatType` — 聊天类型，取值：`"direct"`（私聊）、`"group"`（群组）、`"thread"`（线程/话题）。
  - `id: string` — 渠道内的 peer 唯一标识（如 Telegram 的 `chat_id`、Discord 的 `channel_id`）。

---

#### `ResolveAgentRouteInput`

- **位置**：`src/routing/resolve-route.ts:42`
- **签名**：
  ```ts
  export type ResolveAgentRouteInput = {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string | null;
    peer?: RoutePeer | null;
    parentPeer?: RoutePeer | null;
    guildId?: string | null;
    teamId?: string | null;
    memberRoleIds?: string[];
  }
  ```
- **说明**：`resolveAgentRoute` 的完整输入上下文，描述一条入站消息所属的渠道、账户、peer、服务器等信息。
- **字段**：
  - `cfg` — 当前 OpenClaw 配置对象（含 `bindings`、`agents`、`session` 等节）。
  - `channel` — 渠道 ID 字符串（如 `"telegram"`、`"discord"`、`"slack"`）。
  - `accountId?` — 渠道账户 ID（多账户渠道时区分；缺省时视为默认账户 `DEFAULT_ACCOUNT_ID`）。
  - `peer?` — 消息来源 peer（私聊时为用户 peer，群组时为群组 peer）。
  - `parentPeer?` — 线程的父 peer（仅 Discord threads、Slack thread 等有效），用于线程 binding 继承回退。
  - `guildId?` — 服务器/工作区 ID（Discord guild ID、Slack workspace ID）。
  - `teamId?` — 团队 ID（Slack 多工作区场景）。
  - `memberRoleIds?` — 消息发送者的角色 ID 列表（Discord member roles），用于 `binding.guild+roles` 匹配。

---

#### `ResolvedAgentRoute`

- **位置**：`src/routing/resolve-route.ts:64`
- **签名**：
  ```ts
  export type ResolvedAgentRoute = {
    agentId: string;
    channel: string;
    accountId: string;
    sessionKey: string;
    mainSessionKey: string;
    matchedBy:
      | "binding.peer"
      | "binding.peer.parent"
      | "binding.guild+roles"
      | "binding.guild"
      | "binding.team"
      | "binding.account"
      | "binding.channel"
      | "default";
  }
  ```
- **说明**：路由解析结果，包含确定的 agent、会话 key 及命中的匹配层级（供调试日志使用）。
- **字段**：
  - `agentId` — 目标 agent 的规范化 ID（已通过 `sanitizeAgentId` 处理）。
  - `channel` — 规范化（trim + lowercase）后的渠道 ID。
  - `accountId` — 规范化后的账户 ID（空时为 `DEFAULT_ACCOUNT_ID`）。
  - `sessionKey` — 完整会话 key，用于持久化存储和并发控制。格式见[会话 Key 格式说明](#会话-key-格式说明)。
  - `mainSessionKey` — 主会话 key（`agent:{id}:main`），DM 折叠时所有私聊共用。
  - `matchedBy` — 命中的 binding 层级，枚举值对应 8 个优先级层级之一。

---

#### `NormalizedPeerConstraint` [内部]

- **位置**：`src/routing/resolve-route.ts:191`
- **签名**：
  ```ts
  type NormalizedPeerConstraint =
    | { state: "none" }
    | { state: "invalid" }
    | { state: "valid"; kind: ChatType; id: string }
  ```
- **说明**：[内部] binding match 中 peer 约束的规范化表示。`none` 表示无 peer 约束，`invalid` 表示 peer 配置不完整（无 kind 或 id），`valid` 表示可用于精确匹配。

---

#### `NormalizedBindingMatch` [内部]

- **位置**：`src/routing/resolve-route.ts:196`
- **签名**：
  ```ts
  type NormalizedBindingMatch = {
    accountPattern: string;
    peer: NormalizedPeerConstraint;
    guildId: string | null;
    teamId: string | null;
    roles: string[] | null;
  }
  ```
- **说明**：[内部] 单个 binding 的 match 条件经规范化后的结构，供路由层级匹配使用。

---

#### `EvaluatedBinding` [内部]

- **位置**：`src/routing/resolve-route.ts:204`
- **签名**：
  ```ts
  type EvaluatedBinding = {
    binding: ReturnType<typeof listBindings>[number];
    match: NormalizedBindingMatch;
  }
  ```
- **说明**：[内部] 原始 binding 配置项与其规范化 match 条件的组合，为缓存后的预处理结果。

---

#### `BindingScope` [内部]

- **位置**：`src/routing/resolve-route.ts:209`
- **签名**：
  ```ts
  type BindingScope = {
    peer: RoutePeer | null;
    guildId: string;
    teamId: string;
    memberRoleIds: Set<string>;
  }
  ```
- **说明**：[内部] 单次路由匹配时的运行时作用域，包含实际消息的 peer/guild/team/roles 信息。

---

#### `EvaluatedBindingsCache` [内部]

- **位置**：`src/routing/resolve-route.ts:216`
- **签名**：
  ```ts
  type EvaluatedBindingsCache = {
    bindingsRef: OpenClawConfig["bindings"];
    byChannelAccount: Map<string, EvaluatedBinding[]>;
  }
  ```
- **说明**：[内部] 每个 `OpenClawConfig` 对象对应的 binding 预处理缓存结构。`bindingsRef` 用于检测配置是否已更新，`byChannelAccount` 以 `"channel\taccountId"` 为 key 存储过滤后的 binding 列表。

---

### 常量（re-export）

#### `DEFAULT_ACCOUNT_ID`

- **位置**：`src/routing/resolve-route.ts:84`（re-export 自 `session-key.ts`）
- **说明**：默认账户 ID 常量，详见 [session-key.ts 常量](#常量)。

#### `DEFAULT_AGENT_ID`

- **位置**：`src/routing/resolve-route.ts:84`（re-export 自 `session-key.ts`）
- **说明**：默认 agent ID 常量（值为 `"main"`），详见 [session-key.ts 常量](#常量)。

---

### 函数

#### `normalizeToken` [内部]

- **位置**：`src/routing/resolve-route.ts:87`
- **签名**：`function normalizeToken(value: string | undefined | null): string`
- **说明**：[内部] 将字符串 trim 并转 lowercase；`null`/`undefined` 返回空字符串。用于渠道 ID、accountId 等比对前的规范化。
- **参数**：
  - `value` — 待规范化的字符串（可为 null/undefined）
- **返回**：规范化后的字符串，不会返回 null/undefined

---

#### `normalizeId` [内部]

- **位置**：`src/routing/resolve-route.ts:92`
- **签名**：`function normalizeId(value: unknown): string`
- **说明**：[内部] 将未知类型的 ID 值转为字符串。字符串 trim，数字/BigInt 转字符串后 trim，其他类型返回空字符串。用于 peer.id、guildId、teamId 等字段的安全读取。
- **参数**：
  - `value` — 任意类型的 ID 值
- **返回**：字符串形式的 ID，可能为空字符串

---

#### `matchesAccountId` [内部]

- **位置**：`src/routing/resolve-route.ts:108`
- **签名**：`function matchesAccountId(match: string | undefined, actual: string): boolean`
- **说明**：[内部] 判断 binding 配置的 `accountId` 模式是否匹配实际账户 ID。
- **参数**：
  - `match` — binding match 中配置的 accountId 模式
  - `actual` — 已规范化的实际账户 ID
- **返回**：`true` 表示匹配
- **匹配规则**：
  - 空字符串或未配置 → 匹配 `DEFAULT_ACCOUNT_ID`（即默认账户）
  - `"*"` → 匹配任意账户（通配符）
  - 其他 → 规范化后精确字符串匹配

---

#### `buildAgentSessionKey`

- **位置**：`src/routing/resolve-route.ts:135`
- **签名**：
  ```ts
  export function buildAgentSessionKey(params: {
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer?: RoutePeer | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    identityLinks?: Record<string, string[]>;
  }): string
  ```
- **说明**：根据路由上下文构建 agent 会话 key 的公共入口。内部委托给 `buildAgentPeerSessionKey`，并自动处理 peer 缺失、channel 规范化等边界情况。
- **参数**：
  - `params.agentId` — agent ID（会经 `normalizeAgentId` 规范化）
  - `params.channel` — 渠道 ID（trim + lowercase，空时降级为 `"unknown"`）
  - `params.accountId?` — 渠道账户 ID（可选）
  - `params.peer?` — peer 信息（缺省时以 `"direct"` + `null` peerId 处理）
  - `params.dmScope?` — DM 会话作用域，默认 `"main"`
  - `params.identityLinks?` — 身份链接映射（跨渠道会话合并用）
- **返回**：小写规范化的会话 key 字符串
- **dmScope 对会话 key 格式的影响**：

  | dmScope | 格式（private/direct） |
  |---|---|
  | `main`（默认） | `agent:{id}:main` |
  | `per-peer` | `agent:{id}:direct:{peerId}` |
  | `per-channel-peer` | `agent:{id}:{channel}:direct:{peerId}` |
  | `per-account-channel-peer` | `agent:{id}:{channel}:{accountId}:direct:{peerId}` |

  群组/线程（非 direct）不受 dmScope 影响，固定格式为 `agent:{id}:{channel}:{kind}:{peerId}`。

---

#### `listAgents` [内部]

- **位置**：`src/routing/resolve-route.ts:158`
- **签名**：`function listAgents(cfg: OpenClawConfig): Array<...>`
- **说明**：[内部] 安全读取配置中的 agents 列表，配置缺失时返回空数组。

---

#### `pickFirstExistingAgentId` [内部]

- **位置**：`src/routing/resolve-route.ts:163`
- **签名**：`function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string`
- **说明**：[内部] 验证并解析 agentId：先在配置的 agents 列表中查找精确匹配项，找到则使用配置中的 ID（保留原始大小写后再 sanitize），找不到则降级为默认 agent ID。配置中无 agents 列表时直接 sanitize 传入值。
- **参数**：
  - `cfg` — 配置对象
  - `agentId` — 待解析的 agent ID（可为空）
- **返回**：已通过 `sanitizeAgentId` 规范化的 agent ID

---

#### `matchesChannel` [内部]

- **位置**：`src/routing/resolve-route.ts:180`
- **签名**：`function matchesChannel(match: { channel?: string } | undefined, channel: string): boolean`
- **说明**：[内部] 判断 binding match 配置的 channel 是否与实际渠道 ID 匹配（规范化后精确匹配）。空 channel 配置视为不匹配（返回 `false`）。
- **返回**：`true` 表示渠道匹配

---

#### `getEvaluatedBindingsForChannelAccount` [内部]

- **位置**：`src/routing/resolve-route.ts:236`
- **签名**：
  ```ts
  function getEvaluatedBindingsForChannelAccount(
    cfg: OpenClawConfig,
    channel: string,
    accountId: string,
  ): EvaluatedBinding[]
  ```
- **说明**：[内部] 获取指定渠道账户组合的已过滤、已规范化 binding 列表（带二级缓存）。

  缓存策略：
  - 外层使用 `WeakMap<OpenClawConfig, EvaluatedBindingsCache>`，以配置对象为 key；配置对象引用不变则缓存有效，对象被 GC 时自动清除。
  - 内层以 `"channel\taccountId"` 为 key 存储 `Map<string, EvaluatedBinding[]>`；单配置缓存条目上限为 `MAX_EVALUATED_BINDINGS_CACHE_KEYS`（2000）。
  - 超出上限时清空内层 Map 并重新写入当前条目，避免无界增长。

- **参数**：
  - `cfg` — 配置对象（作为 WeakMap 外层 key）
  - `channel` — 已规范化的渠道 ID
  - `accountId` — 已规范化的账户 ID
- **返回**：过滤出的、针对该渠道+账户的 `EvaluatedBinding[]`

---

#### `normalizePeerConstraint` [内部]

- **位置**：`src/routing/resolve-route.ts:279`
- **签名**：
  ```ts
  function normalizePeerConstraint(
    peer: { kind?: string; id?: string } | undefined,
  ): NormalizedPeerConstraint
  ```
- **说明**：[内部] 将原始 binding peer 配置转换为 `NormalizedPeerConstraint`。未配置返回 `{state:"none"}`，kind 或 id 不完整返回 `{state:"invalid"}`，否则返回 `{state:"valid", kind, id}`。

---

#### `normalizeBindingMatch` [内部]

- **位置**：`src/routing/resolve-route.ts:293`
- **签名**：
  ```ts
  function normalizeBindingMatch(match: { ... } | undefined): NormalizedBindingMatch
  ```
- **说明**：[内部] 将一个 binding 的原始 match 配置对象完整规范化，包括 accountPattern、peer 约束、guildId、teamId 和 roles。

---

#### `hasGuildConstraint` [内部]

- **位置**：`src/routing/resolve-route.ts:314`
- **签名**：`function hasGuildConstraint(match: NormalizedBindingMatch): boolean`
- **说明**：[内部] 判断规范化 match 是否包含 guildId 约束。

---

#### `hasTeamConstraint` [内部]

- **位置**：`src/routing/resolve-route.ts:318`
- **签名**：`function hasTeamConstraint(match: NormalizedBindingMatch): boolean`
- **说明**：[内部] 判断规范化 match 是否包含 teamId 约束。

---

#### `hasRolesConstraint` [内部]

- **位置**：`src/routing/resolve-route.ts:322`
- **签名**：`function hasRolesConstraint(match: NormalizedBindingMatch): boolean`
- **说明**：[内部] 判断规范化 match 是否包含 roles 约束（至少一个角色 ID）。

---

#### `matchesBindingScope` [内部]

- **位置**：`src/routing/resolve-route.ts:326`
- **签名**：
  ```ts
  function matchesBindingScope(match: NormalizedBindingMatch, scope: BindingScope): boolean
  ```
- **说明**：[内部] 判断一个规范化 binding match 是否与当前运行时 scope 完全匹配。
- **匹配逻辑**（按顺序，任一不满足则返回 `false`）：
  1. peer 约束为 `invalid` → 直接 `false`
  2. peer 约束为 `valid` → scope.peer 必须存在且 kind/id 完全一致
  3. guildId 约束存在 → scope.guildId 必须相等
  4. teamId 约束存在 → scope.teamId 必须相等
  5. roles 约束存在 → scope.memberRoleIds 中**至少有一个**角色在约束列表内（任一匹配即 `true`）
  6. 以上全部通过 → `true`
- **注意**：roles 匹配使用"任一"（OR）语义，而不是"全部"（AND）语义。

---

#### `resolveAgentRoute`

- **位置**：`src/routing/resolve-route.ts:371`
- **签名**：
  ```ts
  export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute
  ```
- **说明**：核心路由解析函数，将入站消息的上下文（渠道、账户、peer、guild、team、角色）映射到目标 `(agentId, sessionKey)`。

  **执行流程**：
  1. 规范化所有输入字段（trim、lowercase、id 安全转换）。
  2. 通过 `getEvaluatedBindingsForChannelAccount` 从缓存获取该渠道+账户的 binding 列表。
  3. 读取 `dmScope` 和 `identityLinks` 配置。
  4. 构建内部 `choose()` 闭包（负责调用 `pickFirstExistingAgentId` + `buildAgentSessionKey`）。
  5. 按优先级从高到低遍历 7 个非 default 层级，找到第一个满足 `predicate` 且通过 `matchesBindingScope` 的 binding 后立即调用 `choose()` 返回。
  6. 所有层级均无匹配时，使用 `resolveDefaultAgentId(cfg)` 作为默认 agent 返回。

- **参数**：
  - `input` — 完整路由输入（见 `ResolveAgentRouteInput`）

- **返回**：`ResolvedAgentRoute` — 路由结果

- **路由优先级（从高到低）**：

  | 优先级 | matchedBy | 触发条件 | 说明 |
  |:---:|---|---|---|
  | 1 | `binding.peer` | `peer` 非空 | 精确匹配消息 peer 的 kind+id |
  | 2 | `binding.peer.parent` | `parentPeer` 非空且有 id | 线程回退：匹配父 peer 的 binding |
  | 3 | `binding.guild+roles` | `guildId` 非空 且 `memberRoleIds` 非空 | guild 约束 + roles 约束同时满足 |
  | 4 | `binding.guild` | `guildId` 非空 | 仅 guild 约束（无 roles 约束） |
  | 5 | `binding.team` | `teamId` 非空 | team 约束 |
  | 6 | `binding.account` | 始终启用 | accountId 非通配符（非 `"*"`）的 binding |
  | 7 | `binding.channel` | 始终启用 | accountId 为 `"*"` 的 binding（渠道级） |
  | 8 | `default` | 前 7 层均无匹配 | 使用配置默认 agent |

- **注意事项**：
  - 同一层级有多个 binding 时，取列表中**第一个**匹配项（binding 在配置中的顺序有意义）。
  - 开启 verbose 日志（`shouldLogVerbose()`）时，会输出所有 binding 的规范化状态及最终命中结果，便于路由调试。
  - `binding.peer.parent` 使用 `parentPeer` 的 id 构造 scope，而不是原始 `peer`，实现线程回退继承。
  - `binding.guild` 层级明确排除有 roles 约束的 binding（`!hasRolesConstraint`），避免与层级 3 重叠。

---

## session-key.ts — 会话 Key 构建与解析

### 常量

#### `DEFAULT_AGENT_ID`

- **位置**：`src/routing/session-key.ts:19`
- **签名**：`export const DEFAULT_AGENT_ID = "main"`
- **说明**：默认 agent ID，值为 `"main"`。当 agentId 为空或配置中找不到对应 agent 时使用。

#### `DEFAULT_MAIN_KEY`

- **位置**：`src/routing/session-key.ts:20`
- **签名**：`export const DEFAULT_MAIN_KEY = "main"`
- **说明**：主会话 key 的默认 key 段，值为 `"main"`。构建 main session key 时作为 `mainKey` 参数默认值。

#### `DEFAULT_ACCOUNT_ID`

- **位置**：`src/routing/session-key.ts:3`（re-export 自 `./account-id.ts`）
- **说明**：默认账户 ID 常量。accountId 为空时规范化为此值，binding 中空 accountId 模式匹配此值。

---

### 类型

#### `SessionKeyShape`

- **位置**：`src/routing/session-key.ts:21`
- **签名**：`export type SessionKeyShape = "missing" | "agent" | "legacy_or_alias" | "malformed_agent"`
- **说明**：会话 key 的结构分类，由 `classifySessionKeyShape` 返回。
- **枚举值**：
  - `"missing"` — key 为空或仅空白
  - `"agent"` — 合法的 `agent:` 前缀格式（可被 `parseAgentSessionKey` 解析）
  - `"legacy_or_alias"` — 不以 `agent:` 开头，视为遗留 key 或别名
  - `"malformed_agent"` — 以 `agent:` 开头但无法被解析（格式错误）

---

### 函数

#### `normalizeMainKey`

- **位置**：`src/routing/session-key.ts:33`
- **签名**：`export function normalizeMainKey(value: string | undefined | null): string`
- **说明**：规范化 main key 字符串：trim 后转 lowercase；空值返回 `DEFAULT_MAIN_KEY`（`"main"`）。
- **参数**：
  - `value` — 待规范化的 main key（可为 null/undefined）
- **返回**：规范化后的 main key，不为空

---

#### `toAgentRequestSessionKey`

- **位置**：`src/routing/session-key.ts:38`
- **签名**：`export function toAgentRequestSessionKey(storeKey: string | undefined | null): string | undefined`
- **说明**：将存储格式的 session key（`agent:{agentId}:{rest}`）转换为请求格式（仅 `{rest}` 部分）。存储 key 为 agent 格式时提取 `rest`；无法解析时原样返回；空值返回 `undefined`。
- **参数**：
  - `storeKey` — 存储格式的会话 key
- **返回**：请求格式的 key，或 `undefined`（输入为空时）
- **用途**：将内部存储 key 转换为传递给 agent runtime 的 key 格式。

---

#### `toAgentStoreSessionKey`

- **位置**：`src/routing/session-key.ts:46`
- **签名**：
  ```ts
  export function toAgentStoreSessionKey(params: {
    agentId: string;
    requestKey: string | undefined | null;
    mainKey?: string | undefined;
  }): string
  ```
- **说明**：将请求格式的 session key 转换为存储格式（带 `agent:{agentId}:` 前缀）。
- **参数**：
  - `params.agentId` — agent ID
  - `params.requestKey` — 请求格式的 key（可为空）
  - `params.mainKey?` — main key 段（默认 `"main"`）
- **返回**：存储格式的 key（`agent:{agentId}:{rest}`）
- **转换规则**：
  1. 空或等于 `DEFAULT_MAIN_KEY` → 调用 `buildAgentMainSessionKey`
  2. 已是 agent 格式（可被 `parseAgentSessionKey` 解析）→ 重新拼接 `agent:{parsedAgentId}:{rest}`
  3. 已以 `agent:` 开头 → lowercase 后直接使用
  4. 其他 → 前缀加上 `agent:{normalizedAgentId}:`

---

#### `resolveAgentIdFromSessionKey`

- **位置**：`src/routing/session-key.ts:66`
- **签名**：`export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string`
- **说明**：从会话 key 中提取并规范化 agent ID。无法解析时返回 `normalizeAgentId(DEFAULT_AGENT_ID)`。
- **参数**：
  - `sessionKey` — 待解析的会话 key
- **返回**：规范化后的 agent ID

---

#### `classifySessionKeyShape`

- **位置**：`src/routing/session-key.ts:71`
- **签名**：`export function classifySessionKeyShape(sessionKey: string | undefined | null): SessionKeyShape`
- **说明**：对会话 key 的结构进行分类，返回 `SessionKeyShape` 枚举值。用于区分合法 agent key、遗留格式 key 和空 key。
- **参数**：
  - `sessionKey` — 待分类的会话 key
- **返回**：`SessionKeyShape` 枚举值

---

#### `normalizeAgentId`

- **位置**：`src/routing/session-key.ts:82`
- **签名**：`export function normalizeAgentId(value: string | undefined | null): string`
- **说明**：将 agent ID 规范化为路径安全、shell 安全的小写字母/数字/下划线/短横线格式，长度不超过 64 字符。
- **参数**：
  - `value` — 原始 agent ID（可为 null/undefined）
- **返回**：规范化后的 agent ID；空值或规范化后为空时返回 `DEFAULT_AGENT_ID`（`"main"`）
- **规范化规则**：
  1. trim 后若满足 `^[a-z0-9][a-z0-9_-]{0,63}$` → 直接 lowercase 返回
  2. 否则 → lowercase 后将非 `[a-z0-9_-]` 字符替换为 `-`，去除首尾 `-`，截断至 64 字符
  3. 结果为空 → 返回 `DEFAULT_AGENT_ID`

---

#### `sanitizeAgentId`

- **位置**：`src/routing/session-key.ts:102`
- **签名**：`export function sanitizeAgentId(value: string | undefined | null): string`
- **说明**：`normalizeAgentId` 的别名，提供语义更清晰的调用名称。
- **参数**：同 `normalizeAgentId`
- **返回**：同 `normalizeAgentId`

---

#### `buildAgentMainSessionKey`

- **位置**：`src/routing/session-key.ts:106`
- **签名**：
  ```ts
  export function buildAgentMainSessionKey(params: {
    agentId: string;
    mainKey?: string | undefined;
  }): string
  ```
- **说明**：构建 agent 主会话 key（`agent:{agentId}:{mainKey}`）。主会话 key 用于 DM 折叠场景，所有私聊消息共用同一个 main key。
- **参数**：
  - `params.agentId` — agent ID（会经 `normalizeAgentId` 规范化）
  - `params.mainKey?` — main key 段（默认 `"main"`）
- **返回**：格式为 `agent:{agentId}:{mainKey}` 的字符串
- **示例**：`buildAgentMainSessionKey({ agentId: "pi", mainKey: "main" })` → `"agent:pi:main"`

---

#### `buildAgentPeerSessionKey`

- **位置**：`src/routing/session-key.ts:115`
- **签名**：
  ```ts
  export function buildAgentPeerSessionKey(params: {
    agentId: string;
    mainKey?: string | undefined;
    channel: string;
    accountId?: string | null;
    peerKind?: ChatType | null;
    peerId?: string | null;
    identityLinks?: Record<string, string[]>;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  }): string
  ```
- **说明**：按 `peerKind` 和 `dmScope` 构建 agent peer 会话 key 的核心函数。
- **参数**：
  - `params.agentId` — agent ID
  - `params.mainKey?` — main key 段（默认 `"main"`）
  - `params.channel` — 渠道 ID
  - `params.accountId?` — 账户 ID（仅 `per-account-channel-peer` 时使用）
  - `params.peerKind?` — peer 类型（`"direct"` / `"group"` / `"thread"`），默认 `"direct"`
  - `params.peerId?` — peer ID
  - `params.identityLinks?` — 身份链接映射（仅 `peerKind === "direct"` 且非 `main` scope 时使用）
  - `params.dmScope?` — DM 会话作用域，默认 `"main"`
- **返回**：规范化的会话 key 字符串
- **构建规则（peerKind === "direct"）**：

  | dmScope | 格式 |
  |---|---|
  | `main` | `agent:{id}:main` |
  | `per-peer` | `agent:{id}:direct:{peerId}` |
  | `per-channel-peer` | `agent:{id}:{channel}:direct:{peerId}` |
  | `per-account-channel-peer` | `agent:{id}:{channel}:{accountId}:direct:{peerId}` |

  注意：如果 `peerId` 为空，`per-*` scope 均回退到 `main` 格式。

- **构建规则（peerKind !== "direct"，即群组/线程）**：

  格式固定为 `agent:{id}:{channel}:{peerKind}:{peerId}`，不受 dmScope 影响。

- **identityLinks**：仅在 `peerKind === "direct"` 且 `dmScope !== "main"` 时有效。若当前 `peerId` 或 `{channel}:{peerId}` 在身份链接中有对应规范名称，则以规范名称替换 `peerId`，实现跨渠道会话合并。

---

#### `resolveLinkedPeerId` [内部]

- **位置**：`src/routing/session-key.ts:164`
- **签名**：
  ```ts
  function resolveLinkedPeerId(params: {
    identityLinks?: Record<string, string[]>;
    channel: string;
    peerId: string;
  }): string | null
  ```
- **说明**：[内部] 在身份链接映射中查找 `peerId`（或 `channel:peerId`）对应的规范名称。找到则返回规范名称，否则返回 `null`。用于跨渠道身份合并（同一用户在不同渠道使用同一个会话）。
- **查找逻辑**：
  1. 构建候选集合：`peerId`（原始）和 `channel:peerId`（带渠道前缀）
  2. 遍历 `identityLinks` 的每个 canonical 名称及其 id 列表
  3. 将 id 列表中每个值规范化（trim + lowercase），与候选集合比较
  4. 首个命中 → 返回 canonical 名称
- **参数**：
  - `params.identityLinks` — 身份链接映射（key 为规范名，value 为等价 ID 列表）
  - `params.channel` — 渠道 ID
  - `params.peerId` — 当前 peer ID
- **返回**：规范名称字符串，或 `null`（未命中）

---

#### `buildGroupHistoryKey`

- **位置**：`src/routing/session-key.ts:210`
- **签名**：
  ```ts
  export function buildGroupHistoryKey(params: {
    channel: string;
    accountId?: string | null;
    peerKind: "group" | "channel";
    peerId: string;
  }): string
  ```
- **说明**：构建群组/频道历史记录的存储 key（非会话 key）。格式为 `{channel}:{accountId}:{peerKind}:{peerId}`，用于群组消息历史的持久化索引。
- **参数**：
  - `params.channel` — 渠道 ID
  - `params.accountId?` — 账户 ID
  - `params.peerKind` — peer 类型，限于 `"group"` 或 `"channel"`
  - `params.peerId` — peer ID
- **返回**：格式化的历史 key 字符串

---

#### `resolveThreadSessionKeys`

- **位置**：`src/routing/session-key.ts:222`
- **签名**：
  ```ts
  export function resolveThreadSessionKeys(params: {
    baseSessionKey: string;
    threadId?: string | null;
    parentSessionKey?: string;
    useSuffix?: boolean;
    normalizeThreadId?: (threadId: string) => string;
  }): { sessionKey: string; parentSessionKey?: string }
  ```
- **说明**：基于基础会话 key 和线程 ID 解析线程会话的 key 对（sessionKey + parentSessionKey）。
- **参数**：
  - `params.baseSessionKey` — 基础会话 key（通常为父消息的会话 key）
  - `params.threadId?` — 线程 ID（空时不追加线程后缀）
  - `params.parentSessionKey?` — 父会话 key（线程对话的上级 key）
  - `params.useSuffix?` — 是否在 key 上追加 `:thread:{threadId}` 后缀，默认 `true`
  - `params.normalizeThreadId?` — 自定义线程 ID 规范化函数，默认 `toLowerCase()`
- **返回**：
  - `sessionKey` — 线程会话 key（有 threadId 且 useSuffix 时为 `{baseKey}:thread:{normalizedThreadId}`，否则为 `baseSessionKey`）
  - `parentSessionKey` — 父会话 key（可能为 `undefined`）
- **注意**：当 `threadId` 为空时，直接返回 `baseSessionKey`，`parentSessionKey` 为 `undefined`。

---

### Re-exported 函数（来自其他模块）

以下函数通过 `session-key.ts` re-export，文档在原始文件中：

| 函数名 | 原始位置 | 说明 |
|---|---|---|
| `getSubagentDepth` | `src/sessions/session-key-utils.ts` | 获取子 agent 嵌套深度 |
| `isCronSessionKey` | `src/sessions/session-key-utils.ts` | 判断是否为 cron 类型 session key |
| `isAcpSessionKey` | `src/sessions/session-key-utils.ts` | 判断是否为 ACP 类型 session key |
| `isSubagentSessionKey` | `src/sessions/session-key-utils.ts` | 判断是否为子 agent session key |
| `parseAgentSessionKey` | `src/sessions/session-key-utils.ts` | 解析 agent session key 结构 |
| `normalizeAccountId` | `src/routing/account-id.ts` | 规范化账户 ID |
| `normalizeOptionalAccountId` | `src/routing/account-id.ts` | 规范化可选账户 ID |

---

## auto-reply/dispatch.ts — 入站消息分发

### 类型

#### `DispatchInboundResult`

- **位置**：`src/auto-reply/dispatch.ts:16`
- **签名**：`export type DispatchInboundResult = DispatchFromConfigResult`
- **说明**：入站消息分发的结果类型，直接透传自 `dispatchReplyFromConfig` 的返回类型 `DispatchFromConfigResult`（定义于 `src/auto-reply/reply/dispatch-from-config.ts`）。

---

### 函数

#### `withReplyDispatcher`

- **位置**：`src/auto-reply/dispatch.ts:31`
- **签名**：
  ```ts
  export async function withReplyDispatcher<T>(params: {
    dispatcher: ReplyDispatcher;
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
  }): Promise<T>
  ```
- **说明**：为 `ReplyDispatcher` 提供生命周期管理的通用 try/finally 包装器。确保在所有退出路径（正常返回和异常抛出）上都正确完成 dispatcher 清理。
- **参数**：
  - `params.dispatcher` — 回复分发器实例（由 `createReplyDispatcher` 或 `createReplyDispatcherWithTyping` 创建）
  - `params.run` — 主逻辑函数（通常是 agent 执行，返回 Promise）
  - `params.onSettled?` — 所有回复发送完毕后的可选清理回调（如停止打字指示器）
- **返回**：`run()` 的返回值 `T`
- **执行顺序**（finally 块，无论正常/异常）：
  1. `dispatcher.markComplete()` — 标记主逻辑已完成，dispatcher 不再接受新回复入队
  2. `dispatcher.waitForIdle()` — 等待所有已入队回复异步发送完毕
  3. `params.onSettled?.()` — 执行清理回调
- **注意**：`onSettled` 在 `waitForIdle` 之后的 finally 块中执行，即使 `waitForIdle` 抛出也会被调用。

---

#### `dispatchInboundMessage`

- **位置**：`src/auto-reply/dispatch.ts:63`
- **签名**：
  ```ts
  export async function dispatchInboundMessage(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  }): Promise<DispatchInboundResult>
  ```
- **说明**：标准入站消息分发路径。接受已创建的 dispatcher，完成消息上下文最终化、路由解析、agent 执行和回复分发的完整流程。
- **参数**：
  - `params.ctx` — 入站消息上下文（`MsgContext` 或已最终化的 `FinalizedMsgContext`；前者会在函数内部通过 `finalizeInboundContext` 最终化）
  - `params.cfg` — 当前 OpenClaw 配置
  - `params.dispatcher` — 预先创建的回复分发器（调用方负责创建和生命周期管理）
  - `params.replyOptions?` — 可选的回复选项，排除了 `onToolResult` 和 `onBlockReply`（这两个由 dispatcher 内部管理）
  - `params.replyResolver?` — 可选的自定义回复生成函数，主要用于测试替换真实 agent 调用
- **返回**：`DispatchInboundResult`
- **执行流程**：
  1. `finalizeInboundContext(ctx)` — 最终化消息上下文（补充时间戳等）
  2. `withReplyDispatcher` 包装 → `dispatchReplyFromConfig(...)` — 路由+执行+分发
- **适用场景**：调用方已拥有 dispatcher 实例（如渠道适配器在外层管理 dispatcher 生命周期）。

---

#### `dispatchInboundMessageWithBufferedDispatcher`

- **位置**：`src/auto-reply/dispatch.ts:96`
- **签名**：
  ```ts
  export async function dispatchInboundMessageWithBufferedDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  }): Promise<DispatchInboundResult>
  ```
- **说明**：带打字指示器生命周期管理的入站消息分发路径。内部创建带 typing 状态的 dispatcher，并在 finally 块中调用 `markDispatchIdle()` 停止打字指示器。
- **参数**：
  - `params.ctx` — 入站消息上下文
  - `params.cfg` — 当前 OpenClaw 配置
  - `params.dispatcherOptions` — 含打字配置的 dispatcher 选项（`ReplyDispatcherWithTypingOptions`，包含渠道、accountId、typing 回调等）
  - `params.replyOptions?` — 可选的回复选项（会与 `dispatcherOptions` 内部派生的 replyOptions 合并，外部传入的优先级更高）
  - `params.replyResolver?` — 可选的自定义回复生成函数
- **返回**：`DispatchInboundResult`
- **与 `dispatchInboundMessage` 的区别**：
  - 内部通过 `createReplyDispatcherWithTyping` 自动创建 dispatcher（含打字状态管理）
  - finally 块中额外调用 `markDispatchIdle()` 停止打字指示器
  - 合并了 `dispatcherOptions` 中的 replyOptions（外部传入的 `replyOptions` 字段覆盖 options 内部的）
- **适用场景**：渠道支持打字指示器（如 Telegram `sendChatAction("typing")`、Discord typing）且需要自动管理 typing 状态的场景。

---

#### `dispatchInboundMessageWithDispatcher`

- **位置**：`src/auto-reply/dispatch.ts:130`
- **签名**：
  ```ts
  export async function dispatchInboundMessageWithDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  }): Promise<DispatchInboundResult>
  ```
- **说明**：不带打字指示器的入站消息分发路径，内部按选项创建 dispatcher。等价于 `createReplyDispatcher(opts)` + `dispatchInboundMessage(...)`，是最简便的调用方式。
- **参数**：
  - `params.ctx` — 入站消息上下文
  - `params.cfg` — 当前 OpenClaw 配置
  - `params.dispatcherOptions` — dispatcher 创建选项（`ReplyDispatcherOptions`）
  - `params.replyOptions?` — 可选的回复选项
  - `params.replyResolver?` — 可选的自定义回复生成函数
- **返回**：`DispatchInboundResult`
- **与其他 dispatch 函数的关系**：

  ```
  dispatchInboundMessageWithDispatcher
    └─ createReplyDispatcher(opts)
    └─ dispatchInboundMessage(...)
         └─ finalizeInboundContext(ctx)
         └─ withReplyDispatcher(...)
              └─ dispatchReplyFromConfig(...)

  dispatchInboundMessageWithBufferedDispatcher
    └─ createReplyDispatcherWithTyping(opts)  ← 含 typing 管理
    └─ dispatchInboundMessage(...)
    └─ finally: markDispatchIdle()            ← 停止 typing
  ```

- **适用场景**：不需要打字指示器，但也不需要在外部管理 dispatcher 实例的场景（如 webhook 处理、cron 触发）。

---

## 关键机制说明

### 路由优先级详解

`resolveAgentRoute` 使用**有序层级匹配**（tiers 数组），按序遍历，首个匹配立即返回：

```
入站消息
│
├─ 1. binding.peer         ← peer 精确匹配（最高优先级）
├─ 2. binding.peer.parent  ← 线程父 peer 回退
├─ 3. binding.guild+roles  ← guild + 角色组合
├─ 4. binding.guild        ← 仅 guild
├─ 5. binding.team         ← team 匹配
├─ 6. binding.account      ← accountId 非通配符
├─ 7. binding.channel      ← accountId 为 "*"（渠道级）
└─ 8. default              ← 配置默认 agent
```

每个层级通过两个条件共同筛选：
- **predicate**：binding 自身的约束类型（如是否有 peer 约束、是否有 roles 约束）
- **matchesBindingScope**：binding 约束与当前消息上下文的精确匹配

### 会话 Key 格式说明

会话 key 是 OpenClaw 内部用于标识一个持久对话上下文的字符串，格式取决于 peer 类型和 `dmScope` 配置：

```
# 主会话（DM 折叠，所有私聊共用，dmScope=main）
agent:{agentId}:main

# 私聊 — 按 peer 隔离（dmScope=per-peer）
agent:{agentId}:direct:{peerId}

# 私聊 — 按渠道+peer 隔离（dmScope=per-channel-peer）
agent:{agentId}:{channel}:direct:{peerId}

# 私聊 — 完全隔离（dmScope=per-account-channel-peer）
agent:{agentId}:{channel}:{accountId}:direct:{peerId}

# 群组/频道消息（不受 dmScope 影响）
agent:{agentId}:{channel}:{group|channel}:{peerId}

# 线程（在上述基础上追加）
{baseSessionKey}:thread:{threadId}
```

所有 key 均为全小写。`{agentId}` 经 `normalizeAgentId` 处理，只含 `[a-z0-9_-]`，不超过 64 字符。

### Binding 缓存机制

`getEvaluatedBindingsForChannelAccount` 使用两级缓存避免每次消息都重新遍历和规范化所有 binding：

- **WeakMap 外层**：以 `OpenClawConfig` 对象为 key，配置热重载（新对象）时自动失效，无需手动清除。
- **Map 内层**：以 `"channel\taccountId"` 为 key，上限 2000 条（`MAX_EVALUATED_BINDINGS_CACHE_KEYS`），超出时清空重建（简单 LRU 近似）。

### Identity Links（跨渠道身份合并）

`resolveLinkedPeerId` 实现跨渠道同一用户使用同一 agent 会话的能力。配置示例：

```yaml
session:
  dmScope: per-peer
  identityLinks:
    alice:
      - telegram:123456    # Telegram user ID
      - discord:987654     # Discord user ID
```

当 `telegram:123456` 发来消息时，`resolveLinkedPeerId` 找到 canonical 名称 `alice`，会话 key 变为 `agent:{id}:direct:alice`，与 Discord 的 `987654` 共享同一会话历史。

### Dispatch 函数选择指南

| 场景 | 推荐函数 |
|---|---|
| 渠道支持打字指示器 | `dispatchInboundMessageWithBufferedDispatcher` |
| 不需要打字，dispatcher 由外部管理 | `dispatchInboundMessage` |
| 不需要打字，按需创建 dispatcher | `dispatchInboundMessageWithDispatcher` |
| 测试中替换 agent 执行逻辑 | 任一函数 + `replyResolver` 参数 |
