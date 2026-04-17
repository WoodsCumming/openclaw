import type { AcpConfig } from "./types.acp.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CronConfig } from "./types.cron.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SecretsConfig } from "./types.secrets.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";

/**
 * OpenClaw 的完整配置对象类型，对应 `~/.openclaw/config.json5` 中的 JSON5 结构。
 *
 * 各顶层字段说明：
 * - `meta`：配置元信息（最后写入版本、时间戳），由 `writeConfigFile` 自动维护，无需手动设置。
 * - `auth`：网关身份认证配置（token、password 等）。
 * - `acp`：ACP（Agent Control Protocol）RPC 连接配置，包括连接地址和超时。
 * - `env`：环境变量注入配置；支持 `shellEnv`（从登录 shell 导入 API key 等）和 `vars`（内联变量）。
 * - `wizard`：首次引导向导的运行记录（上次运行时间、版本、模式）。
 * - `diagnostics`：诊断与健康检查配置。
 * - `logging`：日志级别、输出目标及结构化日志配置。
 * - `update`：自动更新策略（频道选择、延迟、beta 轮询间隔）。
 * - `browser`：内嵌浏览器（Playwright/puppeteer）配置。
 * - `ui`：UI 外观配置（主题色 `seamColor`、助手名称与头像）。
 * - `secrets`：密钥管理配置（外部密钥源、Keychain 集成等）。
 * - `skills`：技能（Skill）加载与执行配置。
 * - `plugins`：插件列表及插件级配置，对应 `extensions/*` 下的插件包。
 * - `models`：LLM 模型提供商与默认参数（provider、model ID、温度等）。
 * - `nodeHost`：Node.js 执行主机配置（沙箱、工作目录等）。
 * - `agents`：Agent 实例定义列表及 Agent 级别默认值。
 * - `tools`：工具执行策略（允许/拒绝列表、超时、沙箱）。
 * - `bindings`：Agent ↔ 频道的绑定规则列表。
 * - `broadcast`：跨 Agent / 跨频道广播消息配置。
 * - `audio`：TTS / STT 音频管道配置。
 * - `messages`：消息格式化与截断策略。
 * - `commands`：斜杠命令（slash command）注册与权限配置。
 * - `approvals`：工具调用审批策略（auto-approve、人工审批规则）。
 * - `session`：会话保留时长、压缩（compaction）策略。
 * - `web`：WebChat 频道配置（端口、CORS、静态资源）。
 * - `channels`：各消息频道（WhatsApp、Telegram、Slack 等）的频道级配置。
 * - `cron`：定时任务（cron job）定义列表。
 * - `hooks`：生命周期钩子（before/after agent turn、tool call、LLM call 等）。
 * - `discovery`：服务发现与多网关组网配置。
 * - `canvasHost`：Canvas / A2UI 可视化工作区服务配置。
 * - `talk`：Talk（语音通话）频道配置。
 * - `gateway`：网关全局配置（mode、bind、port、auth 等）。
 * - `memory`：Agent 记忆（long-term memory）存储与检索配置。
 */
export type OpenClawConfig = {
  meta?: {
    /** Last OpenClaw version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  acp?: AcpConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
    /** Core auto-update policy for package installs. */
    auto?: {
      /** Enable background auto-update checks and apply logic. Default: false. */
      enabled?: boolean;
      /** Stable channel minimum delay before auto-apply. Default: 6. */
      stableDelayHours?: number;
      /** Additional stable-channel jitter window. Default: 12. */
      stableJitterHours?: number;
      /** Beta channel check cadence. Default: 1 hour. */
      betaCheckIntervalHours?: number;
    };
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for OpenClaw UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: OpenClawConfig;
  valid: boolean;
  config: OpenClawConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
