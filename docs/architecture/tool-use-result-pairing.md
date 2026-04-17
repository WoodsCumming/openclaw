# Tool Use / Tool Result 配对修复机制

> 本文档说明 OpenClaw 为何需要 `sanitizeToolUseResultPairing`，以及它在会话生命周期中的作用。

---

## 背景：Anthropic API 的强约束

Anthropic API 对消息结构有一条严格规则：

> **每个 `tool_result` 块必须在前一条消息中有对应的 `tool_use` 块。**

违反这条规则会返回 400 错误，导致会话进入无法自动恢复的死循环：

```
LLM request rejected: messages.N.content.1: unexpected tool_use_id found in
tool_result blocks: toolu_01XXX. Each tool_result block must have a
corresponding tool_use block in the previous message.
```

---

## 什么是"孤儿"配对？

正常的工具调用会话结构如下：

```
assistant message → [tool_use block (id: toolu_01XXX)]
user message     → [tool_result block (tool_use_id: toolu_01XXX)]
```

当 `tool_use` 和 `tool_result` 失去对应关系时，就产生了"孤儿"（orphan）块。以下场景都会触发这一问题：

| 场景 | 破坏方式 |
|------|---------|
| **工具调用中途中断** | 进程崩溃、超时或内容过滤，导致 `tool_use` 已发出但 `tool_result` 未写入，或反之 |
| **历史截断（`limitHistoryTurns`）** | 截断点落在 `tool_use` 和 `tool_result` 之间，将配对切断 |
| **会话压缩（compaction）** | 压缩算法不感知配对关系，可能只保留一侧 |
| **跨 Provider 切换** | OpenAI 格式 ID（`call_xxx`）和 Anthropic 格式（`toolu_xxx`）混入同一会话，sanitize 时删除格式不匹配的 `tool_use` 但遗留了对应的 `tool_result` |
| **重试时的 sanitize** | 重试路径删除了格式错误的 `tool_use`，但未同步删除对应的 `tool_result` |

---

## `sanitizeToolUseResultPairing` 的作用

该函数在发送请求前对会话历史进行修复：

```
会话历史（可能存在孤儿块）
         │
         ▼
┌─────────────────────────────────────────┐
│      sanitizeToolUseResultPairing()     │
│                                         │
│  1. 扫描所有 assistant 消息             │
│     提取有效的 tool_use ID 集合         │
│                                         │
│  2. 扫描所有 user 消息                  │
│     找出引用了不存在 tool_use ID 的     │
│     孤儿 tool_result 块                 │
│                                         │
│  3. 删除孤儿 tool_result                │
│     （或为有效 tool_use 补合成          │
│      缺失的 tool_result stub）          │
└─────────────────────────────────────────┘
         │
         ▼
干净的会话历史 → 发送给 Anthropic API ✓
```

---

## 时序陷阱：修复必须在截断之后运行

这是历史上反复出现 bug 的根本原因——**修复函数必须在所有可能破坏配对的操作之后运行**。

**错误顺序（曾导致 bug）：**

```
repairToolUseResultPairing()   ← 修复
limitHistoryTurns()            ← 截断，再次破坏配对
compaction()                   ← 压缩，可能再次破坏配对
发送 API → 400 错误
```

**正确顺序：**

```
limitHistoryTurns()
compaction()
repairToolUseResultPairing()   ← 修复（在所有截断操作之后）
发送 API → OK
```

相关实现位于 `src/agents/session-transcript-repair.ts`，管道编排位于 `src/agents/pi-embedded-runner/compact.ts`。

---

## 相关机制

- **`repairToolCallInputs`**：在 `sanitizeToolUseResultPairing` 之前运行，负责删除格式错误的 `tool_use` 块（缺少 `input`/`arguments`，或包含 `partialJson` 等流式残留字段）。两者需配合使用：前者删除无效的 `tool_use`，后者清理随之产生的孤儿 `tool_result`。

- **`sanitizeToolCallId`**：在写入时将跨 Provider 的工具调用 ID 规范化为字母数字格式，从源头减少 ID 格式不匹配问题（见 `src/agents/session-tool-result-guard.ts`）。

- **`transcript-sanitize` 扩展**：通过 `context` 事件钩子，在每次上下文构建时运行 `repairToolUseResultPairing`，而不只是在会话加载时运行一次。

---

## 用户侧影响与临时恢复

当会话因孤儿 `tool_result` 进入 400 错误死循环时，唯一的临时恢复方式是：

```
/new   # 开启新会话（丢失当前上下文）
/reset # 重置当前会话
```

`sanitizeToolUseResultPairing` 的目标正是消除这种需要手动干预的场景。

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/agents/session-transcript-repair.ts` | 核心修复逻辑 |
| `src/agents/session-tool-result-guard.ts` | 写入时 ID 规范化 |
| `src/agents/pi-embedded-runner/compact.ts` | 管道编排（修复时序） |
| `src/agents/pi-embedded-runner/google.ts` | Google provider 的 sanitize 调用点 |
| `src/agents/pi-extensions/transcript-sanitize.ts` | 每次上下文构建时触发修复的扩展 |
