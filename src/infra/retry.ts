import { sleep } from "../utils.js";

/**
 * 重试行为的基础配置参数。
 * 所有字段均为可选；未提供时使用 {@link DEFAULT_RETRY_CONFIG} 中的默认值。
 */
export type RetryConfig = {
  /**
   * 最大尝试总次数（含首次执行）。
   * 默认值：`3`（即首次执行 + 最多 2 次重试）。
   * 最小有效值为 `1`（不重试）。
   */
  attempts?: number;

  /**
   * 两次重试之间的最短等待时间（毫秒）。
   * 默认值：`300`ms。
   * 也作为指数退避的初始基础延迟（`attempt=1` 时的延迟）。
   */
  minDelayMs?: number;

  /**
   * 两次重试之间的最长等待时间（毫秒）。
   * 默认值：`30_000`ms（30 秒）。
   * 指数计算结果超出此值时会被截断。
   */
  maxDelayMs?: number;

  /**
   * 随机抖动系数，取值范围 `[0, 1)`。
   * 默认值：`0`（不加抖动）。
   * 抖动以双向方式施加：实际延迟在 `delay * (1 - jitter)` 到 `delay * (1 + jitter)` 之间均匀随机。
   * 例如 `jitter=0.2` 表示延迟在 ±20% 范围内随机浮动。
   */
  jitter?: number;
};

/**
 * 每次触发重试回调（{@link RetryOptions.onRetry}）时传递的上下文信息。
 */
export type RetryInfo = {
  /** 刚刚失败的尝试序号（从 `1` 开始）。 */
  attempt: number;
  /** 配置的最大尝试次数上限。 */
  maxAttempts: number;
  /** 本次重试前将等待的毫秒数（已应用抖动和上下限）。 */
  delayMs: number;
  /** 本次失败抛出的错误对象。 */
  err: unknown;
  /** 调用方传入的标签字符串，用于日志标识（可选）。 */
  label?: string;
};

/**
 * {@link retryAsync} 的完整选项，在 {@link RetryConfig} 基础上扩展了
 * 回调函数和标签字段。
 */
export type RetryOptions = RetryConfig & {
  /**
   * 可读标签，用于日志/监控中标识重试来源（例如 `"fetchUser"`）。
   * 该值会透传到 {@link RetryInfo.label}。
   */
  label?: string;

  /**
   * 自定义"是否应该重试"的判断回调。
   *
   * **用途：** 区分可重试错误和不可重试错误。
   * - 返回 `true`：允许继续重试。
   * - 返回 `false`：立即放弃并将错误向上抛出，不等待、不继续。
   *
   * **典型用法：**
   * - 网络超时、5xx 错误 → 返回 `true`（可重试）
   * - 4xx 客户端错误（如 401/403/404）→ 返回 `false`（不应重试）
   * - `AbortError` → 返回 `false`（已取消，不应重试；重试也会立即再次中止）
   *
   * 未提供时默认所有错误均可重试（等价于 `() => true`）。
   *
   * @param err - 本次失败抛出的错误
   * @param attempt - 当前已执行的尝试次数（从 `1` 开始）
   * @returns `true` 表示继续重试，`false` 表示立即放弃
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;

  /**
   * 从错误对象中提取服务端指定的"重试等待时间"（毫秒）。
   *
   * 通常用于解析 HTTP `Retry-After` 响应头。若返回有限数值，
   * 则该值与 `minDelayMs` 取较大值后作为本次重试的基础延迟，
   * 替代默认的指数退避计算结果。
   *
   * @param err - 本次失败抛出的错误
   * @returns 服务端建议的等待毫秒数；返回 `undefined` 则使用默认指数退避
   */
  retryAfterMs?: (err: unknown) => number | undefined;

  /**
   * 每次决定重试（等待前）触发的回调，用于日志记录或监控上报。
   *
   * @param info - 包含本次重试上下文的 {@link RetryInfo} 对象
   */
  onRetry?: (info: RetryInfo) => void;
};

/**
 * 重试的默认配置：最多尝试 3 次，首次重试等待 300ms，最长等待 30s，不加抖动。
 */
const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

/**
 * 将任意值转换为有限数字，非数字或 Infinity/-Infinity 返回 `undefined`。
 *
 * @param value - 待检查的值
 * @returns 有限数字或 `undefined`
 */
const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * 将数值钳制在 `[min, max]` 范围内，并在无效输入时回退到 `fallback`。
 *
 * @param value - 待处理的值（可能非数字）
 * @param fallback - 当 `value` 不是有限数字时使用的默认值
 * @param min - 下限（可选）
 * @param max - 上限（可选）
 * @returns 钳制后的数值
 */
const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

/**
 * 将用户提供的 {@link RetryConfig} 与默认值合并，产出经过验证和规范化的完整配置。
 *
 * - `attempts` 至少为 `1`（不允许零次尝试）。
 * - `minDelayMs` 至少为 `0`。
 * - `maxDelayMs` 不低于 `minDelayMs`（自动修正）。
 * - `jitter` 被钳制在 `[0, 1]`。
 *
 * @param defaults - 基础默认配置，默认使用 {@link DEFAULT_RETRY_CONFIG}
 * @param overrides - 调用方提供的覆盖配置（部分字段可选）
 * @returns 规范化后的完整 {@link RetryConfig}
 */
export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
  const minDelayMs = Math.max(
    0,
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
  );
  const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

/**
 * 对延迟时间施加双向随机抖动。
 *
 * 抖动公式：`delay * (1 + offset)`，其中 `offset ∈ [-jitter, +jitter]` 均匀分布。
 * 结果被 `round` 并确保不小于 `0`。
 *
 * @param delayMs - 基础延迟时间（毫秒）
 * @param jitter - 抖动系数 `[0, 1)`；`<= 0` 时直接返回原值
 * @returns 加入抖动后的延迟时间（毫秒，非负整数）
 */
function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0) {
    return delayMs;
  }
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

/**
 * 异步重试包装器，支持指数退避、抖动、自定义重试策略和服务端 `Retry-After`。
 *
 * ## 两种调用模式
 *
 * ### 简单模式（传入数字）
 * ```ts
 * await retryAsync(() => fetchData(), 3, 300);
 * // 最多尝试 3 次，延迟序列为 300ms、600ms（纯指数，无抖动）
 * ```
 * 延迟计算：`initialDelayMs * 2^i`（`i` 从 0 开始），不应用 `maxDelayMs` 上限。
 *
 * ### 完整模式（传入 RetryOptions）
 * ```ts
 * await retryAsync(() => fetchData(), {
 *   attempts: 5,
 *   minDelayMs: 200,
 *   maxDelayMs: 10_000,
 *   jitter: 0.2,
 *   shouldRetry: (err) => !(err instanceof AbortError),
 *   onRetry: (info) => logger.warn(`重试 #${info.attempt}`, info),
 * });
 * ```
 *
 * ## 重试策略（完整模式）
 *
 * 1. **指数退避**：基础延迟为 `minDelayMs * 2^(attempt-1)`，随着重试次数指数增长。
 * 2. **上限截断**：超过 `maxDelayMs` 时截断（默认 30s）。
 * 3. **抖动**：对截断后的延迟施加 ±`jitter` 比例的随机偏移，避免"惊群效应"。
 * 4. **Retry-After 优先**：若 `retryAfterMs` 回调返回有效值，则取该值与 `minDelayMs` 的较大值
 *    作为基础延迟，跳过指数退避计算。
 * 5. **重试判断**：每次失败后先调用 `shouldRetry`；返回 `false` 时立即放弃，不等待。
 *
 * ## 关于 AbortError
 *
 * `AbortError`（或带有 `name === "AbortError"` 的错误）**不应重试**：
 * - 它表示操作已被调用方主动取消（例如用户中断、超时控制器触发）。
 * - 重试只会再次立即被中止，造成无意义的循环和资源浪费。
 * - 应在 `shouldRetry` 中显式排除：
 *   ```ts
 *   shouldRetry: (err) => (err as Error)?.name !== "AbortError"
 *   ```
 *
 * @param fn - 要执行和重试的异步函数
 * @param attemptsOrOptions - 简单模式：最大尝试次数（数字）；完整模式：{@link RetryOptions} 对象
 * @param initialDelayMs - 简单模式下的初始延迟（毫秒），默认 `300`；完整模式下忽略
 * @returns `fn` 成功时的返回值
 * @throws 若所有尝试均失败，抛出最后一次捕获的错误（或通用 `Error("Retry failed")`）
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = Math.max(1, Math.round(attemptsOrOptions));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = initialDelayMs * 2 ** i;
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error("Retry failed");
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const jitter = resolved.jitter;
  // 未提供 shouldRetry 时默认所有错误均可重试
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 已达最大次数，或 shouldRetry 拒绝重试 → 立即放弃
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      // 优先使用服务端指定的 Retry-After，否则按指数退避计算基础延迟
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);
      let delay = Math.min(baseDelay, maxDelayMs);
      delay = applyJitter(delay, jitter);
      // 确保最终延迟始终在 [minDelayMs, maxDelayMs] 范围内
      delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      await sleep(delay);
    }
  }

  throw lastErr ?? new Error("Retry failed");
}
