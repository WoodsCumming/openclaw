# 自动回复与消息分发架构文档

> 文件路径：`src/auto-reply/`
> 本文档描述 OpenClaw 消息入站分发与回复调度系统的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

`auto-reply` 模块是消息入站后的处理链，负责：
- 接收渠道适配器转发的消息
- 执行 allowlist 检查、防抖合并
- 路由解析并分发到 agent
- 处理 LLM 流式输出并分块推送到渠道
- 支持内联指令（`@model`、`@think` 等）

---

## 2. 目录结构

```
src/auto-reply/
├── dispatch.ts                  # 消息分发入口（dispatchInboundMessage）
├── reply/
│   ├── dispatch-from-config.ts  # 从配置分发回复（路由 + agent 调用）
│   ├── reply-dispatcher.ts      # 回复分发器（管理并发和打字状态）
│   ├── inbound-context.ts       # 入站上下文最终化
│   ├── reply-delivery.ts        # 回复交付（发送到渠道）
│   ├── reply-threading.ts       # 线程回复处理
│   ├── line-directives.ts       # 内联指令解析
│   ├── history.ts               # 消息历史
│   ├── agent-runner.ts          # agent 运行器
│   └── commands-plugin.ts       # 插件命令处理
├── reply.ts                     # 回复生成（getReplyFromConfig）
├── inbound-debounce.ts          # 防抖合并（批量消息）
├── commands-registry.ts         # 命令注册表（/reset、/stop 等）
├── commands-registry.data.ts    # 内置命令数据
├── commands-args.ts             # 命令参数解析
├── heartbeat.ts                 # 心跳过滤
├── thinking.ts                  # 思考模式（ThinkLevel）
├── model.ts                     # 模型运行时配置
├── model-runtime.ts             # 模型运行时
├── send-policy.ts               # 发送策略
├── status.ts                    # 状态管理
├── group-activation.ts          # 群组激活（@提及触发）
├── chunk.ts                     # 流式分块处理
├── tokens.ts                    # Token 计数
├── media-note.ts                # 媒体附件处理
├── skill-commands.ts            # 技能命令
├── types.ts                     # 类型定义
└── templating.ts                # 消息模板（MsgContext）
```

---

## 3. 消息分发（`src/auto-reply/dispatch.ts`）

### 3.1 核心分发函数

```typescript
// src/auto-reply/dispatch.ts:17-33
// 确保 dispatcher 在所有退出路径上都释放预约
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
```

入站消息分发（标准路径）：

```typescript
// src/auto-reply/dispatch.ts:35-54
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
```

带打字状态的分发（自动管理渠道打字指示器）：

```typescript
// src/auto-reply/dispatch.ts:56-80
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
    return await dispatchInboundMessage({...});
  } finally {
    markDispatchIdle();  // 停止打字指示器
  }
}
```

---

## 4. 消息处理链

```
渠道适配器收到消息
      │
      ▼
allowlist 检查（src/channels/allowlists/）
      │
      ▼
inbound-debounce（防抖合并多条快速消息）
      │
      ▼
dispatchInboundMessage()
      │
      ├── finalizeInboundContext()  // 标准化入站上下文
      │
      ├── dispatchReplyFromConfig()
      │   ├── 路由解析（resolveAgentRoute）
      │   ├── 命令检测（/reset、/stop、插件命令）
      │   └── 入队 CommandLane（enqueueCommandInLane）
      │
      └── withReplyDispatcher()
          └── 等待所有回复发送完成
```

---

## 5. 内联指令（`src/auto-reply/reply/line-directives.ts`）

消息中可嵌入内联指令，在回复前解析并应用：

| 指令 | 说明 |
|------|------|
| `@model <id>` | 覆盖本次对话使用的模型 |
| `@think low/medium/high` | 设置思考强度 |
| `@verbose` | 开启详细模式 |

---

## 6. 回复分发器（`src/auto-reply/reply/reply-dispatcher.ts`）

`ReplyDispatcher` 管理回复的并发分发，确保：
- 流式分块有序推送
- 打字状态（typing indicator）生命周期管理
- 多渠道同步发送
- 所有回复发送完成后释放预约

---

## 7. 心跳过滤（`src/auto-reply/heartbeat.ts`）

LLM 流式输出中可能包含心跳标记（防止连接超时），回复分发时过滤掉这些标记，不发送给用户。

---

## 8. 关键类型

```typescript
// src/auto-reply/types.ts（GetReplyOptions）
export type GetReplyOptions = {
  onToolResult?: (result: ToolResult) => void;
  onBlockReply?: (reason: string) => void;
  // ...
};
```

```typescript
// src/auto-reply/templating.ts（MsgContext）
export type MsgContext = {
  channel: string;
  accountId?: string;
  from?: string;
  to?: string;
  text?: string;
  // ...
};
```
