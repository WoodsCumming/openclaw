# Channels 模块 API 参考

> 源码路径：`src/channels/`

## 概述

渠道系统（Channels）是 OpenClaw 连接外部消息平台的适配器层。每个消息平台（WhatsApp、Telegram、Slack、Discord、Signal、iMessage、Microsoft Teams、Google Chat、Matrix、Zalo 等）均以 **ChannelPlugin** 的形式接入。

渠道层在整体架构中的位置：

```
外部消息平台
     ↕  ChannelPlugin（适配器插件）
Gateway（WebSocket 控制面）
     ↕
Agent / Pi Runtime
```

插件加载流程：扩展包（`extensions/*/`）或配置路径中的插件在运行时通过 `requireActivePluginRegistry()` 注册，由 `src/channels/plugins/index.ts` 统一管理查询。

---

## `types.plugin.ts` — ChannelPlugin 接口

> 源文件：`src/channels/plugins/types.plugin.ts`

### 辅助类型

#### `ChannelConfigUiHint`

- **位置**：`types.plugin.ts:33`
- **说明**：为渠道配置字段提供 UI 展示提示，供前端/CLI 向导使用。
- **字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `label` | `string?` | 字段显示标签 |
| `help` | `string?` | 帮助文本 |
| `tags` | `string[]?` | 分类标签 |
| `advanced` | `boolean?` | 是否为高级选项（默认折叠） |
| `sensitive` | `boolean?` | 是否为敏感字段（如密码，输入时掩码） |
| `placeholder` | `string?` | 输入框占位文本 |
| `itemTemplate` | `unknown?` | 列表项模板 |

#### `ChannelConfigSchema`

- **位置**：`types.plugin.ts:43`
- **说明**：渠道配置的 JSON Schema 描述，用于 UI 自动生成表单。
- **字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `schema` | `Record<string, unknown>` | JSON Schema 对象 |
| `uiHints` | `Record<string, ChannelConfigUiHint>?` | 各字段的 UI 提示（key 与 schema 属性名对应） |

---

### 核心接口

#### `ChannelPlugin<ResolvedAccount, Probe, Audit>`

- **位置**：`types.plugin.ts:49`
- **说明**：每个渠道插件必须满足的完整契约类型。`ResolvedAccount` 为渠道特定的账户对象类型（如 `TelegramAccount`），`Probe` 为健康探测结果类型，`Audit` 为配置审计结果类型。

插件在 `src/channels/plugins/<id>.ts`（或扩展包中）实现此接口后，由插件加载器注册到运行时注册表。

#### 所有字段（共 22 个），按功能分组

**标识与元信息（必须实现）**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `id` | `ChannelId` | `:50` | 渠道唯一标识符，如 `"telegram"`、`"whatsapp"`（不可重复） |
| `meta` | `ChannelMeta` | `:51` | 渠道元数据：标签、文档路径、介绍文本、排序权重等 |
| `capabilities` | `ChannelCapabilities` | `:52` | 渠道能力声明：支持的聊天类型、投票、反应、编辑、撤回等 |

**配置管理（必须实现）**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `config` | `ChannelConfigAdapter<ResolvedAccount>` | `:61` | 账户配置的核心适配器，负责账户枚举、解析、状态判断等（必须实现） |
| `configSchema` | `ChannelConfigSchema?` | `:62` | 配置字段的 JSON Schema（可选，供 UI 自动生成表单） |

**初始化与设置（可选）**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `defaults` | `{ queue?: { debounceMs?: number } }?` | `:53` | 渠道级默认参数，目前支持消息队列防抖时间 |
| `reload` | `{ configPrefixes: string[]; noopPrefixes?: string[] }?` | `:58` | 触发热重载的配置键前缀；`noopPrefixes` 中的变化无需重载 |
| `onboarding` | `ChannelOnboardingAdapter?` | `:60` | CLI `openclaw onboard` 向导钩子（引导用户完成账户配置） |
| `setup` | `ChannelSetupAdapter?` | `:63` | 账户初始化向导适配器（解析/应用配置输入） |

**消息处理**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `messaging` | `ChannelMessagingAdapter?` | `:77` | 消息目标标准化、ID 格式判断、目标显示格式化 |
| `outbound` | `ChannelOutboundAdapter?` | `:68` | 出站消息发送（文本/媒体/投票），含分块策略和发送模式 |
| `streaming` | `ChannelStreamingAdapter?` | `:75` | 流式输出的聚合参数（最小字符数、空闲等待时间） |
| `mentions` | `ChannelMentionAdapter?` | `:67` | @提及的剥离规则（去除消息中对 Bot 的 @) |
| `actions` | `ChannelMessageActionAdapter?` | `:81` | 消息动作（发送/编辑/删除/反应等 Agent 工具操作） |

**安全与访问控制**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `security` | `ChannelSecurityAdapter<ResolvedAccount>?` | `:65` | DM 策略解析与安全告警收集 |
| `pairing` | `ChannelPairingAdapter?` | `:64` | 用户配对：ID 标签、入口标准化、配对审批通知 |
| `elevated` | `ChannelElevatedAdapter?` | `:73` | 获取 allow-from 兜底列表（用于提权命令判断） |

**Gateway 生命周期**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `gateway` | `ChannelGatewayAdapter<ResolvedAccount>?` | `:71` | 账户连接启动/停止、QR 登录、账户登出 |
| `gatewayMethods` | `string[]?` | `:70` | 声明此渠道通过 Gateway 暴露的额外 RPC 方法名称列表 |
| `auth` | `ChannelAuthAdapter?` | `:72` | CLI 登录命令钩子（`openclaw channels login`） |
| `heartbeat` | `ChannelHeartbeatAdapter?` | `:82` | 定期心跳检测（验证连接活跃性，失败则触发重连） |

**群组与线程**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `groups` | `ChannelGroupAdapter?` | `:66` | 群组上下文：是否强制 @提及、介绍提示、工具策略 |
| `threading` | `ChannelThreadingAdapter?` | `:76` | 回复模式（off/first/all）及线程工具上下文构建 |

**发现与路由**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `status` | `ChannelStatusAdapter<ResolvedAccount, Probe, Audit>?` | `:69` | 健康探测、审计、快照构建、状态问题收集 |
| `directory` | `ChannelDirectoryAdapter?` | `:79` | 联系人/群组目录查询（供 `openclaw channels directory` 使用） |
| `resolver` | `ChannelResolverAdapter?` | `:80` | 将人类可读名称/用户名解析为渠道内部 ID |
| `agentPrompt` | `ChannelAgentPromptAdapter?` | `:78` | 为 Agent 系统提示注入渠道特定工具用法提示 |
| `commands` | `ChannelCommandAdapter?` | `:74` | 渠道命令行为配置（是否强制 owner 验证、空配置跳过等） |

**Agent 工具**

| 字段 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `agentTools` | `ChannelAgentToolFactory \| ChannelAgentTool[]?` | `:84` | 渠道自有的 Agent 工具（如登录流程工具），可为工厂函数或静态数组 |

---

## `types.adapters.ts` — 适配器接口详解

> 源文件：`src/channels/plugins/types.adapters.ts`

---

### `ChannelSetupAdapter`

- **位置**：`types.adapters.ts:33`
- **调用时机**：`openclaw channels setup` 或 `openclaw onboard` 初始化账户时调用。在账户首次配置阶段，向导通过此适配器将用户输入写入配置文件。

| 方法 | 必须 | 说明 |
|------|------|------|
| `resolveAccountId(params)` | 否 | 从向导输入推断账户 ID；未提供则使用 `input.accountId` |
| `resolveBindingAccountId(params)` | 否 | 从绑定配置（已有 agentId + accountId）推断账户 ID |
| `applyAccountName(params)` | 否 | 将账户显示名写入配置 |
| `applyAccountConfig(params)` | **是** | 将向导输入（`ChannelSetupInput`）应用到配置，返回更新后的 `OpenClawConfig` |
| `validateInput(params)` | 否 | 验证向导输入合法性；返回错误字符串或 `null`（通过） |

---

### `ChannelConfigAdapter<ResolvedAccount>`

- **位置**：`types.adapters.ts:73`
- **调用时机**：贯穿渠道整个生命周期。账户枚举、解析在 Gateway 启动、状态查询、消息路由时均会调用；`isEnabled`/`isConfigured` 在状态检查时调用；`describeAccount` 在 `openclaw channels status` 时调用；`resolveAllowFrom` 在每次入站消息安全检查时调用。

每个渠道插件必须实现此适配器。

| 方法/属性 | 必须 | 说明 |
|-----------|------|------|
| `listAccountIds(cfg)` | **是** | 枚举配置文件中所有账户 ID（用于多账户支持） |
| `resolveAccount(cfg, accountId?)` | **是** | 将配置解析为类型化 `ResolvedAccount` 对象 |
| `defaultAccountId?(cfg)` | 否 | 返回默认账户 ID（当调用者未指定时使用） |
| `setAccountEnabled?(params)` | 否 | 启用/禁用指定账户，返回更新后的配置 |
| `deleteAccount?(params)` | 否 | 从配置中删除指定账户 |
| `isEnabled?(account, cfg)` | 否 | 判断账户是否已启用（未实现则视为启用） |
| `disabledReason?(account, cfg)` | 否 | 返回账户被禁用的原因说明 |
| `isConfigured?(account, cfg)` | 否 | 判断账户是否已完成必要配置（支持异步） |
| `unconfiguredReason?(account, cfg)` | 否 | 返回账户未配置完成的原因说明 |
| `describeAccount?(account, cfg)` | 否 | 生成账户运行时快照（`ChannelAccountSnapshot`），用于 `status` 命令显示 |
| `resolveAllowFrom?(params)` | 否 | 获取允许触发 Agent 的用户 ID 列表（入站消息安全边界） |
| `formatAllowFrom?(params)` | 否 | 将 allow-from ID 列表格式化为可读字符串（用于 UI 显示） |
| `resolveDefaultTo?(params)` | 否 | 返回出站消息的默认收件人 ID |

---

### `ChannelGroupAdapter`

- **位置**：`types.adapters.ts:103`
- **调用时机**：入站群组消息处理时调用。在 Gateway 处理群消息前，通过此适配器决定是否强制需要 @提及、获取群简介提示、获取工具权限策略。

| 方法 | 说明 |
|------|------|
| `resolveRequireMention?(params)` | 是否要求消息必须 @提及 Bot 才处理；返回 `undefined` 则使用全局配置 |
| `resolveGroupIntroHint?(params)` | 返回群组介绍提示字符串（注入 Agent 系统提示） |
| `resolveToolPolicy?(params)` | 返回该群组的工具权限策略配置 |

参数类型为 `ChannelGroupContext`（含 `cfg`、`groupId`、`groupChannel`、`groupSpace`、`accountId`、`senderId` 等字段）。

---

### `ChannelOutboundAdapter`

- **位置**：`types.adapters.ts:142`
- **调用时机**：Agent 回复生成后，出站消息发送阶段调用。`sendText`/`sendMedia`/`sendPayload` 在 `OutboundDelivery` 执行时调用；`sendPoll` 在 Agent 发起投票时调用；`chunker` 在消息超出平台字符限制时自动触发。

| 字段/方法 | 必须 | 说明 |
|-----------|------|------|
| `deliveryMode` | **是** | 发送模式：`"direct"`（直接调用渠道 API）、`"gateway"`（通过 WebSocket 转发）、`"hybrid"` |
| `chunker?` | 否 | 长文本分块函数；`null` 表示禁用分块 |
| `chunkerMode?` | 否 | 分块模式：`"text"` 或 `"markdown"`（影响分块边界选择） |
| `textChunkLimit?` | 否 | 单条消息最大字符数（超出则触发 `chunker`） |
| `pollMaxOptions?` | 否 | 投票选项最大数量限制 |
| `resolveTarget?(params)` | 否 | 将目标标识符解析为最终发送地址；返回 `{ok: true, to}` 或 `{ok: false, error}` |
| `sendText?(ctx)` | 否 | 发送纯文本消息，返回 `OutboundDeliveryResult` |
| `sendMedia?(ctx)` | 否 | 发送媒体消息（图片、文件、音频等） |
| `sendPayload?(ctx)` | 否 | 发送通用 payload（含格式化内容 `ReplyPayload`） |
| `sendPoll?(ctx)` | 否 | 发送投票消息（需渠道 `capabilities.polls = true`） |

---

### `ChannelStatusAdapter<ResolvedAccount, Probe, Audit>`

- **位置**：`types.adapters.ts:167`
- **调用时机**：`openclaw channels status` 命令执行时调用。`--probe` 标志触发 `probeAccount`；`--deep` 标志追加 `auditAccount`；`buildAccountSnapshot` 将探测结果合并为展示快照；`collectStatusIssues` 汇总所有账户的问题列表。

| 方法/属性 | 说明 |
|-----------|------|
| `defaultRuntime?` | 账户尚未启动时使用的默认运行时快照（避免空快照） |
| `buildChannelSummary?(params)` | 构建渠道级汇总信息（跨账户聚合数据） |
| `probeAccount?(params)` | 主动探测账户连接状态（网络请求/API 验证），返回类型化 `Probe` |
| `auditAccount?(params)` | 审计账户配置（权限检查、配置完整性），返回类型化 `Audit` |
| `buildAccountSnapshot?(params)` | 将账户信息、探测结果、审计结果合并为 `ChannelAccountSnapshot` |
| `logSelfId?(params)` | 在日志中输出渠道自身标识（Bot ID/用户名） |
| `resolveAccountState?(params)` | 综合 `configured`/`enabled` 等状态，返回 `ChannelAccountState` 枚举值 |
| `collectStatusIssues?(accounts)` | 遍历所有账户快照，收集 `ChannelStatusIssue` 问题列表（用于状态告警显示） |

---

### `ChannelGatewayAdapter<ResolvedAccount>`

- **位置**：`types.adapters.ts:262`
- **调用时机**：Gateway 启动/停止时管理账户连接生命周期。`startAccount` 在 `createChannelManager` 调用时执行；`stopAccount` 在 Gateway 关闭或账户禁用时执行；QR 登录方法在 CLI `openclaw channels login` 交互流程中调用。

| 方法 | 说明 |
|------|------|
| `startAccount?(ctx)` | 启动渠道账户连接（建立 WebSocket、轮询等），接收 `ChannelGatewayContext` |
| `stopAccount?(ctx)` | 停止渠道账户连接，清理资源 |
| `loginWithQrStart?(params)` | 发起 QR 码登录流程（生成 QR 码），返回 `ChannelLoginWithQrStartResult`（含 `qrDataUrl`） |
| `loginWithQrWait?(params)` | 等待 QR 码扫描完成，轮询状态，返回 `ChannelLoginWithQrWaitResult`（含 `connected` 标志） |
| `logoutAccount?(ctx)` | 登出账户并清理会话，返回 `ChannelLogoutResult`（含 `cleared`/`loggedOut` 标志） |

`ChannelGatewayContext` 包含：`cfg`、`accountId`、`account`、`runtime`、`abortSignal`、`log`（日志接收器）、`getStatus()`/`setStatus()`（运行时快照读写）。

---

### `ChannelAuthAdapter`

- **位置**：`types.adapters.ts:278`
- **调用时机**：`openclaw channels login` CLI 命令执行时调用，用于需要独立登录流程（非 QR 码）的渠道（如 OAuth 回调流程）。

| 方法 | 说明 |
|------|------|
| `login?(params)` | 执行渠道登录，参数含 `cfg`、`accountId`、`runtime`、`verbose`、`channelInput`（渠道特定输入） |

---

### `ChannelHeartbeatAdapter`

- **位置**：`types.adapters.ts:292`
- **调用时机**：Gateway 运行期间定期调用（由 cron/定时器驱动）。`checkReady` 失败时触发重连逻辑；`resolveRecipients` 在心跳探针消息发送时使用。

| 方法 | 说明 |
|------|------|
| `checkReady?(params)` | 检测渠道连接是否仍然活跃，返回 `{ok: boolean, reason: string}` |
| `resolveRecipients?(params)` | 解析心跳探针消息的收件人列表，返回 `{recipients: string[], source: string}` |

---

### `ChannelDirectoryAdapter`

- **位置**：`types.adapters.ts:333`
- **调用时机**：`openclaw channels directory` 命令执行时调用，按需查询联系人/群组目录。`*Live` 变体表示跳过缓存，直接查询渠道实时数据。

| 方法 | 说明 |
|------|------|
| `self?(params)` | 获取当前账户的身份信息（`ChannelDirectoryEntry`），参数含 `cfg`、`accountId`、`runtime` |
| `listPeers?(params)` | 列出联系人列表（支持 `query` 关键字搜索、`limit` 限制数量） |
| `listPeersLive?(params)` | 列出联系人列表（实时，跳过缓存） |
| `listGroups?(params)` | 列出群组列表 |
| `listGroupsLive?(params)` | 列出群组列表（实时） |
| `listGroupMembers?(params)` | 列出指定 `groupId` 的群组成员 |

---

### `ChannelResolverAdapter`

- **位置**：`types.adapters.ts:354`
- **调用时机**：`openclaw message send` 或其他需要将人类可读标识符（用户名/手机号/显示名）解析为渠道内部 ID 时调用。

| 方法 | 说明 |
|------|------|
| `resolveTargets(params)` | 批量解析输入列表，返回 `ChannelResolveResult[]`（含 `input`、`resolved`、`id`、`name`、`note`） |

`kind` 参数为 `"user" | "group"`，指定解析目标类型。

---

### `ChannelElevatedAdapter`

- **位置**：`types.adapters.ts:364`
- **调用时机**：执行提权命令（需 owner 验证）时调用，提供 allow-from 兜底列表（当主配置未设置时使用）。

| 方法 | 说明 |
|------|------|
| `allowFromFallback?(params)` | 返回提权命令的 allow-from 兜底 ID 列表（`Array<string \| number>` 或 `undefined`） |

---

### `ChannelCommandAdapter`

- **位置**：`types.adapters.ts:371`
- **调用时机**：渠道命令处理器初始化时读取，影响所有命令的执行行为。

| 字段 | 类型 | 说明 |
|------|------|------|
| `enforceOwnerForCommands?` | `boolean` | 是否强制所有命令校验发送者为 owner（增强安全性） |
| `skipWhenConfigEmpty?` | `boolean` | 配置为空时跳过命令处理（避免未配置渠道误触发） |

---

### `ChannelSecurityAdapter<ResolvedAccount>`

- **位置**：`types.adapters.ts:381`
- **调用时机**：每条入站消息安全检查时调用。`resolveDmPolicy` 在处理私聊消息前调用，决定 DM 处理策略；`collectWarnings` 在 `openclaw channels status` 时收集安全告警。

| 方法 | 说明 |
|------|------|
| `resolveDmPolicy?(ctx)` | 解析 DM 消息处理策略，返回 `ChannelSecurityDmPolicy`（含策略名、allow-from 路径、审批提示）或 `null` |
| `collectWarnings?(ctx)` | 收集当前账户的安全告警字符串列表（支持异步） |

---

## `types.core.ts` — 核心基础类型

> 源文件：`src/channels/plugins/types.core.ts`（供适配器类型引用，非直接导出给插件作者）

### 关键类型速查

#### `ChannelId`

- **位置**：`types.core.ts:11`
- 渠道唯一标识符，基于 `ChatChannelId` 联合类型扩展（允许自定义字符串）。

#### `ChannelMeta`

- **位置**：`types.core.ts:76`
- 渠道元数据。关键字段：`id`、`label`（显示名）、`selectionLabel`（选择器标签）、`docsPath`（文档路径）、`blurb`（简介）、`order`（排序权重）、`aliases`（别名列表）。
- 行为标志：`showConfigured`、`quickstartAllowFrom`、`forceAccountBinding`、`preferSessionLookupForAnnounceTarget`、`preferOver`（优先级覆盖列表）。

#### `ChannelCapabilities`

- **位置**：`types.core.ts:171`
- 渠道能力声明对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `chatTypes` | `Array<ChatType \| "thread">` | 支持的聊天类型（`"dm"`, `"group"`, `"thread"` 等） |
| `polls?` | `boolean` | 支持发送投票 |
| `reactions?` | `boolean` | 支持消息反应（emoji） |
| `edit?` | `boolean` | 支持编辑消息 |
| `unsend?` | `boolean` | 支持撤回消息 |
| `reply?` | `boolean` | 支持回复消息 |
| `effects?` | `boolean` | 支持消息特效 |
| `groupManagement?` | `boolean` | 支持群组管理操作 |
| `threads?` | `boolean` | 支持线程（子话题） |
| `media?` | `boolean` | 支持发送媒体文件 |
| `nativeCommands?` | `boolean` | 支持渠道原生命令（如 Telegram BotCommand） |
| `blockStreaming?` | `boolean` | 支持流式输出的块聚合发送 |

#### `ChannelAccountSnapshot`

- **位置**：`types.core.ts:97`
- 账户运行时状态快照，由 `ChannelStatusAdapter.buildAccountSnapshot` 生成，供 `openclaw channels status` 展示。包含连接状态（`connected`、`running`、`linked`）、时间戳（`lastConnectedAt`、`lastMessageAt` 等）、配置来源（`tokenSource`、`credentialSource` 等）、探测/审计结果（`probe`、`audit`）。

#### `ChannelSetupInput`

- **位置**：`types.core.ts:21`
- 向导输入数据结构，汇聚所有渠道可能需要的配置字段：`token`、`botToken`、`appToken`、`signalNumber`、`homeserver`、`accessToken`、`webhookUrl` 等（约 25 个字段）。

#### `ChannelStatusIssue`

- **位置**：`types.core.ts:55`
- 状态问题描述：`channel`、`accountId`、`kind`（`"intent" | "permissions" | "config" | "auth" | "runtime"`）、`message`、`fix`（修复建议）。

#### `ChannelAccountState`

- **位置**：`types.core.ts:63`
- 账户状态枚举：`"linked" | "not linked" | "configured" | "not configured" | "enabled" | "disabled"`。

#### `ChannelLogSink`

- **位置**：`types.core.ts:151`
- 日志接收器接口：`info`、`warn`、`error`、`debug?` 方法，供 Gateway 适配器内部使用。

#### `ChannelMessagingAdapter`

- **位置**：`types.core.ts:274`
- **调用时机**：出站消息目标解析时调用（`openclaw message send` 或 Agent 发送消息时）。

| 方法/属性 | 说明 |
|-----------|------|
| `normalizeTarget?(raw)` | 将原始目标字符串标准化（如去除 `@`、格式化 JID） |
| `targetResolver?` | 包含 `looksLikeId?(raw, normalized)` 和 `hint?`，用于判断输入是否已是 ID 格式 |
| `formatTargetDisplay?(params)` | 格式化目标展示名称（显示时使用，区分用户/群组/频道） |

#### `ChannelMentionAdapter`

- **位置**：`types.core.ts:201`
- **调用时机**：入站消息预处理阶段，在将消息文本传给 Agent 之前剥离 @提及。

| 方法 | 说明 |
|------|------|
| `stripPatterns?(params)` | 返回需要从消息中移除的正则/字符串模式列表 |
| `stripMentions?(params)` | 直接对消息文本执行 @提及剥离，返回处理后的文本 |

#### `ChannelStreamingAdapter`

- **位置**：`types.core.ts:215`
- **调用时机**：流式 Agent 回复输出时，控制块聚合行为（避免发送过多碎片消息）。

| 字段 | 说明 |
|------|------|
| `blockStreamingCoalesceDefaults?` | `{ minChars: number; idleMs: number }` — 块聚合默认参数（最小字符数触发、空闲毫秒数触发） |

#### `ChannelThreadingAdapter`

- **位置**：`types.core.ts:222`
- **调用时机**：出站消息发送前，决定是否附加 `replyToId`（线程回复）；`buildToolContext` 在 Agent 工具调用时为工具提供线程上下文。

| 方法/属性 | 说明 |
|-----------|------|
| `resolveReplyToMode?(params)` | 返回回复模式：`"off"`（不自动回复）、`"first"`（仅首条）、`"all"`（每条都回复） |
| `allowExplicitReplyTagsWhenOff?` | `replyToMode` 为 `"off"` 时，是否允许显式 reply 标签覆盖 |
| `allowTagsWhenOff?` | `allowExplicitReplyTagsWhenOff` 的已废弃别名（保留兼容性） |
| `buildToolContext?(params)` | 构建 `ChannelThreadingToolContext`（含 `currentChannelId`、`currentThreadTs`、`replyToMode` 等） |

#### `ChannelAgentPromptAdapter`

- **位置**：`types.core.ts:287`
- **调用时机**：Agent 会话系统提示构建时调用，注入渠道特定的工具使用说明。

| 方法 | 说明 |
|------|------|
| `messageToolHints?(params)` | 返回字符串列表，注入 Agent 系统提示（如"发送消息时使用 send_message 工具"） |

#### `ChannelMessageActionAdapter`

- **位置**：`types.core.ts:334`
- **调用时机**：Agent 执行渠道动作工具（如发送消息、编辑消息、添加反应）时调用。

| 方法 | 说明 |
|------|------|
| `listActions?(params)` | 列出此渠道支持的所有动作名称（`ChannelMessageActionName` 枚举值） |
| `supportsAction?(params)` | 判断是否支持特定动作 |
| `supportsButtons?(params)` | 是否支持按钮类交互消息 |
| `supportsCards?(params)` | 是否支持卡片类富文本消息 |
| `extractToolSend?(params)` | 从工具参数中提取发送目标（`{to, accountId}`） |
| `handleAction?(ctx)` | 执行具体动作，返回 `AgentToolResult` |

---

## `onboarding-types.ts` — 向导适配器

> 源文件：`src/channels/plugins/onboarding-types.ts`

### `ChannelOnboardingAdapter`

- **位置**：`onboarding-types.ts:86`
- **调用时机**：`openclaw onboard` CLI 命令执行时，按渠道依次调用向导流程。`getStatus` 在选择渠道前展示当前状态；`configure` 执行非交互式配置（CI/脚本场景）；`configureInteractive` 执行交互式向导；`disable` 在用户取消选择时调用。

| 方法/属性 | 必须 | 说明 |
|-----------|------|------|
| `channel` | **是** | 渠道 ID（与 `ChannelPlugin.id` 对应） |
| `getStatus(ctx)` | **是** | 返回 `ChannelOnboardingStatus`（含 `configured`、`statusLines`、`selectionHint`、`quickstartScore`） |
| `configure(ctx)` | **是** | 执行账户配置，返回 `ChannelOnboardingResult`（含更新后的 `cfg` 和 `accountId`） |
| `configureInteractive?(ctx)` | 否 | 交互式配置，返回 `ChannelOnboardingConfiguredResult`（可返回 `"skip"` 跳过） |
| `configureWhenConfigured?(ctx)` | 否 | 账户已配置时的重配置向导（修改已有账户） |
| `dmPolicy?` | 否 | DM 策略配置（`ChannelOnboardingDmPolicy`，含策略选择和 allow-from 设置） |
| `onAccountRecorded?` | 否 | 账户 ID 确定后的回调（用于跨渠道协调，如 WhatsApp 账户绑定） |
| `disable?(cfg)` | 否 | 用户取消选择时清理配置，返回更新后的 `OpenClawConfig` |

---

## `index.ts` — 插件注册表 API

> 源文件：`src/channels/plugins/index.ts`

此模块是运行时渠道查询的统一入口，故意设计为"重量级"（插件可能引入渠道监视器、Web 登录等依赖）。**共享代码路径**（回复流、命令鉴权、沙箱解释）应依赖 `src/channels/dock.ts`，仅在执行边界调用 `getChannelPlugin()`。

### 导出函数

#### `listChannelPlugins()`

- **位置**：`index.ts:31`
- **说明**：返回所有已注册渠道插件的有序列表。排序规则：优先使用插件 `meta.order`；未设置则按 `CHAT_CHANNEL_ORDER` 全局顺序；仍相同则按 `id` 字母序。自动去重（相同 `id` 仅保留首次注册的插件）。
- **签名**：`listChannelPlugins(): ChannelPlugin[]`

#### `getChannelPlugin(id: ChannelId)`

- **位置**：`index.ts:45`
- **说明**：按 ID 查找已注册渠道插件。空字符串直接返回 `undefined`。
- **签名**：`getChannelPlugin(id: ChannelId): ChannelPlugin | undefined`

#### `normalizeChannelId(raw?: string | null)`

- **位置**：`index.ts:53`
- **说明**：将原始渠道 ID 字符串标准化（委托给 `src/channels/registry.ts` 的 `normalizeAnyChannelId`）。调用前需确保插件注册表已初始化。
- **签名**：`normalizeChannelId(raw?: string | null): ChannelId | null`

### 目录配置 Re-exports（来自 `directory-config.ts`）

以下函数从内置渠道配置中读取目录条目（联系人/群组），无需调用运行时渠道 API：

| 函数名 | 说明 |
|--------|------|
| `listTelegramDirectoryPeersFromConfig(cfg)` | 从配置读取 Telegram 联系人列表 |
| `listTelegramDirectoryGroupsFromConfig(cfg)` | 从配置读取 Telegram 群组列表 |
| `listDiscordDirectoryPeersFromConfig(cfg)` | 从配置读取 Discord 联系人列表 |
| `listDiscordDirectoryGroupsFromConfig(cfg)` | 从配置读取 Discord 群组列表 |
| `listSlackDirectoryPeersFromConfig(cfg)` | 从配置读取 Slack 联系人列表 |
| `listSlackDirectoryGroupsFromConfig(cfg)` | 从配置读取 Slack 群组列表 |
| `listWhatsAppDirectoryPeersFromConfig(cfg)` | 从配置读取 WhatsApp 联系人列表 |
| `listWhatsAppDirectoryGroupsFromConfig(cfg)` | 从配置读取 WhatsApp 群组列表 |

### 渠道匹配配置 Re-exports（来自 `channel-config.ts`）

| 导出项 | 类型 | 说明 |
|--------|------|------|
| `resolveChannelMatchConfig(params)` | 函数 | 解析渠道匹配配置 |
| `resolveChannelEntryMatch(params)` | 函数 | 解析单条渠道条目匹配结果 |
| `resolveChannelEntryMatchWithFallback(params)` | 函数 | 带回退策略的渠道条目匹配 |
| `resolveNestedAllowlistDecision(params)` | 函数 | 解析嵌套 allowlist 决策 |
| `applyChannelMatchMeta(params)` | 函数 | 应用渠道匹配元数据 |
| `buildChannelKeyCandidates(params)` | 函数 | 构建渠道 key 候选列表 |
| `normalizeChannelSlug(slug)` | 函数 | 标准化渠道 slug 字符串 |
| `ChannelEntryMatch` | 类型 | 渠道条目匹配结果类型 |
| `ChannelMatchSource` | 类型 | 渠道匹配来源类型 |

### Allowlist Re-exports（来自 `allowlist-match.ts`）

| 导出项 | 类型 | 说明 |
|--------|------|------|
| `formatAllowlistMatchMeta(params)` | 函数 | 格式化 allowlist 匹配元信息 |
| `AllowlistMatch` | 类型 | Allowlist 匹配结果类型 |
| `AllowlistMatchSource` | 类型 | Allowlist 匹配来源类型 |

### 类型 Re-exports

| 导出项 | 来源 | 说明 |
|--------|------|------|
| `ChannelId` | `types.ts` | 渠道 ID 类型 |
| `ChannelPlugin` | `types.ts` | 渠道插件接口类型 |

---

## 渠道生命周期总览

```
1. 启动阶段
   PluginLoader 注册插件 → listChannelPlugins() 排序去重

2. 账户初始化
   ChannelConfigAdapter.listAccountIds() → resolveAccount()
   ChannelSetupAdapter.applyAccountConfig()（首次配置）
   ChannelOnboardingAdapter.configure()（向导场景）

3. Gateway 连接
   ChannelGatewayAdapter.startAccount(ctx)
   ChannelHeartbeatAdapter.checkReady()（定期心跳）

4. 入站消息处理
   ChannelSecurityAdapter.resolveDmPolicy()（DM 安全检查）
   ChannelConfigAdapter.resolveAllowFrom()（发送者鉴权）
   ChannelGroupAdapter.resolveRequireMention()（群组 @ 检查）
   ChannelMentionAdapter.stripMentions()（剥离 @提及）
   → Agent 处理

5. 出站消息发送
   ChannelMessagingAdapter.normalizeTarget()（目标标准化）
   ChannelThreadingAdapter.resolveReplyToMode()（回复模式）
   ChannelOutboundAdapter.chunker()（长文本分块）
   ChannelOutboundAdapter.sendText() / sendMedia() / sendPayload()
   ChannelStreamingAdapter（流式聚合）

6. Agent 工具调用
   ChannelMessageActionAdapter.handleAction()
   ChannelAgentPromptAdapter.messageToolHints()（系统提示注入）
   ChannelDirectoryAdapter（目录查询）
   ChannelResolverAdapter.resolveTargets()（ID 解析）

7. 状态查询
   ChannelStatusAdapter.probeAccount()（--probe）
   ChannelStatusAdapter.auditAccount()（--deep）
   ChannelStatusAdapter.buildAccountSnapshot()
   ChannelStatusAdapter.collectStatusIssues()

8. 关闭阶段
   ChannelGatewayAdapter.stopAccount(ctx)
   ChannelGatewayAdapter.logoutAccount(ctx)（主动登出）
```
