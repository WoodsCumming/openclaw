# 插件系统架构文档

> 文件路径：`src/plugins/`
> 本文档描述 OpenClaw 插件系统的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

插件系统允许第三方开发者扩展 OpenClaw 的行为，无需修改核心代码。插件通过 `loadOpenClawPlugins()` 在 Gateway 启动时加载（使用 `jiti` 运行时解析，支持 TypeScript 源码直接加载）。

---

## 2. 目录结构

```
src/plugins/
├── types.ts                  # 插件类型定义（核心接口）
├── loader.ts                 # 插件加载器
├── discovery.ts              # 插件发现（全局/工作区/配置）
├── runtime/                  # 插件运行时
│   └── types.ts              # PluginRuntime 类型
├── hooks.ts                  # 钩子系统
├── hook-runner-global.ts     # 全局钩子运行器
├── config-state.ts           # 插件配置状态
├── config-schema.ts          # 插件配置 schema
├── bundled-sources.ts        # 内置插件源
├── bundled-dir.ts            # 内置插件目录
├── install.ts                # 插件安装
├── installs.ts               # 插件安装管理
├── manifest.ts               # 插件 manifest
├── manifest-registry.ts      # manifest 注册表
├── enable.ts                 # 插件启用/禁用
├── http-registry.ts          # HTTP 路由注册表
├── http-path.ts              # HTTP 路径工具
├── commands.ts               # 插件命令注册
└── cli.ts                    # 插件 CLI 命令
```

---

## 3. 核心类型

### 3.1 插件定义（`src/plugins/types.ts:230-239`）

```typescript
// src/plugins/types.ts:230-239
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;         // 当前仅 "memory" 类型
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

// 插件模块可以是对象或函数形式
export type OpenClawPluginModule =
  | OpenClawPluginDefinition
  | ((api: OpenClawPluginApi) => void | Promise<void>);
```

### 3.2 插件 API（`src/plugins/types.ts:245-284`）

插件通过 `OpenClawPluginApi` 注册各种扩展能力：

```typescript
// src/plugins/types.ts:245-284
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  // 注册自定义 agent 工具
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  // 注册内部钩子（legacy API）
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  // 注册 HTTP 请求处理器（webhook 等）
  registerHttpHandler: (handler: OpenClawPluginHttpHandler) => void;
  // 注册带路径的 HTTP 路由
  registerHttpRoute: (params: { path: string; handler: OpenClawPluginHttpRouteHandler }) => void;
  // 注册渠道插件
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  // 注册 Gateway RPC 方法
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
  // 注册 CLI 命令
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }) => void;
  // 注册后台服务
  registerService: (service: OpenClawPluginService) => void;
  // 注册 LLM provider
  registerProvider: (provider: ProviderPlugin) => void;
  // 注册自定义渠道命令（绕过 LLM）
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  resolvePath: (input: string) => string;
  // 注册生命周期钩子（推荐 API）
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
};
```

---

## 4. 钩子系统

### 4.1 所有钩子点（`src/plugins/types.ts:299-323`）

```typescript
// src/plugins/types.ts:299-323
export type PluginHookName =
  | "before_model_resolve"    // 模型解析前（可覆盖模型/provider 选择）
  | "before_prompt_build"     // system prompt 构建前（可注入上下文）
  | "before_agent_start"      // agent 执行前（兼容旧 API，合并上两个）
  | "llm_input"               // LLM 调用前（可查看完整输入）
  | "llm_output"              // LLM 调用后（可查看输出和用量）
  | "agent_end"               // agent 执行完成
  | "before_compaction"       // 会话压缩前
  | "after_compaction"        // 会话压缩后
  | "before_reset"            // 会话重置前
  | "message_received"        // 收到消息
  | "message_sending"         // 发送消息前（可修改内容）
  | "message_sent"            // 消息发送后
  | "before_tool_call"        // 工具调用前（可拦截/修改）
  | "after_tool_call"         // 工具调用后
  | "tool_result_persist"     // 工具结果持久化
  | "before_message_write"    // 消息写入前
  | "session_start"           // 会话开始
  | "session_end"             // 会话结束
  | "subagent_spawning"       // 子 agent 即将 spawn
  | "subagent_delivery_target"// 子 agent 交付目标确定
  | "subagent_spawned"        // 子 agent 已 spawn
  | "subagent_ended"          // 子 agent 结束
  | "gateway_start"           // Gateway 启动
  | "gateway_stop";           // Gateway 停止
```

### 4.2 钩子上下文类型

**before_model_resolve 钩子**（可覆盖模型选择）：

```typescript
// src/plugins/types.ts:334-345
export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "ollama" */
  providerOverride?: string;
};
```

**before_prompt_build 钩子**（可注入 system prompt）：

```typescript
// src/plugins/types.ts:347-357
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
};
```

**llm_input 钩子**（完整 LLM 调用参数）：

```typescript
// src/plugins/types.ts:369-379
export type PluginHookLlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};
```

**llm_output 钩子**（LLM 输出和 token 用量）：

```typescript
// src/plugins/types.ts:381-396
export type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};
```

---

## 5. 工具注册

插件工具通过 `registerTool` 注册，工具工厂函数接收运行时上下文：

```typescript
// src/plugins/types.ts:58-71
export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;      // 是否在 Docker 沙箱中运行
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;
```

---

## 6. 命令注册

插件可以注册自定义渠道命令（绕过 LLM，直接返回结果）：

```typescript
// src/plugins/types.ts:180-191
export type OpenClawPluginCommandDefinition = {
  /** Command name without leading slash (e.g., "tts") */
  name: string;
  /** Description shown in /help and command menus */
  description: string;
  /** Whether this command accepts arguments */
  acceptsArgs?: boolean;
  /** Whether only authorized senders can use this command (default: true) */
  requireAuth?: boolean;
  /** The handler function */
  handler: PluginCommandHandler;
};
```

---

## 7. Provider 注册

插件可以注册新的 LLM provider：

```typescript
// src/plugins/types.ts:116-126
export type ProviderPlugin = {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: ProviderAuthMethod[];
  formatApiKey?: (cred: AuthProfileCredential) => string;
  refreshOAuth?: (cred: OAuthCredential) => Promise<OAuthCredential>;
};
```

---

## 8. 插件来源

```typescript
// src/plugins/types.ts:286
export type PluginOrigin = "bundled" | "global" | "workspace" | "config";
```

| 来源 | 说明 |
|------|------|
| `bundled` | 内置插件（随 OpenClaw 发布） |
| `global` | 全局安装的插件（`~/.openclaw/plugins/`） |
| `workspace` | 工作区插件（当前目录） |
| `config` | 配置文件中指定的插件路径 |

---

## 9. Plugin SDK

插件通过 `openclaw/plugin-sdk` 引用公共类型，运行时通过 `jiti` alias 解析：

```
src/plugin-sdk/index.ts  →  对外公共 API 面
```

开发插件时，在 `package.json` 中：
- 将 `openclaw` 放入 `peerDependencies`（不要放 `dependencies`）
- 运行时依赖放 `dependencies`
- 避免使用 `workspace:*`（npm install 会失败）

---

## 10. 服务注册

插件可以注册后台服务（随 Gateway 启动/停止）：

```typescript
// src/plugins/types.ts:219-223
export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};
```
