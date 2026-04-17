import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
import { CommandLane } from "./lanes.js";

/**
 * 当队列中的命令因所在 Lane 被清空而被拒绝时抛出的专用错误类型。
 *
 * 以 fire-and-forget 方式入队任务的调用方可以捕获此类型，
 * 避免产生未处理的 Promise rejection 噪声。
 */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

/**
 * 当 Gateway 正在为重启进行排水（draining）时，新命令入队被拒绝时抛出的专用错误类型。
 *
 * 这避免了在 Gateway 关闭过程中新任务被无声地丢弃——调用方会立即收到明确的失败信号。
 */
export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining for restart; new tasks are not accepted");
    this.name = "GatewayDrainingError";
  }
}

/**
 * 全局排水标志。
 * 当 Gateway 正在为重启进行排水时置为 `true`，此后所有新的 `enqueueCommandInLane` 调用
 * 都会立即以 `GatewayDrainingError` 失败，而不是被压入队列后在关闭时被强制终止。
 */
let gatewayDraining = false;

/**
 * 进程内命令队列的最小实现，用于串行化命令执行。
 *
 * **Lane 机制概述：**
 * - 默认 Lane (`"main"`) 保持原有的单任务串行行为。
 * - 额外的 Lane（如 `"cron"`、`"subagent"`、`"nested"`）允许低风险的并行执行，
 *   而不会与主自动回复工作流的 stdin/日志产生交叉。
 * - 每个 Lane 拥有独立的任务队列和并发计数器，Lane 之间彼此不阻塞。
 * - 默认并发数为 1（串行），可通过 `setCommandLaneConcurrency` 调整。
 */

/**
 * 队列中单个条目的内部结构。
 */
type QueueEntry = {
  /** 待执行的异步任务函数 */
  task: () => Promise<unknown>;
  /** 任务成功完成时的 Promise resolve 回调 */
  resolve: (value: unknown) => void;
  /** 任务失败时的 Promise reject 回调 */
  reject: (reason?: unknown) => void;
  /** 任务入队时的时间戳（毫秒），用于计算等待时长 */
  enqueuedAt: number;
  /**
   * 超过此等待时长（毫秒）后触发警告日志及 `onWait` 回调。
   * 默认值为 2000ms。
   */
  warnAfterMs: number;
  /**
   * 可选的等待超时回调。
   * 当任务在队列中等待超过 `warnAfterMs` 时被调用。
   * @param waitMs      实际等待的毫秒数
   * @param queuedAhead 当前队列中仍在此任务前面的条目数
   */
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

/**
 * 单个 Lane 的运行时状态。
 */
type LaneState = {
  /** Lane 名称（与 `CommandLane` 枚举值对应，或自定义字符串） */
  lane: string;
  /** 等待执行的任务队列（先进先出） */
  queue: QueueEntry[];
  /** 当前正在执行的任务 ID 集合，用于并发计数 */
  activeTaskIds: Set<number>;
  /** 允许同时执行的最大任务数，默认为 1 */
  maxConcurrent: number;
  /**
   * 内部排水锁，防止 `drainLane` 重入。
   * `true` 时表示 `pump` 循环正在运行，避免并发调用产生多余的执行链。
   */
  draining: boolean;
  /**
   * Lane 代次（generation）计数器。
   * 每次调用 `resetAllLanes` 时递增，用于识别并丢弃旧代次任务完成的回调，
   * 防止 SIGUSR1 热重启后残留的 stale active task ID 永久阻塞新任务。
   */
  generation: number;
};

/** 所有 Lane 的状态映射表，以 Lane 名称为键 */
const lanes = new Map<string, LaneState>();

/** 单调递增的任务 ID 生成器，用于唯一标识每个正在执行的任务 */
let nextTaskId = 1;

/**
 * 获取指定 Lane 的运行时状态，若不存在则创建并注册。
 *
 * 新创建的 Lane 默认配置：
 * - `maxConcurrent = 1`（串行执行）
 * - `draining = false`
 * - `generation = 0`
 *
 * @param lane Lane 名称
 * @returns 该 Lane 的 `LaneState` 对象（复用已有或新建）
 */
function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  };
  lanes.set(lane, created);
  return created;
}

/**
 * 将指定任务从活跃集合中移除，完成一次任务执行计数。
 *
 * 若 `taskGeneration` 与当前 Lane 的 `generation` 不匹配，说明该任务
 * 属于上一代（热重启前），其完成回调应被忽略，返回 `false`。
 *
 * @param state          Lane 的运行时状态
 * @param taskId         要完成的任务 ID
 * @param taskGeneration 任务启动时的 Lane 代次
 * @returns 若任务属于当前代次并成功移除返回 `true`，否则返回 `false`
 */
function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  state.activeTaskIds.delete(taskId);
  return true;
}

/**
 * 启动（或重新启动）指定 Lane 的任务泵（pump loop）。
 *
 * **执行流程：**
 * 1. 检查 `state.draining` 重入锁，若已在运行则直接返回（附带警告日志）。
 * 2. 置 `draining = true` 加锁，进入 `pump()` 内循环。
 * 3. `pump()` 持续从队列头部取出条目，直到达到 `maxConcurrent` 上限或队列为空：
 *    - 检查等待时长，超过 `warnAfterMs` 则触发 `onWait` 回调及警告日志。
 *    - 分配唯一 `taskId` 并记录 `taskGeneration`，加入 `activeTaskIds`。
 *    - 以 `void (async () => {...})()` 方式异步启动任务（不阻塞 pump 循环）。
 *    - 任务完成（成功或失败）后调用 `completeTask` 移除活跃 ID，并再次调用 `pump()`
 *      以驱动队列中的下一个任务。
 * 4. `pump()` 返回后（无论正常还是异常）解除 `draining` 锁。
 *
 * **并发控制：**
 * - 同一时刻活跃任务数不超过 `state.maxConcurrent`。
 * - 当队列满（活跃数已达上限）时，新任务仅被压入 `state.queue` 等待，
 *   下一个任务完成后的 `pump()` 递归调用才会将其取出执行。
 * - 探测类 Lane（`auth-probe:*`、`session:probe-*`）的错误不记录 error 日志，
 *   避免干扰正常日志流。
 *
 * @param lane Lane 名称
 */
function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return;
  }
  state.draining = true;

  const pump = () => {
    try {
      while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
        const entry = state.queue.shift() as QueueEntry;
        const waitedMs = Date.now() - entry.enqueuedAt;
        if (waitedMs >= entry.warnAfterMs) {
          try {
            entry.onWait?.(waitedMs, state.queue.length);
          } catch (err) {
            diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
          }
          diag.warn(
            `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`,
          );
        }
        logLaneDequeue(lane, waitedMs, state.queue.length);
        const taskId = nextTaskId++;
        const taskGeneration = state.generation;
        state.activeTaskIds.add(taskId);
        void (async () => {
          const startTime = Date.now();
          try {
            const result = await entry.task();
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            if (completedCurrentGeneration) {
              diag.debug(
                `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
              );
              pump();
            }
            entry.resolve(result);
          } catch (err) {
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            // 探测类 Lane 的错误属于正常的探测失败，不记录 error 日志以减少噪声
            const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
            if (!isProbeLane) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
              );
            }
            if (completedCurrentGeneration) {
              pump();
            }
            entry.reject(err);
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  };

  pump();
}

/**
 * 将 Gateway 标记为正在为重启进行排水（draining）。
 *
 * 调用后，所有新的 `enqueueCommandInLane` 调用都会立即以 `GatewayDrainingError` 拒绝，
 * 而不是被压入队列后在关闭时被强制终止。
 * 已在队列或正在执行的任务不受影响。
 */
export function markGatewayDraining(): void {
  gatewayDraining = true;
}

/**
 * 设置指定 Lane 的最大并发任务数。
 *
 * 修改生效后立即触发一次 `drainLane`，以便在并发上限提高时
 * 立刻消费队列中积压的任务。
 *
 * @param lane          Lane 名称（空字符串时退回到 `CommandLane.Main`）
 * @param maxConcurrent 最大并发数，最小值为 1（向下取整后与 1 取最大值）
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

/**
 * 将任务入队到指定 Lane，并返回代表其最终结果的 Promise。
 *
 * **入队与执行流程：**
 * 1. 若 `gatewayDraining` 为 `true`，立即以 `GatewayDrainingError` 拒绝。
 * 2. 规范化 Lane 名称（去除首尾空格，空串退回 `CommandLane.Main`）。
 * 3. 将 `{ task, resolve, reject, enqueuedAt, warnAfterMs, onWait }` 压入 Lane 队列尾部。
 * 4. 调用 `drainLane` 触发任务泵——若当前活跃数未达 `maxConcurrent` 上限，任务立即开始执行；
 *    否则任务留在队列中，等待前序任务完成后的 `pump()` 递归调用取出执行。
 * 5. 返回 Promise，在任务执行完成时 resolve/reject。
 *
 * **队列满时的行为（并发限制）：**
 * - 不抛出错误、不丢弃任务——新任务始终会被入队。
 * - 若等待时间超过 `warnAfterMs`（默认 2000ms），取出时触发 `onWait` 回调及警告日志。
 * - 调用方可通过 `onWait` 回调感知积压情况并采取措施（例如向用户发送"处理中"提示）。
 *
 * @param lane  目标 Lane 名称（推荐使用 `CommandLane` 枚举值）
 * @param task  待执行的异步任务函数
 * @param opts  可选配置
 * @param opts.warnAfterMs  等待超过此毫秒数时触发警告，默认 2000ms
 * @param opts.onWait       等待超时回调，参数为实际等待毫秒数和前方队列长度
 * @returns 任务执行结果的 Promise，类型与 `task` 的返回值类型一致
 */
export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  if (gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = lane.trim() || CommandLane.Main;
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, state.queue.length + state.activeTaskIds.size);
    drainLane(cleaned);
  });
}

/**
 * 将任务入队到主 Lane（`CommandLane.Main`）的快捷方式。
 *
 * 等价于 `enqueueCommandInLane(CommandLane.Main, task, opts)`。
 * 用于主自动回复工作流，保证同一会话内消息串行处理。
 *
 * @param task  待执行的异步任务函数
 * @param opts  可选配置（同 `enqueueCommandInLane`）
 * @returns 任务执行结果的 Promise
 */
export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

/**
 * 获取指定 Lane 的当前队列大小（含正在执行的任务数）。
 *
 * 返回值 = 队列中等待的条目数 + 当前活跃任务数，
 * 即该 Lane 上"尚未完成的工作总量"。
 *
 * @param lane Lane 名称，默认为 `CommandLane.Main`
 * @returns 未完成任务总数；若 Lane 不存在返回 0
 */
export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = lane.trim() || CommandLane.Main;
  const state = lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.activeTaskIds.size;
}

/**
 * 获取所有 Lane 的未完成任务总数（含正在执行和排队等待的任务）。
 *
 * @returns 全局未完成任务总数
 */
export function getTotalQueueSize() {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.activeTaskIds.size;
  }
  return total;
}

/**
 * 清空指定 Lane 队列中所有尚未开始执行的任务，并以 `CommandLaneClearedError` 拒绝它们。
 *
 * 注意：**正在执行**的任务不受影响，会继续运行至完成。
 * 此操作常用于会话重置或用户取消场景，快速释放积压的待处理请求。
 *
 * @param lane Lane 名称，默认为 `CommandLane.Main`
 * @returns 被移除（拒绝）的队列条目数量
 */
export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(cleaned));
  }
  return removed;
}

/**
 * 将所有 Lane 的运行时状态重置为空闲。
 *
 * **适用场景：** SIGUSR1 触发的进程内热重启（in-process restart）。
 * 热重启时被中断任务的 `finally` 块可能未执行，导致 `activeTaskIds` 中残留
 * stale 条目，永久阻塞新任务的排水。
 *
 * **重置策略：**
 * - 递增 `generation` 计数器，使旧代次任务的完成回调失效（被 `completeTask` 忽略）。
 * - 清空 `activeTaskIds`，解除并发上限阻塞。
 * - 重置 `draining` 锁，允许 `drainLane` 重新进入。
 * - **保留** `queue` 中已入队但未执行的条目——这些代表用户待处理的工作，
 *   应在重启后继续执行。
 * - 重置完成后，对所有仍有待处理条目的 Lane 立即触发 `drainLane`，
 *   使积压任务尽快开始执行，而无需等待下一次 `enqueueCommandInLane` 调用。
 * - 同时清除 `gatewayDraining` 标志，允许新任务入队。
 */
export function resetAllLanes(): void {
  gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // 先完成所有 Lane 的重置，再统一触发排水，确保各 Lane 均处于干净状态
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
}

/**
 * 返回所有 Lane 中当前正在执行的任务总数（不含排队等待的条目）。
 *
 * @returns 活跃任务总数
 */
export function getActiveTaskCount(): number {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * 等待所有**当前正在执行**的任务完成，或直到超时。
 *
 * **行为说明：**
 * - 仅等待调用时已处于活跃状态的任务（快照于调用瞬间）；
 *   调用后新入队或新开始执行的任务**不在等待范围内**。
 * - 以 `POLL_INTERVAL_MS`（50ms）轮询检查活跃集合，响应迅速但不会忙等。
 * - 超时后以 `{ drained: false }` resolve，而非 reject，让调用方自行决定后续处理。
 *
 * **典型用途：** Gateway 优雅关闭时，先等待进行中的任务完成，再终止进程。
 *
 * @param timeoutMs 最长等待毫秒数；超时后返回 `{ drained: false }`
 * @returns Promise，resolve 为 `{ drained: true }` 表示所有活跃任务已完成，
 *          `{ drained: false }` 表示等待超时仍有任务未完成
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  // 保持关闭/排水检查的响应性，同时避免忙等循环
  const POLL_INTERVAL_MS = 50;
  const deadline = Date.now() + timeoutMs;
  // 快照调用时刻的活跃任务 ID 集合
  const activeAtStart = new Set<number>();
  for (const state of lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      activeAtStart.add(taskId);
    }
  }

  return new Promise((resolve) => {
    const check = () => {
      if (activeAtStart.size === 0) {
        resolve({ drained: true });
        return;
      }

      let hasPending = false;
      for (const state of lanes.values()) {
        for (const taskId of state.activeTaskIds) {
          if (activeAtStart.has(taskId)) {
            hasPending = true;
            break;
          }
        }
        if (hasPending) {
          break;
        }
      }

      if (!hasPending) {
        resolve({ drained: true });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ drained: false });
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}
