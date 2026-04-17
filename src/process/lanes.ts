/**
 * 命令 Lane 枚举，定义进程内命令队列的并发通道。
 *
 * 每个 Lane 对应一类任务的隔离执行通道，默认并发数均为 1（串行），
 * 可通过 `setCommandLaneConcurrency` 按需调整。
 *
 * Lane 之间**没有内置的优先级顺序**——各 Lane 独立运行自己的队列，
 * 互不阻塞；优先级语义需由调用方在入队侧自行管理。
 *
 * | Lane       | 默认并发 | 用途说明                                         |
 * |------------|----------|--------------------------------------------------|
 * | Main       | 1        | 主 Auto-reply 工作流，串行保证日志和 stdin 不交叉  |
 * | Cron       | 1        | 定时任务（cron job），低风险并行但独立于主流程     |
 * | Subagent   | 1        | 子 Agent 调用，与主 Agent 隔离                   |
 * | Nested     | 1        | 嵌套 Agent 调用（Nested agent），进一步隔离层级   |
 */
export const enum CommandLane {
  /**
   * 主 Lane：处理用户消息触发的主自动回复流程。
   * 串行执行，保证同一会话内消息顺序处理，防止日志/stdin 交叉。
   * 这是 `enqueueCommand()` 的默认 Lane。
   */
  Main = "main",

  /**
   * Cron Lane：处理定时调度任务。
   * 与主 Lane 独立，cron 任务不会阻塞正常的用户消息处理，
   * 也不会被主 Lane 的繁忙状态延迟。
   */
  Cron = "cron",

  /**
   * Subagent Lane：处理子 Agent 的命令执行。
   * 将子 Agent 的工作与主 Agent 隔离，避免相互干扰。
   */
  Subagent = "subagent",

  /**
   * Nested Lane：处理嵌套 Agent 调用（Agent 内再调用 Agent）。
   * 提供额外的隔离层级，防止嵌套调用链阻塞外层 Agent 的执行。
   */
  Nested = "nested",
}
