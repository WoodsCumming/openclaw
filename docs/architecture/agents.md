# Agent 运行时架构文档

> 文件路径：`src/agents/`
> 本文档描述 OpenClaw Agent 运行时的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

Agent 层是 OpenClaw 最核心的执行引擎，负责：
- 将入站消息转化为 LLM 调用
- 管理 Pi 会话（DAG 转录）
- 执行工具调用（文件系统、Bash、渠道工具）
- 处理 LLM 流式输出并分块推送到渠道
- 管理多 API key 轮换（failover）
- 上下文窗口监控与会话压缩

---

## 2. 目录结构

```
src/agents/
├── pi-embedded-runner/          # 核心执行引擎
│   ├── run.ts                   # 主运行循环（runEmbeddedPiAgent 入口）
│   ├── model.ts                 # 模型解析
│   ├── compact.ts               # 会话压缩（直接压缩路径）
│   ├── extra-params.ts          # 额外参数处理（工具、能力）
│   ├── lanes.ts                 # Lane 解析（session/global）
│   ├── logger.ts                # 子系统日志
│   └── run/
│       ├── attempt.ts           # 单次执行尝试（runEmbeddedAttempt）
│       ├── payloads.ts          # 运行负载构建
│       ├── params.ts            # 运行参数类型
│       └── types.ts             # 运行结果类型
├── pi-embedded-helpers.ts       # 错误分类、failover 判断
├── pi-embedded-subscribe.ts     # LLM 流式订阅处理
├── auth-profiles/               # API key 轮换策略
│   ├── profiles.ts              # 配置文件管理（upsert、list）
│   ├── store.ts                 # 持久化存储
│   ├── usage.ts                 # 冷却期管理（cooldown）
│   ├── order.ts                 # 轮换排序（round-robin）
│   ├── oauth.ts                 # OAuth 流程
│   ├── types.ts                 # 类型定义
│   └── constants.ts             # 常量（CLAUDE_CLI_PROFILE_ID 等）
├── auth-profiles.ts             # 公共 API 聚合导出
├── model-catalog.ts             # 统一模型目录（聚合所有 provider）
├── model-auth.ts                # 模型认证（API key 解析）
├── model-selection.ts           # 模型选择逻辑
├── models-config.ts             # 模型配置（providers JSON）
├── models-config.providers.ts   # 各 provider 配置（20+ 个）
├── subagent-registry.ts         # 子 Agent 生命周期管理
├── subagent-announce.ts         # 子 Agent 宣告流程
├── skills/                      # 技能（Skills）系统
│   ├── workspace.ts             # 工作区技能快照
│   ├── config.ts                # 技能配置
│   └── types.ts                 # 技能类型
├── skills.ts                    # 技能公共 API 聚合
├── compaction.ts                # 会话历史压缩算法
├── context-window-guard.ts      # 上下文窗口监控
├── sandbox/                     # Docker 沙箱配置
├── tools/                       # 工具系统
├── agent-scope.ts               # Agent 作用域（工作区目录）
├── agent-paths.ts               # Agent 路径解析
└── defaults.ts                  # 默认值（模型、provider、上下文 tokens）
```

---

## 3. 核心执行引擎

### 3.1 主运行循环（`src/agents/pi-embedded-runner/run.ts`）

主运行循环处理认证轮换、failover 重试和会话压缩：

```typescript
// src/agents/pi-embedded-runner/run.ts:1-65（关键导入）
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentStartResult } from "../../plugins/types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
} from "../auth-profiles.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
```

防止 Anthropic 测试 token 污染会话转录的清理函数：

```typescript
// src/agents/pi-embedded-runner/run.ts:69-79
// Avoid Anthropic's refusal test token poisoning session transcripts.
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}
```

Token 使用量累加器，追踪每次 API 调用的缓存命中情况：

```typescript
// src/agents/pi-embedded-runner/run.ts:81-101
type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Cache fields from the most recent API call (not accumulated). */
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};

const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});
```

重试迭代次数根据可用 profile 数量动态调整：

```typescript
// src/agents/pi-embedded-runner/run.ts:107-118
// Defensive guard for the outer run loop across all retry branches.
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}
```

---

### 3.2 上下文窗口守卫（`src/agents/context-window-guard.ts`）

监控上下文窗口大小，接近限制时触发警告或阻断：

```typescript
// src/agents/context-window-guard.ts:1-11
import type { OpenClawConfig } from "../config/config.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;   // 硬阻断阈值
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000; // 警告阈值

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;  // 上下文窗口大小来源
};
```

上下文窗口解析，支持多个来源（优先级：modelsConfig > model > default，可被 agentContextTokens 覆盖）：

```typescript
// src/agents/context-window-guard.ts:21-50
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  // 优先从 models.providers 配置中读取（用户自定义覆盖）
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers as
      | Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>
      | undefined;
    const providerEntry = providers?.[params.provider];
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : { tokens: Math.floor(params.defaultTokens), source: "default" as const };

  // agents.defaults.contextTokens 可以进一步限制上下文窗口
  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}
```

---

### 3.3 会话压缩（`src/agents/compaction.ts`）

当上下文窗口接近限制时，将历史消息压缩为摘要：

```typescript
// src/agents/compaction.ts:9-18
const log = createSubsystemLogger("compaction");

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. Preserve decisions," +
  " TODOs, open questions, and any constraints.";
```

Token 估算（安全起见过滤 toolResult.details，防止不可信内容进入压缩）：

```typescript
// src/agents/compaction.ts:20-24
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details can contain untrusted/verbose payloads; never include in LLM-facing compaction.
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

按 token 份额分割消息（用于分块并行压缩）：

```typescript
// src/agents/compaction.ts:37-70
export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }
  // ...
}
```

---

### 3.4 认证 Profile 管理（`src/agents/auth-profiles.ts`）

聚合导出认证 profile 管理的所有公共 API：

```typescript
// src/agents/auth-profiles.ts:1-48
// 常量：预定义 profile ID
export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
// 显示标签
export { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
// 诊断提示
export { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
// OAuth 流程
export { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
// 轮换排序（round-robin，按 last-used 时间）
export { resolveAuthProfileOrder } from "./auth-profiles/order.js";
// 路径
export { resolveAuthStorePathForDisplay } from "./auth-profiles/paths.js";
// Profile 管理（去重、列表、标记成功、设置顺序、更新）
export {
  dedupeProfileIds,
  listProfilesForProvider,
  markAuthProfileGood,
  setAuthProfileOrder,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
} from "./auth-profiles/profiles.js";
// 冷却期管理（失败后自动冷却，防止频繁重试同一 key）
export {
  calculateAuthProfileCooldownMs,
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
} from "./auth-profiles/usage.js";
```

---

### 3.5 子 Agent 注册表（`src/agents/subagent-registry.ts`）

管理子 Agent 的完整生命周期（spawn → announce → cleanup）：

```typescript
// src/agents/subagent-registry.ts:46-70
const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;

const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;    // 宣告超时 120 秒
const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;
/**
 * Maximum number of announce delivery attempts before giving up.
 * Prevents infinite retry loops when `runSubagentAnnounceFlow` repeatedly
 * returns `false` due to stale state or transient conditions (#18264).
 */
const MAX_ANNOUNCE_RETRY_COUNT = 3;
/**
 * Announce entries older than this are force-expired even if delivery never
 * succeeded. Guards against stale registry entries surviving gateway restarts.
 */
const ANNOUNCE_EXPIRY_MS = 5 * 60_000; // 5 minutes
```

指数退避重试延迟计算：

```typescript
// src/agents/subagent-registry.ts:72-76
function resolveAnnounceRetryDelayMs(retryCount: number) {
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  // retryCount is "attempts already made", so retry #1 waits 1s, then 2s, 4s...
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}
```

---

### 3.6 模型目录（`src/agents/model-catalog.ts`）

统一模型目录，聚合所有 provider 的模型列表：

```typescript
// src/agents/model-catalog.ts:8-23
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;          // 是否支持推理模式
  input?: Array<"text" | "image">;  // 支持的输入类型
};

// 非 Pi 原生 provider（需要通过配置显式声明模型列表）
const NON_PI_NATIVE_MODEL_PROVIDERS = new Set(["kilocode"]);
```

---

## 4. 执行流程

```
runEmbeddedPiAgent(params)
  │
  ├── 1. 解析模型（resolveModel）
  │      └── provider + modelId + contextWindow
  │
  ├── 2. 选择 Auth Profile（resolveAuthProfileOrder）
  │      └── 按 last-used 排序，跳过冷却期中的 profile
  │
  ├── 3. 检查上下文窗口（evaluateContextWindowGuard）
  │      └── < 16K tokens → 阻断；< 32K tokens → 警告
  │
  ├── 4. 触发插件钩子（before.agent.start）
  │      └── 插件可修改 system prompt、模型选择
  │
  ├── 5. 执行单次尝试（runEmbeddedAttempt）
  │      ├── 构建 system prompt（bootstrap + skills + channel capabilities）
  │      ├── 调用 Pi SDK（SessionManager.run）
  │      └── 工具执行循环（文件系统、Bash、渠道工具）
  │
  ├── 6. 处理失败（classifyFailoverReason）
  │      ├── 认证失败 → 标记 profile 失败，切换下一个
  │      ├── 速率限制 → 等待冷却期
  │      ├── 上下文溢出 → 触发压缩（compactEmbeddedPiSessionDirect）
  │      └── 计费错误 → 通知用户
  │
  └── 7. 累计 Token 使用量（UsageAccumulator）
```

---

## 5. 并发控制

所有 agent 调用通过 `enqueueCommandInLane` 入队，按 Lane 限流：

```typescript
// src/process/lanes.ts（CommandLane 枚举）
export enum CommandLane {
  Main = "main",           // 主 agent（默认 1 并发）
  Cron = "cron",           // Cron 任务（可配置）
  Subagent = "subagent",   // 子 agent（可配置）
  Nested = "nested",       // 嵌套调用
}
```

---

## 6. 支持的 LLM Provider

`src/agents/models-config.providers.ts` 包含 20+ 个 provider 配置：

| Provider | 说明 |
|----------|------|
| Anthropic | Claude 系列（默认） |
| OpenAI | GPT 系列 |
| Google Gemini | Gemini 系列 |
| Ollama | 本地模型 |
| AWS Bedrock | AWS 托管模型 |
| BytePlus | 字节跳动 |
| HuggingFace | HuggingFace 推理 API |
| GitHub Copilot | Copilot 模型 |
| Chutes | Chutes AI |
| Kilocode | Kilocode（非 Pi 原生） |
| Mistral | Mistral AI |
| Voyage | Voyage AI（嵌入） |
| ... | 共 20+ 个 |
