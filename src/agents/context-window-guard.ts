import type { OpenClawConfig } from "../config/config.js";

/**
 * 上下文窗口硬阻断阈值（16,000 tokens）。
 * 当模型上下文窗口小于此值时，{@link evaluateContextWindowGuard} 返回 shouldBlock=true，
 * 阻止 agent 执行以避免因上下文过小导致的截断错误。
 */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
/**
 * 上下文窗口警告阈值（32,000 tokens）。
 * 当模型上下文窗口小于此值时，{@link evaluateContextWindowGuard} 返回 shouldWarn=true，
 * 提示用户考虑切换到更大上下文的模型。
 */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

/**
 * 上下文窗口大小的来源，按优先级从低到高：
 * - "default"：使用 DEFAULT_CONTEXT_TOKENS 默认值
 * - "model"：来自模型 SDK 返回的 contextWindow 字段
 * - "modelsConfig"：来自 models.providers 配置中的自定义覆盖
 * - "agentContextTokens"：来自 agents.defaults.contextTokens 的上限配置
 */
export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

/**
 * 上下文窗口信息，包含实际可用 token 数及其来源。
 * 由 {@link resolveContextWindowInfo} 计算，传入 {@link evaluateContextWindowGuard} 评估。
 */
export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

/**
 * 将值规范化为正整数，非有限数字或非正值返回 null。
 * 用于安全解析配置中的数字字段。
 */
function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/**
 * 解析 agent 运行时的上下文窗口大小。
 *
 * 来源优先级（高到低）：
 * 1. agents.defaults.contextTokens（配置上限，若小于基础值则覆盖）
 * 2. models.providers[provider].models[id].contextWindow（用户自定义覆盖）
 * 3. 模型 SDK 返回的 contextWindow（provider 官方值）
 * 4. defaultTokens（调用方传入的默认值）
 *
 * @param params.cfg - OpenClaw 配置（可选，用于读取覆盖值）
 * @param params.provider - LLM provider ID（如 "anthropic"）
 * @param params.modelId - 模型 ID（如 "claude-opus-4-6"）
 * @param params.modelContextWindow - 模型 SDK 返回的上下文窗口大小
 * @param params.defaultTokens - 回退默认值
 * @returns 上下文窗口信息（token 数 + 来源）
 */
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
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

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

/**
 * 上下文窗口守卫评估结果，扩展 ContextWindowInfo 增加警告和阻断标志。
 * @property shouldWarn - token 数低于警告阈值时为 true
 * @property shouldBlock - token 数低于硬阻断阈值时为 true（此时不应执行 agent）
 */
export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
};

/**
 * 评估上下文窗口是否足够大以安全运行 agent。
 *
 * 返回 shouldBlock=true 时，调用方应拒绝执行并提示用户切换模型。
 * 返回 shouldWarn=true 时，调用方应记录警告日志但允许继续执行。
 *
 * 注意：tokens=0（未知窗口大小）时不触发警告或阻断。
 *
 * @param params.info - 上下文窗口信息
 * @param params.warnBelowTokens - 自定义警告阈值（默认 CONTEXT_WINDOW_WARN_BELOW_TOKENS）
 * @param params.hardMinTokens - 自定义阻断阈值（默认 CONTEXT_WINDOW_HARD_MIN_TOKENS）
 * @returns 含 shouldWarn 和 shouldBlock 的守卫结果
 */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
