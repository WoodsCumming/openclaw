# OpenClaw Plugins、Memory 与 Cron 模块 API 参考

> 源码路径均相对于仓库根目录。  
> 生成日期：2026-04-15

---

## 目录

1. [Plugins 模块](#plugins-模块)
   - [PluginLogger](#pluginlogger)
   - [PluginKind](#pluginkind)
   - [OpenClawPluginConfigSchema](#openclawpluginconfigschema)
   - [OpenClawPluginToolContext](#openclawplugintoolcontext)
   - [OpenClawPluginToolFactory](#openclawplugintooolfactory)
   - [ProviderAuthKind / ProviderAuthResult](#providerauthkind--providerauthresult)
   - [OpenClawPluginCommandDefinition](#openclawplugincommanddefinition)
   - [OpenClawPluginDefinition](#openclawplugindefinition)
   - [OpenClawPluginApi — register 方法表格](#openclawpluginapi--register-方法表格)
   - [PluginHookName — 钩子触发时机详表](#pluginhookname--钩子触发时机详表)
   - [PluginHookHandlerMap — 各钩子签名](#pluginhookhandlermap--各钩子签名)
2. [Memory 模块](#memory-模块)
   - [MemoryIndexManager — 类概览](#memoryindexmanager--类概览)
   - [静态工厂方法 get()](#静态工厂方法-get)
   - [公共方法表格](#公共方法表格)
   - [支持的 Embedding Provider](#支持的-embedding-provider)
   - [检索策略说明](#检索策略说明)
3. [Cron 模块](#cron-模块)
   - [核心类型](#核心类型)
   - [CronService — 方法表格](#cronservice--方法表格)

---

## Plugins 模块

源文件：`src/plugins/types.ts`

---

### PluginLogger

**位置：** `src/plugins/types.ts:26`

```ts
export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
```

由 Gateway 注入插件的日志接口，插件通过此接口输出日志。`debug` 为可选，某些部署环境不支持 debug 级日志。

| 字段 | 类型 | 是否必选 | 说明 |
|------|------|----------|------|
| `debug` | `(message: string) => void` | 否 | 调试日志，部分环境不可用 |
| `info` | `(message: string) => void` | 是 | 信息日志 |
| `warn` | `(message: string) => void` | 是 | 警告日志 |
| `error` | `(message: string) => void` | 是 | 错误日志 |

---

### PluginKind

**位置：** `src/plugins/types.ts:43`

```ts
export type PluginKind = "memory";
```

插件类型标识。目前仅支持 `"memory"`（记忆后端插件）。声明此字段的插件将被识别为记忆后端，Gateway 在初始化记忆系统时会优先调用该插件。

---

### OpenClawPluginConfigSchema

**位置：** `src/plugins/types.ts:57`

```ts
export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};
```

插件配置的 Schema 定义，支持多种验证方式：

| 字段 | 说明 |
|------|------|
| `safeParse` | Zod 风格的安全解析（不抛出异常），`success: false` 时返回 `error.issues` |
| `parse` | 严格解析，失败时直接抛出异常 |
| `validate` | 自定义验证函数，返回 `{ ok: true }` 或 `{ ok: false; errors: string[] }` |
| `uiHints` | Web 控制台配置表单各字段的 UI 提示（label、help、placeholder 等） |
| `jsonSchema` | JSON Schema 格式的 schema，用于文档自动生成或外部工具集成 |

> 注意：`safeParse` / `parse` / `validate` 三者互斥，建议只提供一个；Gateway 优先使用 `safeParse`。

---

### OpenClawPluginToolContext

**位置：** `src/plugins/types.ts:81`

```ts
export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};
```

工具被调用时由 Gateway 注入的运行时上下文。

| 字段 | 说明 |
|------|------|
| `config` | 当前 OpenClaw 配置（只读） |
| `workspaceDir` | agent 工作区目录，工具执行的根目录 |
| `agentDir` | agent 数据目录（存放会话、技能等） |
| `agentId` | 当前 agent ID |
| `sessionKey` | 当前会话 key，格式见架构文档 |
| `messageChannel` | 消息来源渠道，如 `"telegram"`、`"discord"` |
| `agentAccountId` | agent 的账号 ID（多账号渠道使用） |
| `sandboxed` | 是否在 Docker 沙箱中运行 |

---

### OpenClawPluginToolFactory

**位置：** `src/plugins/types.ts:97`

```ts
export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;
```

工具工厂函数类型。每次 agent 执行时调用，根据运行时上下文动态创建工具实例。返回 `null` 或 `undefined` 表示该上下文不需要此工具。适合按渠道或 agent 条件性注册工具的场景。

---

### ProviderAuthKind / ProviderAuthResult

**位置：** `src/plugins/types.ts:122` / `131`

```ts
export type ProviderAuthKind =
  | "oauth"        // OAuth 2.0 流程（如 GitHub Copilot、Gemini）
  | "api_key"      // 直接配置 API key
  | "token"        // Bearer token
  | "device_code"  // 设备码流程
  | "custom";      // 自定义认证逻辑

export type ProviderAuthResult = {
  profiles: Array<{ profileId: string; credential: AuthProfileCredential }>;
  configPatch?: Partial<OpenClawConfig>;
  defaultModel?: string;
  notes?: string[];
};
```

`ProviderAuthResult` 字段说明：

| 字段 | 说明 |
|------|------|
| `profiles` | 认证成功后创建的 auth profile 列表 |
| `configPatch` | 需要写入配置文件的补丁（如设置默认模型） |
| `defaultModel` | 推荐使用的默认模型 ID |
| `notes` | 给用户的提示信息（如 API key 用量注意事项） |

---

### OpenClawPluginCommandDefinition

**位置：** `src/plugins/types.ts:235`

```ts
export type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: PluginCommandHandler;
};
```

插件自定义渠道命令定义。插件命令在内置命令（`/reset` 等）之前处理，优先级高于 agent 调用，适用于简单的状态切换或查询命令，不需要 AI 推理。

| 字段 | 类型 | 是否必选 | 说明 |
|------|------|----------|------|
| `name` | `string` | 是 | 命令名，不含前导 `/`（如 `"tts"`） |
| `description` | `string` | 是 | 命令描述，显示在 `/help` 和命令菜单中 |
| `acceptsArgs` | `boolean` | 否 | 是否接受命令参数（默认 false） |
| `requireAuth` | `boolean` | 否 | 是否需要发送者在 allowlist 中（默认 true） |
| `handler` | `PluginCommandHandler` | 是 | 命令处理函数 |

`PluginCommandHandler` 签名（`src/plugins/types.ts:222`）：
```ts
type PluginCommandHandler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
```

---

### OpenClawPluginDefinition

**位置：** `src/plugins/types.ts:300`

```ts
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};
```

插件定义对象，是插件模块的主导出类型。`register` 与 `activate` 两个生命周期钩子功能相同，`activate` 是语义别名。

最简示例：
```ts
export default {
  register(api) {
    api.registerTool(myTool);
  }
} satisfies OpenClawPluginDefinition;
```

插件也可以是函数形式（`OpenClawPluginModule`）：
```ts
export default (api: OpenClawPluginApi) => {
  api.on("before_tool_call", handler);
};
```

---

### OpenClawPluginApi — register 方法表格

**位置：** `src/plugins/types.ts:330`

`OpenClawPluginApi` 是插件 `register/activate` 生命周期中可用的注册 API 对象。

#### 属性字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 插件 ID |
| `name` | `string` | 插件名 |
| `version` | `string \| undefined` | 插件版本 |
| `description` | `string \| undefined` | 插件描述 |
| `source` | `string` | 插件加载路径 |
| `config` | `OpenClawConfig` | 当前 Gateway 全局配置 |
| `pluginConfig` | `Record<string, unknown> \| undefined` | 插件自身配置（用户在配置文件中提供） |
| `runtime` | `PluginRuntime` | 插件运行时（访问 Gateway 内部服务） |
| `logger` | `PluginLogger` | 日志接口 |

#### 注册方法一览

| 方法签名 | 位置 | 用途说明 |
|----------|------|----------|
| `registerTool(tool, opts?)` | `:340` | 注册 agent 工具（静态工具或工厂函数）。工具在每次 agent 执行时注入，工厂函数可根据上下文动态决定是否启用 |
| `registerHook(events, handler, opts?)` | `:344` | 注册内部钩子（旧版 API）。推荐改用类型安全的 `on()` |
| `registerHttpHandler(handler)` | `:349` | 注册低级 HTTP 拦截处理器，优先于路由匹配处理 inbound 请求（如 webhook 验证） |
| `registerHttpRoute(params)` | `:350` | 注册具名 HTTP 路由，`params.path` 为路径前缀，`handler` 处理请求 |
| `registerChannel(registration)` | `:351` | 注册渠道插件（`ChannelPlugin` 或带 dock 的 `OpenClawPluginChannelRegistration`） |
| `registerGatewayMethod(method, handler)` | `:352` | 注册自定义 Gateway WebSocket RPC 方法，方法名建议加插件前缀（如 `"myplugin.doX"`） |
| `registerCli(registrar, opts?)` | `:353` | 注册 CLI 命令（扩展 Commander.js program），`opts.commands` 可声明注册的命令名列表 |
| `registerService(service)` | `:354` | 注册后台服务，随 Gateway 启停（`service.start` / `service.stop`） |
| `registerProvider(provider)` | `:355` | 注册 LLM provider 插件，扩展可用的 AI 模型来源 |
| `registerCommand(command)` | `:361` | 注册渠道命令（绕过 LLM）。命令在内置命令之前处理，适合状态切换等简单操作 |
| `on(hookName, handler, opts?)` | `:364` | **推荐**：注册生命周期钩子，完整 TypeScript 类型推断。`opts.priority` 控制执行优先级（数值越小越先执行） |
| `resolvePath(input)` | `:362` | 将相对路径解析为工作区绝对路径 |

---

### PluginHookName — 钩子触发时机详表

**位置：** `src/plugins/types.ts:401`

```ts
export type PluginHookName =
  | "before_model_resolve" | "before_prompt_build" | "before_agent_start"
  | "llm_input" | "llm_output" | "agent_end"
  | "before_compaction" | "after_compaction" | "before_reset"
  | "message_received" | "message_sending" | "message_sent"
  | "before_tool_call" | "after_tool_call" | "tool_result_persist"
  | "before_message_write"
  | "session_start" | "session_end"
  | "subagent_spawning" | "subagent_delivery_target" | "subagent_spawned" | "subagent_ended"
  | "gateway_start" | "gateway_stop";
```

#### Agent 生命周期钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `before_model_resolve` | 模型解析前，此时尚无会话消息 | `modelOverride`（覆盖模型 ID）、`providerOverride`（覆盖 provider） |
| `before_prompt_build` | system prompt 构建前，会话消息已准备好 | `systemPrompt`（替换完整 system prompt）、`prependContext`（向 prompt 前追加上下文） |
| `before_agent_start` | agent 执行前（兼容旧版，合并 `before_model_resolve` + `before_prompt_build` 两个阶段） | 同上两者的联合 |
| `llm_input` | LLM API 调用前（仅观察，不可修改） | 无返回值；可读取 `runId`、`provider`、`model`、`historyMessages` 等 |
| `llm_output` | LLM API 返回后（仅观察） | 无返回值；可读取 `assistantTexts`、`usage` 等 |
| `agent_end` | agent 执行完成后 | 无返回值；可读取 `success`、`error`、`durationMs` |

#### 会话压缩钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `before_compaction` | 会话压缩（摘要化）之前 | 无返回值；可异步读取 `sessionFile` 中的完整历史消息 |
| `after_compaction` | 会话压缩完成之后 | 无返回值；`compactedCount` 表示被压缩的消息数 |
| `before_reset` | `/new` 或 `/reset` 清除会话之前 | 无返回值；可从 `sessionFile` 读取消息做最终处理 |

#### 消息收发钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `message_received` | 渠道消息到达 Gateway 时 | 无返回值；可读取 `from`、`content`、`channelId` |
| `message_sending` | 回复消息发送前 | `content`（修改发送内容）、`cancel: true`（取消发送） |
| `message_sent` | 回复消息发送完成后 | 无返回值；`success` 指示是否成功 |

#### 工具调用钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `before_tool_call` | 工具调用前 | `params`（修改工具入参）、`block: true`（取消调用）、`blockReason`（取消原因） |
| `after_tool_call` | 工具调用返回后 | 无返回值；可读取 `result`、`error`、`durationMs` |
| `tool_result_persist` | 工具结果写入会话 JSONL 前 | `message`（修改或过滤写入的消息体） |
| `before_message_write` | 任意消息写入会话 JSONL 前 | `block: true`（阻止写入）、`message`（替换要写入的消息） |

#### 会话生命周期钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `session_start` | 会话创建或恢复时 | 无返回值；`resumedFrom` 指示从哪个会话 ID 恢复 |
| `session_end` | 会话结束时 | 无返回值；可读取 `messageCount`、`durationMs` |

#### 子 Agent 钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `subagent_spawning` | 子 agent 启动前（准备阶段） | `status: "ok"` 或 `status: "error"`（阻止启动）；可设 `threadBindingReady` |
| `subagent_delivery_target` | 确定子 agent 回复投递目标时 | `origin`（覆盖投递目标的渠道/账号/线程信息） |
| `subagent_spawned` | 子 agent 成功启动后 | 无返回值；`runId` 可用于后续追踪 |
| `subagent_ended` | 子 agent 结束时 | 无返回值；`outcome` 为 `"ok"/"error"/"timeout"/"killed"/"reset"/"deleted"` |

#### Gateway 生命周期钩子

| 钩子名 | 触发时机 | 可返回值/可修改内容 |
|--------|----------|---------------------|
| `gateway_start` | Gateway WebSocket 服务启动后 | 无返回值；`port` 为实际监听端口 |
| `gateway_stop` | Gateway 正在关闭时 | 无返回值；`reason` 为关闭原因（可能为空） |

---

### PluginHookHandlerMap — 各钩子签名

**位置：** `src/plugins/types.ts:760`

完整的钩子处理函数类型映射，通过 `api.on<K>(hookName, handler)` 使用时自动推断：

```ts
// 示例：覆盖模型
api.on("before_model_resolve", (event, ctx) => {
  if (ctx.agentId === "fast") {
    return { modelOverride: "llama3.3:8b" };
  }
});

// 示例：拦截工具调用
api.on("before_tool_call", (event, ctx) => {
  if (event.toolName === "shell" && !ctx.agentId?.startsWith("trusted")) {
    return { block: true, blockReason: "Shell tool not allowed for this agent" };
  }
});

// 示例：发送前修改内容
api.on("message_sending", (event, ctx) => {
  return { content: `[${ctx.channelId}] ${event.content}` };
});
```

**可返回修改结果的钩子（其余为 void）：**

| 钩子名 | 返回类型 |
|--------|----------|
| `before_model_resolve` | `PluginHookBeforeModelResolveResult \| void` |
| `before_prompt_build` | `PluginHookBeforePromptBuildResult \| void` |
| `before_agent_start` | `PluginHookBeforeAgentStartResult \| void` |
| `message_sending` | `PluginHookMessageSendingResult \| void` |
| `before_tool_call` | `PluginHookBeforeToolCallResult \| void` |
| `tool_result_persist` | `PluginHookToolResultPersistResult \| void` |
| `before_message_write` | `PluginHookBeforeMessageWriteResult \| void` |
| `subagent_spawning` | `PluginHookSubagentSpawningResult \| void` |
| `subagent_delivery_target` | `PluginHookSubagentDeliveryTargetResult \| void` |

---

## Memory 模块

源文件：`src/memory/manager.ts`

---

### MemoryIndexManager — 类概览

**位置：** `src/memory/manager.ts:67`

```ts
export class MemoryIndexManager
  extends MemoryManagerEmbeddingOps
  implements MemorySearchManager
```

OpenClaw 向量记忆系统的核心类，负责将文本嵌入为向量并支持多种检索策略。

**核心能力：**
- 将文本（会话内容、文档等）嵌入为向量，存储到 SQLite-vec 或 LanceDB
- 支持向量相似度搜索、BM25 全文搜索（FTS）和混合检索
- 嵌入结果缓存，避免重复 API 调用
- 支持增量同步和原子重索引
- 时序衰减（temporal decay）：对旧记忆降权，优先返回近期相关内容
- MMR（最大边际相关性）去重，提高检索多样性

**单例缓存：** 内部使用 `INDEX_CACHE: Map<string, MemoryIndexManager>`，同一 `cacheKey`（`agentId:workspaceDir:settings`）复用实例，避免重复初始化数据库。

**构造方式：** 构造函数为 `private`，只能通过静态方法 `MemoryIndexManager.get()` 获取实例。

---

### 静态工厂方法 get()

**位置：** `src/memory/manager.ts:127`

```ts
static async get(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager | null>
```

获取或创建 `MemoryIndexManager` 实例（单例）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cfg` | `OpenClawConfig` | 当前 OpenClaw 配置 |
| `agentId` | `string` | agent ID，用于定位工作区目录和记忆配置 |
| `purpose` | `"default" \| "status"` | 用途：`"status"` 模式下跳过首次全量同步，仅用于展示状态 |

**返回值：** 若配置中未启用记忆功能，返回 `null`；否则返回 `MemoryIndexManager` 实例。

---

### 公共方法表格

| 方法 | 位置 | 签名 | 说明 |
|------|------|------|------|
| `search` | `:231` | `search(query, opts?) => Promise<MemorySearchResult[]>` | 执行记忆检索，根据配置自动选择向量/FTS/混合模式 |
| `sync` | `:404` | `sync(params?) => Promise<void>` | 触发增量同步，将磁盘上的新内容嵌入并写入索引 |
| `warmSession` | `:215` | `warmSession(sessionKey?) => Promise<void>` | 会话启动时预热索引（若配置了 `sync.onSessionStart`） |
| `readFile` | `:421` | `readFile(params) => Promise<{text, path}>` | 读取工作区内的记忆文件（仅允许 `.md` 文件，路径需在工作区或 extraPaths 内） |
| `status` | `:494` | `status() => MemoryProviderStatus` | 同步返回当前索引状态（文件数、chunk 数、provider 信息等） |
| `probeVectorAvailability` | `:602` | `probeVectorAvailability() => Promise<boolean>` | 探测向量扩展是否可用（sqlite-vec 加载检查） |
| `probeEmbeddingAvailability` | `:613` | `probeEmbeddingAvailability() => Promise<MemoryEmbeddingProbeResult>` | 探测嵌入 API 是否可用（发送 `"ping"` 验证连通性） |
| `close` | `:630` | `close() => Promise<void>` | 关闭实例，停止文件监听、计时器、数据库连接，并从单例缓存中移除 |

#### `search` 方法参数详情

```ts
search(
  query: string,
  opts?: {
    maxResults?: number;  // 最大返回数量（默认来自配置）
    minScore?: number;    // 最低相关性分数阈值（默认来自配置）
    sessionKey?: string;  // 当前会话 key，用于触发会话预热
  }
): Promise<MemorySearchResult[]>
```

#### `sync` 方法参数详情

```ts
sync(params?: {
  reason?: string;   // 同步触发原因（用于日志，如 "search"、"session-start"）
  force?: boolean;   // 强制全量重建索引（忽略 dirty 标记）
  progress?: (update: MemorySyncProgressUpdate) => void;  // 进度回调
}): Promise<void>
```

> 注意：`sync` 内部有防并发保护——若已有同步进行中，后续调用会等待同一个 Promise，不会触发重复同步。

---

### 支持的 Embedding Provider

**位置：** `src/memory/manager.ts:74`（`requestedProvider` 字段类型）

| Provider ID | 说明 | 推荐模型 |
|-------------|------|----------|
| `openai` | OpenAI Embeddings API | `text-embedding-3-small` / `text-embedding-3-large` |
| `gemini` | Google Gemini Embeddings API | `text-embedding-004` |
| `voyage` | Voyage AI Embeddings | `voyage-3` / `voyage-code-3` |
| `mistral` | Mistral Embeddings | `mistral-embed` |
| `local` | 本地 HuggingFace 模型（通过 sqlite-vec 或 ONNX 运行） | 用户自定义 |
| `auto` | 自动选择可用 provider，按优先级依次尝试 | — |

> `fallbackFrom` 和 `fallbackReason` 字段记录了自动降级信息：当首选 provider 不可用时，系统会自动切换并记录原因（可通过 `status()` 查看）。

---

### 检索策略说明

`MemoryIndexManager` 根据配置和 provider 可用性自动选择检索策略：

#### 1. 纯向量检索（vector-only）

- 条件：`hybrid.enabled = false`，有可用嵌入 provider
- 流程：将 query 嵌入为向量 → 在 `chunks_vec` 表中 KNN 搜索 → 按余弦相似度排序

#### 2. BM25 全文检索（fts-only）

- 条件：无可用嵌入 provider（`provider = null`），FTS 可用
- 流程：关键词提取（`extractKeywords`）→ 在 `chunks_fts` 表中 BM25 搜索 → 结果去重合并
- 适用于：无 API key 的本地部署场景

#### 3. 混合检索（hybrid，默认）

- 条件：`hybrid.enabled = true`，有可用嵌入 provider
- 流程：
  1. 向量检索（`searchVector`）
  2. BM25 关键词检索（`searchKeyword`）
  3. 加权融合（`vectorWeight` + `textWeight`）
  4. 可选 MMR 去重（`hybrid.mmr.enabled`）
  5. 可选时序衰减（`hybrid.temporalDecay.halfLifeDays`）
- 综合了语义相似度和关键词精确匹配的优势

---

## Cron 模块

源文件：`src/cron/service.ts`、`src/cron/types.ts`

---

### 核心类型

#### CronSchedule

**位置：** `src/cron/types.ts:3`

```ts
export type CronSchedule =
  | { kind: "at"; at: string }                          // 一次性定时（ISO 时间字符串）
  | { kind: "every"; everyMs: number; anchorMs?: number }  // 固定间隔（毫秒）
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };  // 标准 cron 表达式
```

| 类型 | 字段 | 说明 |
|------|------|------|
| `"at"` | `at: string` | 一次性执行，ISO 8601 时间字符串 |
| `"every"` | `everyMs: number`，`anchorMs?` | 固定间隔循环，`anchorMs` 为对齐锚点 |
| `"cron"` | `expr: string`，`tz?`，`staggerMs?` | 标准 5 字段 cron，支持时区；`staggerMs` 为随机抖动窗口（避免惊群） |

#### CronJob

**位置：** `src/cron/types.ts:111`

```ts
export type CronJob = {
  id: string;
  agentId?: string;
  sessionKey?: string;      // 关联的会话命名空间（用于消息投递路由）
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean; // 执行一次后自动删除
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;  // "main" | "isolated"
  wakeMode: CronWakeMode;            // "next-heartbeat" | "now"
  payload: CronPayload;
  delivery?: CronDelivery;
  state: CronJobState;
};
```

#### CronPayload

**位置：** `src/cron/types.ts:58`

```ts
export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;           // 模型覆盖（provider/model 或 alias）
      thinking?: string;        // 思考模式（"low"/"high"）
      timeoutSeconds?: number;
      deliver?: boolean;        // 是否将回复投递到渠道
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };
```

- `systemEvent`：注入系统事件文本，不触发 LLM 调用
- `agentTurn`：触发完整的 agent 执行轮次，等同于用户发送 `message`

#### CronJobCreate / CronJobPatch

**位置：** `src/cron/types.ts:135` / `139`

```ts
// 创建参数：省略自动生成的 id、createdAtMs、updatedAtMs、state
type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

// 更新参数：所有字段均可选，payload 和 delivery 支持部分更新
type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
};
```

#### CronJobState

**位置：** `src/cron/types.ts:89`

记录任务的运行时状态，持久化到磁盘：

| 字段 | 类型 | 说明 |
|------|------|------|
| `nextRunAtMs` | `number` | 下次计划执行时间（Unix ms） |
| `runningAtMs` | `number` | 当前正在执行的开始时间 |
| `lastRunAtMs` | `number` | 上次执行时间 |
| `lastRunStatus` | `CronRunStatus` | 上次执行结果：`"ok"/"error"/"skipped"` |
| `lastError` | `string` | 上次执行错误信息 |
| `lastDurationMs` | `number` | 上次执行耗时 |
| `consecutiveErrors` | `number` | 连续错误次数（成功时重置，用于退避策略） |
| `scheduleErrorCount` | `number` | 调度计算错误次数（超过阈值后自动禁用任务） |
| `lastDeliveryStatus` | `CronDeliveryStatus` | 上次投递状态：`"delivered"/"not-delivered"/"unknown"/"not-requested"` |

---

### CronService — 方法表格

**位置：** `src/cron/service.ts:22`

```ts
export class CronService {
  constructor(deps: CronServiceDeps)
}
```

`CronServiceDeps` 由 Gateway 在启动时注入，包含配置、logger、agent 执行器等依赖。

#### 生命周期方法

| 方法 | 签名 | 位置 | 说明 |
|------|------|------|------|
| `start` | `start() => Promise<void>` | `:33` | 启动调度器。从磁盘加载持久化任务，启动内部调度循环，注册心跳监听器。应在 Gateway 启动完成后调用 |
| `stop` | `stop() => void` | `:43` | 停止调度器。清理所有定时器，停止调度循环。Gateway 关闭时调用，不等待正在运行的任务完成 |

#### 任务查询方法

| 方法 | 签名 | 位置 | 说明 |
|------|------|------|------|
| `status` | `status() => Promise<StatusResult>` | `:50` | 获取所有任务的当前状态快照，每个任务包含 `id`、`name`、`schedule`、`lastRunAt`、`nextRunAt`、`lastStatus` 等字段 |
| `list` | `list(opts?) => Promise<CronJob[]>` | `:58` | 列出所有 Cron 任务。`opts.includeDisabled = true` 包含已禁用任务（默认仅返回启用的任务） |
| `listPage` | `listPage(opts?) => Promise<PageResult>` | `:67` | 分页列出任务，适用于任务数量较多的场景 |
| `getJob` | `getJob(id) => CronJob \| undefined` | `:117` | **同步**获取指定任务对象，不存在时返回 `undefined` |

#### 任务操作方法

| 方法 | 签名 | 位置 | 说明 |
|------|------|------|------|
| `add` | `add(input: CronJobCreate) => Promise<CronJob>` | `:77` | 添加新任务。立即持久化到磁盘，并在下次调度周期开始执行。返回含自动生成 `id` 的完整任务对象 |
| `update` | `update(id, patch: CronJobPatch) => Promise<CronJob>` | `:88` | 部分更新任务配置（仅传入需要修改的字段）。返回更新后的完整任务对象 |
| `remove` | `remove(id) => Promise<void>` | `:97` | 删除任务。立即从磁盘移除并停止调度 |
| `run` | `run(id, mode?) => Promise<void>` | `:108` | 手动触发任务执行。`mode = "due"`（默认，仅在到期时执行）或 `"force"`（强制立即执行，忽略调度时间） |
| `wake` | `wake(opts) => void` | `:126` | 唤醒调度器立即检查到期任务。`opts.mode = "now"` 立即执行，`"next-heartbeat"` 等待下次心跳。`opts.text` 用于日志记录唤醒原因 |

#### 使用注意事项

1. **持久化保证：** 所有任务变更（`add`/`update`/`remove`）立即写入磁盘，Gateway 重启后自动恢复。
2. **执行隔离：** `sessionTarget: "isolated"` 为每次执行创建独立会话；`"main"` 复用 agent 的主会话。
3. **投递模式：** `delivery.mode = "announce"` 将 agent 回复发送到指定渠道；`"webhook"` 通过 HTTP 回调投递；`"none"` 不投递。
4. **退避策略：** `consecutiveErrors` 连续错误计数超过阈值后，Gateway 会对该任务应用指数退避，避免频繁失败影响系统。
5. **staggerMs：** cron 类型任务可配置随机抖动（`staggerMs`），在多实例部署场景下防止所有实例同时执行同一任务（惊群效应）。
6. **`deleteAfterRun`：** 设置为 `true` 的任务在首次成功执行后自动删除，适合一次性提醒场景。
