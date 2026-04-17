import { setTimeout as delay } from "node:timers/promises";

/**
 * 退避策略配置，控制指数退避的行为参数。
 *
 * @example
 * ```ts
 * const policy: BackoffPolicy = {
 *   initialMs: 100,  // 第一次重试等待 100ms
 *   maxMs: 5000,     // 最长不超过 5s
 *   factor: 2,       // 每次翻倍
 *   jitter: 0.1,     // 加 10% 随机抖动
 * };
 * ```
 */
export type BackoffPolicy = {
  /**
   * 第一次重试前的基础等待时间（毫秒）。
   * 后续每次重试的基础延迟为 `initialMs * factor^(attempt-1)`。
   */
  initialMs: number;

  /**
   * 单次等待时间的上限（毫秒）。
   * 即使指数计算结果超出此值，实际等待也不会超过 `maxMs`。
   */
  maxMs: number;

  /**
   * 指数增长的底数（乘法因子）。
   * 典型值为 `2`（每次等待翻倍）。
   * 设为 `1` 则退化为固定延迟。
   */
  factor: number;

  /**
   * 随机抖动系数，取值范围 `[0, 1)`。
   * 实际抖动量为 `base * jitter * Math.random()`，始终为正值（向上偏移）。
   * 设为 `0` 则不加抖动；设为 `0.5` 则最多在基础延迟上额外增加 50%。
   * 抖动可避免多个并发重试客户端同时触发请求（"惊群效应"）。
   */
  jitter: number;
};

/**
 * 根据退避策略和当前重试次数，计算本次应等待的毫秒数。
 *
 * **计算公式：**
 * ```
 * base   = initialMs * factor^(max(attempt - 1, 0))
 * jitter = base * policy.jitter * Math.random()   // 随机正向抖动
 * result = min(maxMs, round(base + jitter))
 * ```
 *
 * - `attempt = 1`：等待 `initialMs`（第一次重试）
 * - `attempt = 2`：等待 `initialMs * factor`
 * - `attempt = N`：等待 `initialMs * factor^(N-1)`，超过 `maxMs` 时截断
 *
 * @param policy - 退避策略配置
 * @param attempt - 当前重试序号，从 `1` 开始（`1` 表示第一次重试）
 * @returns 本次应等待的毫秒数（已加抖动并截断至 `maxMs`）
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/**
 * 异步等待指定毫秒数，支持通过 `AbortSignal` 提前取消。
 *
 * **与普通 `sleep` 的区别：**
 * - 普通 `sleep(ms)` 只能等满整个时间，无法中断。
 * - `sleepWithAbort` 接受一个可选的 `AbortSignal`；当 signal 被触发时，
 *   等待立即中止并抛出带有 `cause` 的 `Error("aborted")`，
 *   让调用方可以感知取消事件并做清理处理。
 * - 若 `ms <= 0` 则直接返回，不会进入等待。
 *
 * **典型用途：** 在可取消的重试循环中使用，确保外部取消信号（如用户中断、
 * 超时控制器）能即时生效，而不必等待整个退避窗口耗尽。
 *
 * @param ms - 等待时长（毫秒）；`<= 0` 时立即返回
 * @param abortSignal - 可选的取消信号；触发后立即中止等待并抛出错误
 * @throws `Error("aborted")` — 当 `abortSignal` 在等待期间被触发时抛出
 */
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }
  try {
    await delay(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) {
      throw new Error("aborted", { cause: err });
    }
    throw err;
  }
}
