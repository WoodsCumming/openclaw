import * as ops from "./service/ops.js";
import { type CronServiceDeps, createCronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent, CronServiceDeps } from "./service/state.js";

/**
 * OpenClaw 内置定时任务调度服务。
 *
 * 每个任务可绑定到特定 agent 会话，在指定时间自动触发 agent 执行。
 * 支持标准 5 字段 cron 表达式、每日/每周快捷配置，以及 webhook 回调。
 *
 * 使用方式：
 * ```ts
 * const svc = new CronService(deps);
 * await svc.start();
 * await svc.add({ name: "daily-report", schedule: "0 9 * * *", agentId: "main" });
 * ```
 *
 * 任务状态持久化到磁盘，Gateway 重启后自动恢复。
 */
export class CronService {
  private readonly state;
  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  /**
   * 启动 Cron 调度器。
   * 从磁盘加载持久化任务，启动内部调度循环，注册心跳监听器。
   * 应在 Gateway 启动完成后调用。
   */
  async start() {
    await ops.start(this.state);
  }

  /**
   * 停止 Cron 调度器。
   * 清理所有定时器，停止调度循环。
   * Gateway 关闭时调用，不等待正在运行的任务完成。
   */
  stop() {
    ops.stop(this.state);
  }

  /**
   * 获取所有 Cron 任务的当前状态快照。
   * @returns 包含每个任务的 id、name、schedule、lastRunAt、nextRunAt、lastStatus 等字段
   */
  async status() {
    return await ops.status(this.state);
  }

  /**
   * 列出所有 Cron 任务。
   * @param opts.includeDisabled - 是否包含已禁用的任务（默认 false）
   * @returns 任务列表
   */
  async list(opts?: { includeDisabled?: boolean }) {
    return await ops.list(this.state, opts);
  }

  /**
   * 分页列出 Cron 任务，适用于任务数量较多的场景。
   * @param opts - 分页选项（page、pageSize 等）
   */
  async listPage(opts?: ops.CronListPageOptions) {
    return await ops.listPage(this.state, opts);
  }

  /**
   * 添加新的 Cron 任务。
   * 任务立即持久化到磁盘，并在下次调度周期开始执行。
   * @param input - 任务创建参数（name、schedule、agentId、message 等）
   * @returns 创建的任务对象（含自动生成的 id）
   */
  async add(input: CronJobCreate) {
    return await ops.add(this.state, input);
  }

  /**
   * 更新现有 Cron 任务的配置。
   * 支持部分更新（仅传入需要修改的字段）。
   * @param id - 任务 ID
   * @param patch - 需要更新的字段（Partial<CronJobCreate>）
   * @returns 更新后的任务对象
   */
  async update(id: string, patch: CronJobPatch) {
    return await ops.update(this.state, id, patch);
  }

  /**
   * 删除 Cron 任务。
   * 立即从磁盘移除并停止调度。
   * @param id - 任务 ID
   */
  async remove(id: string) {
    return await ops.remove(this.state, id);
  }

  /**
   * 手动触发 Cron 任务执行。
   * @param id - 任务 ID
   * @param mode - 执行模式：
   *   - "due"（默认）：仅在任务到期时执行
   *   - "force"：强制立即执行，忽略调度时间
   */
  async run(id: string, mode?: "due" | "force") {
    return await ops.run(this.state, id, mode);
  }

  /**
   * 同步获取指定 Cron 任务对象。
   * @param id - 任务 ID
   * @returns 任务对象，不存在时返回 undefined
   */
  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }

  /**
   * 唤醒调度器立即检查并执行到期任务。
   * @param opts.mode - "now"：立即执行；"next-heartbeat"：等待下次心跳时执行
   * @param opts.text - 唤醒原因描述（用于日志）
   */
  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
