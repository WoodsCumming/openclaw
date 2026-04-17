import type { OpenClawConfig } from "../config/config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

/** 入站消息分发结果，透传自 dispatchReplyFromConfig 的返回类型。 */
export type DispatchInboundResult = DispatchFromConfigResult;

/**
 * 带 dispatcher 生命周期管理的异步执行包装器。
 *
 * 确保在所有退出路径（正常返回、异常抛出）上都执行：
 * 1. dispatcher.markComplete()：标记主逻辑已完成，停止接受新回复
 * 2. dispatcher.waitForIdle()：等待所有已入队的回复发送完毕
 * 3. onSettled()：可选的清理回调（如停止打字指示器）
 *
 * @param params.dispatcher - 回复分发器实例
 * @param params.run - 主逻辑函数（通常是 agent 执行）
 * @param params.onSettled - 所有回复发送完毕后的清理回调
 * @returns run() 的返回值
 */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

/**
 * 分发入站消息到 agent 并等待回复发送完成（标准路径）。
 *
 * 执行流程：
 * 1. finalizeInboundContext：补全消息上下文（时间戳、规范化字段等）
 * 2. dispatchReplyFromConfig：路由解析 → 命令检测 → agent 执行 → 回复分发
 * 3. withReplyDispatcher：确保 dispatcher 在所有路径上正确释放
 *
 * @param params.ctx - 入站消息上下文（MsgContext 或已最终化的 FinalizedMsgContext）
 * @param params.cfg - 当前 OpenClaw 配置
 * @param params.dispatcher - 预先创建的回复分发器
 * @param params.replyOptions - 可选的回复选项（不含 onToolResult/onBlockReply）
 * @param params.replyResolver - 可选的自定义回复生成函数（测试用）
 */
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

/**
 * 分发入站消息，自动管理打字指示器生命周期（带 typing 的路径）。
 *
 * 相比 {@link dispatchInboundMessage}，额外：
 * - 通过 createReplyDispatcherWithTyping 创建带打字状态的 dispatcher
 * - 在 finally 中调用 markDispatchIdle() 停止打字指示器
 * - 合并 dispatcherOptions 中的 replyOptions 与外部传入的 replyOptions
 *
 * 适用于渠道支持打字指示器（如 Telegram、Discord）的场景。
 *
 * @param params.dispatcherOptions - 含打字配置的 dispatcher 选项（包括渠道、accountId 等）
 */
export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

/**
 * 分发入站消息，内部创建 dispatcher（不带 typing 的简单路径）。
 *
 * 适用于不需要打字指示器，或 dispatcher 需要按选项动态创建的场景。
 * 等价于先 createReplyDispatcher(opts) 再调用 {@link dispatchInboundMessage}。
 *
 * @param params.dispatcherOptions - dispatcher 创建选项
 */
export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
