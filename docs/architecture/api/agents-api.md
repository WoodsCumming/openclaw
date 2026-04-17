# Agents 模块 API 参考

本文档覆盖 OpenClaw `src/agents/` 目录中四个核心文件的完整函数级参考，包括精确行号、函数签名、参数说明、返回值说明，以及对关键算法的详细解释。

---

## context-window-guard.ts — 上下文窗口守卫

**路径**：`src/agents/context-window-guard.ts`

该模块负责在 agent 执行前评估模型上下文窗口的大小是否满足最低要求，防止因上下文窗口过小导致的截断错误。

---

### 常量

#### `CONTEXT_WINDOW_HARD_MIN_TOKENS`

- **位置**：`src/agents/context-window-guard.ts:8`
- **值**：`16_000`
- **说明**：上下文窗口硬阻断阈值。当模型上下文窗口的 token 数低于此值时，`evaluateContextWindowGuard` 返回 `shouldBlock=true`，调用方应拒绝执行 agent，避免因上下文空间不足导致的截断错误。

#### `CONTEXT_WINDOW_WARN_BELOW_TOKENS`

- **位置**：`src/agents/context-window-guard.ts:14`
- **值**：`32_000`
- **说明**：上下文窗口警告阈值。当 token 数低于此值但高于硬阻断阈值时，`evaluateContextWindowGuard` 返回 `shouldWarn=true`，调用方应记录警告日志并提示用户考虑切换到上下文更大的模型，但仍允许 agent 继续执行。

---

### 类型

#### `ContextWindowSource`

- **位置**：`src/agents/context-window-guard.ts:23`
- **定义**：

  ```ts
  type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";
  ```

- **说明**：上下文窗口大小的来源标识，用于追溯最终生效值的计算路径。各枚举值含义如下（按优先级从低到高排列）：

  | 值 | 来源 | 说明 |
  |---|---|---|
  | `"default"` | 调用方传入的 `defaultTokens` | 无其他来源时的最终回退值 |
  | `"model"` | 模型 SDK 返回的 `contextWindow` 字段 | Provider 官方声明的窗口大小 |
  | `"modelsConfig"` | `models.providers[provider].models[id].contextWindow` | 用户在配置文件中对特定模型的自定义覆盖 |
  | `"agentContextTokens"` | `agents.defaults.contextTokens` | 全局上限配置，低于基础值时才生效 |

#### `ContextWindowInfo`

- **位置**：`src/agents/context-window-guard.ts:29`
- **定义**：

  ```ts
  type ContextWindowInfo = {
    tokens: number;
    source: ContextWindowSource;
  };
  ```

- **说明**：上下文窗口信息的基础结构，由 `resolveContextWindowInfo` 计算并传入 `evaluateContextWindowGuard` 进行评估。`tokens` 为最终生效的 token 数，`source` 标记该值的来源。

#### `ContextWindowGuardResult`

- **位置**：`src/agents/context-window-guard.ts:98`
- **定义**：

  ```ts
  type ContextWindowGuardResult = ContextWindowInfo & {
    shouldWarn: boolean;
    shouldBlock: boolean;
  };
  ```

- **说明**：上下文窗口守卫的评估结果，在 `ContextWindowInfo` 基础上增加了两个布尔标志：
  - `shouldWarn`：token 数 > 0 且低于警告阈值时为 `true`
  - `shouldBlock`：token 数 > 0 且低于硬阻断阈值时为 `true`

  注意：`tokens=0` 表示未知窗口大小，此时两个标志均为 `false`（不触发任何警告或阻断）。

---

### 内部函数

#### `normalizePositiveInt(value)`

- **位置**：`src/agents/context-window-guard.ts:38`
- **签名**：`function normalizePositiveInt(value: unknown): number | null`
- **说明**：将任意值规范化为正整数，用于安全解析配置中的数字字段。
- **逻辑**：若 `value` 不是有限数字（`Number.isFinite` 为 `false`）、或取整后 ≤ 0，则返回 `null`；否则返回 `Math.floor(value)`。
- **访问性**：仅模块内部使用，不导出。

---

### 导出函数

#### `resolveContextWindowInfo(params)`

- **位置**：`src/agents/context-window-guard.ts:62`
- **签名**：

  ```ts
  function resolveContextWindowInfo(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    modelContextWindow?: number;
    defaultTokens: number;
  }): ContextWindowInfo
  ```

- **说明**：解析 agent 运行时实际可用的上下文窗口大小。该函数实现了一个四级优先级的来源合并逻辑：

  **优先级规则（高到低）**：
  1. **`agentContextTokens`（最高优先级，仅在低于基础值时生效）**：读取 `cfg.agents.defaults.contextTokens`；如果该值有效且**小于**基础值，则用此值覆盖，`source` 标记为 `"agentContextTokens"`。这是一个"上限配置"语义，只会降低窗口大小，不会增大。
  2. **`modelsConfig`**：读取 `cfg.models.providers[provider].models` 数组，找到 `id` 匹配的条目，使用其 `contextWindow` 字段。
  3. **`model`**：使用调用方传入的 `modelContextWindow`（来自模型 SDK 的官方值）。
  4. **`default`（最低优先级）**：使用 `params.defaultTokens` 作为最终回退值。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `cfg` | `OpenClawConfig \| undefined` | OpenClaw 配置对象，用于读取模型配置和 agent 上限 |
  | `provider` | `string` | LLM provider ID（如 `"anthropic"`） |
  | `modelId` | `string` | 模型 ID（如 `"claude-opus-4-6"`） |
  | `modelContextWindow` | `number?` | 模型 SDK 返回的上下文窗口大小（可选） |
  | `defaultTokens` | `number` | 无其他来源时的回退默认值 |

- **返回值**：`ContextWindowInfo`，包含最终生效的 `tokens` 和 `source`。

#### `evaluateContextWindowGuard(params)`

- **位置**：`src/agents/context-window-guard.ts:116`
- **签名**：

  ```ts
  function evaluateContextWindowGuard(params: {
    info: ContextWindowInfo;
    warnBelowTokens?: number;
    hardMinTokens?: number;
  }): ContextWindowGuardResult
  ```

- **说明**：评估上下文窗口是否足够大以安全运行 agent。接收来自 `resolveContextWindowInfo` 的 `ContextWindowInfo`，结合阈值计算 `shouldWarn` 和 `shouldBlock` 两个标志。

- **阈值处理**：
  - `warnBelowTokens` 默认为 `CONTEXT_WINDOW_WARN_BELOW_TOKENS`（32,000），取整后与 1 取最大值
  - `hardMinTokens` 默认为 `CONTEXT_WINDOW_HARD_MIN_TOKENS`（16,000），取整后与 1 取最大值
  - `tokens` 取 `max(0, floor(info.tokens))`，确保非负

- **标志计算逻辑**：
  - `shouldWarn = tokens > 0 && tokens < warnBelow`
  - `shouldBlock = tokens > 0 && tokens < hardMin`
  - `tokens === 0` 时（未知窗口大小）两个标志均为 `false`

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `info` | `ContextWindowInfo` | 由 `resolveContextWindowInfo` 计算的上下文窗口信息 |
  | `warnBelowTokens` | `number?` | 自定义警告阈值，默认 32,000 |
  | `hardMinTokens` | `number?` | 自定义硬阻断阈值，默认 16,000 |

- **返回值**：`ContextWindowGuardResult`，包含原 `ContextWindowInfo` 字段以及 `shouldWarn`、`shouldBlock` 标志。

- **调用方行为约定**：
  - `shouldBlock=true`：拒绝执行 agent，提示用户切换到上下文更大的模型
  - `shouldWarn=true`：记录警告日志，但允许继续执行

---

## compaction.ts — 会话历史压缩

**路径**：`src/agents/compaction.ts`

该模块实现了 agent 会话历史的压缩（compaction）逻辑，在上下文窗口接近满载时，通过摘要生成和历史裁剪来为新的消息腾出空间。核心机制包含 token 估算、分块策略、渐进式摘要降级和历史预算管理。

---

### 常量

#### `BASE_CHUNK_RATIO`

- **位置**：`src/agents/compaction.ts:16`
- **值**：`0.4`
- **说明**：历史压缩的基础分块比例（40%）。每次压缩时，默认将最旧的 40% 历史消息作为待压缩块，保留最近的 60%。实际比例由 `computeAdaptiveChunkRatio` 根据消息大小动态调整。

#### `MIN_CHUNK_RATIO`

- **位置**：`src/agents/compaction.ts:17`
- **值**：`0.15`
- **说明**：自适应分块比例的下限（15%）。当平均消息体积很大时，`computeAdaptiveChunkRatio` 可能会将比例降至此下限，以避免单个压缩块超出模型上下文限制。

#### `SAFETY_MARGIN`

- **位置**：`src/agents/compaction.ts:18`
- **值**：`1.2`（即 20% 安全裕度）
- **说明**：Token 估算的安全补偿系数。`estimateTokens` 使用 `chars/4` 启发式算法，会低估多字节字符（如中文）、代码 token、特殊符号等的实际 token 消耗。乘以 1.2 可在大多数场景下避免因低估导致的上下文溢出。

#### `SUMMARIZATION_OVERHEAD_TOKENS`

- **位置**：`src/agents/compaction.ts:107`
- **值**：`4096`
- **说明**：摘要生成时预留的 overhead token 预算，包含摘要 prompt、system prompt、前一次摘要文本、XML 标签包装等固定开销。`generateSummary` 使用 `reasoning:"high"` 时还会额外消耗上下文预算，此常量为统一的安全余量。

---

### 导出函数

#### `estimateMessagesTokens(messages)`

- **位置**：`src/agents/compaction.ts:34`
- **签名**：

  ```ts
  function estimateMessagesTokens(messages: AgentMessage[]): number
  ```

- **说明**：估算消息列表的总 token 数。在调用底层 `estimateTokens` 之前，先通过 `stripToolResultDetails` 剥离工具调用结果（`toolResult.details`）中的详细内容。

- **安全注意**：`toolResult.details` 可能包含来自 bash 命令输出、文件读取等不可信的大量文本，不应计入面向 LLM 的 token 估算中（防止被恶意工具输出操控压缩决策）。

- **token 估算算法**：底层使用 `chars / 4` 启发式，对英文文本相对准确，但可能显著低估多字节字符（CJK 文字一个字符可能对应 1–3 个 token）。建议配合 `SAFETY_MARGIN` 使用。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 待估算的消息列表 |

- **返回值**：`number`，估算的总 token 数。

#### `splitMessagesByTokenShare(messages, parts)`

- **位置**：`src/agents/compaction.ts:61`
- **签名**：

  ```ts
  function splitMessagesByTokenShare(
    messages: AgentMessage[],
    parts?: number,
  ): AgentMessage[][]
  ```

- **说明**：按 token 份额将消息列表均等分割为多个块，用于并行压缩（将长历史分成 N 个大小接近的块，分别生成摘要后再合并）。分割点始终在消息边界，不会切割单条消息。

- **算法详解**：
  1. 计算所有消息的总 token 数 `totalTokens`
  2. 确定每块的目标 token 数 `targetTokens = totalTokens / parts`
  3. 遍历消息，维护当前块的累计 token 数 `currentTokens`
  4. 当满足以下**全部**条件时，将当前块推入结果，开始新块：
     - 当前已生成的块数 < `parts - 1`（最后一块不切割）
     - 当前块非空（`current.length > 0`）
     - 加入当前消息后将超过 `targetTokens`
  5. 将所有剩余消息归入最后一块

- **边界处理**：
  - `messages` 为空时返回 `[]`
  - `parts <= 1` 时返回 `[messages]`（不分割）
  - 实际块数不超过消息数（由 `normalizeParts` 限制）

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 待分割的消息列表 |
  | `parts` | `number?` | 目标块数，默认为 2，实际块数不超过消息数 |

- **返回值**：`AgentMessage[][]`，分割后的消息块数组（可能少于 `parts` 个）。

#### `chunkMessagesByMaxTokens(messages, maxTokens)`

- **位置**：`src/agents/compaction.ts:119`
- **签名**：

  ```ts
  function chunkMessagesByMaxTokens(
    messages: AgentMessage[],
    maxTokens: number,
  ): AgentMessage[][]
  ```

- **说明**：按最大 token 数上限将消息列表切割为多个块，用于确保每次摘要调用不超出模型上下文限制。

- **算法详解**：
  1. 将 `maxTokens` 除以 `SAFETY_MARGIN`（1.2）得到 `effectiveMax`，补偿估算低估
  2. 遍历消息，当加入当前消息后累计 token 超过 `effectiveMax`，将当前块推入结果，开始新块
  3. **超大消息特殊处理**：若单条消息本身超过 `effectiveMax`，在加入块后立即将该块推入结果，防止无限增长（oversized message 会单独成为一块）

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 待切割的消息列表 |
  | `maxTokens` | `number` | 每块的最大 token 数（安全裕度应用前） |

- **返回值**：`AgentMessage[][]`，切割后的消息块数组。

#### `computeAdaptiveChunkRatio(messages, contextWindow)`

- **位置**：`src/agents/compaction.ts:171`
- **签名**：

  ```ts
  function computeAdaptiveChunkRatio(
    messages: AgentMessage[],
    contextWindow: number,
  ): number
  ```

- **说明**：根据历史消息的平均大小，自适应计算每次压缩应丢弃的历史比例。

- **算法详解**：
  1. 计算平均 token 数 `avgTokens = totalTokens / messages.length`
  2. 应用安全裕度：`safeAvgTokens = avgTokens * SAFETY_MARGIN`
  3. 计算平均消息占上下文窗口的比例：`avgRatio = safeAvgTokens / contextWindow`
  4. 若 `avgRatio > 0.1`（平均消息超过上下文窗口的 10%），说明消息体积较大，需要降低分块比例以避免单块超出限制：
     - `reduction = min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO)`
     - 返回 `max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction)`
  5. 否则返回 `BASE_CHUNK_RATIO`（0.4）

- **设计意图**：消息越大，每次压缩越激进（丢弃比例越高），防止"刚裁剪一块"又立即触发压缩的死循环。比例范围限制在 `[0.15, 0.4]` 之间。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 历史消息列表 |
  | `contextWindow` | `number` | 当前模型的上下文窗口大小（token 数） |

- **返回值**：`number`，自适应分块比例，范围 `[MIN_CHUNK_RATIO, BASE_CHUNK_RATIO]`。

#### `isOversizedForSummary(msg, contextWindow)`

- **位置**：`src/agents/compaction.ts:198`
- **签名**：

  ```ts
  function isOversizedForSummary(
    msg: AgentMessage,
    contextWindow: number,
  ): boolean
  ```

- **说明**：判断单条消息是否因体积过大而无法被安全地包含在摘要中。若消息的估算 token 数（乘以安全裕度后）超过上下文窗口的 50%，则认为该消息过大。

- **阈值依据**：摘要生成至少需要 prompt + 输入消息 + 输出摘要，保守估计消息本身不应超过 50% 的上下文窗口。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `msg` | `AgentMessage` | 待检查的单条消息 |
  | `contextWindow` | `number` | 模型上下文窗口大小（token 数） |

- **返回值**：`boolean`，`true` 表示消息过大无法摘要。

#### `summarizeWithFallback(params)`

- **位置**：`src/agents/compaction.ts:258`
- **签名**：

  ```ts
  async function summarizeWithFallback(params: {
    messages: AgentMessage[];
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    maxChunkTokens: number;
    contextWindow: number;
    customInstructions?: string;
    previousSummary?: string;
  }): Promise<string>
  ```

- **说明**：带渐进式降级策略的摘要生成函数。当完整摘要失败时，自动尝试更保守的方式，确保总能返回有意义的输出。

- **降级策略（三级，依次尝试）**：
  1. **完整摘要**：调用 `summarizeChunks` 对所有消息生成摘要（内部按 `maxChunkTokens` 分块，逐块串行生成并合并摘要）
  2. **部分摘要**：若完整摘要失败，将消息按 `isOversizedForSummary` 过滤，仅对"小消息"生成摘要，超大消息用文字说明代替（如 `[Large user (~50K tokens) omitted from summary]`），拼接在摘要末尾
  3. **纯文本说明**：若部分摘要也失败，返回消息总数和无法摘要的文字说明

- **重试机制**：底层 `summarizeChunks` 对每个块的 `generateSummary` 调用使用 `retryAsync`（最多 3 次，指数退避 500ms–5s，20% 抖动），`AbortError` 不重试。

- **安全注意**：在调用摘要前会再次 `stripToolResultDetails`，确保工具结果详情不进入摘要 prompt。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 待摘要的消息列表 |
  | `model` | `ExtensionContext["model"]` | 用于生成摘要的模型元数据 |
  | `apiKey` | `string` | Provider API 密钥 |
  | `signal` | `AbortSignal` | 用于取消摘要生成的信号 |
  | `reserveTokens` | `number` | 为摘要输出预留的 token 数 |
  | `maxChunkTokens` | `number` | 每个摘要块的最大 token 数 |
  | `contextWindow` | `number` | 模型上下文窗口大小（用于判断消息是否过大） |
  | `customInstructions` | `string?` | 自定义摘要指令（可选） |
  | `previousSummary` | `string?` | 前一次摘要文本，用于增量摘要（可选） |

- **返回值**：`Promise<string>`，最终摘要文本；失败时返回说明性文字（永不 throw）。

#### `summarizeInStages(params)`

- **位置**：`src/agents/compaction.ts:338`
- **签名**：

  ```ts
  async function summarizeInStages(params: {
    messages: AgentMessage[];
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    maxChunkTokens: number;
    contextWindow: number;
    customInstructions?: string;
    previousSummary?: string;
    parts?: number;
    minMessagesForSplit?: number;
  }): Promise<string>
  ```

- **说明**：分阶段摘要策略，适用于历史消息总量远超单次摘要能力的场景。先将消息按 token 份额分成 N 块，各块独立调用 `summarizeWithFallback` 生成部分摘要，再将所有部分摘要合并为最终摘要。

- **分阶段摘要流程**：
  1. **退化检查**：若 `parts <= 1`，或消息数 < `minMessagesForSplit`，或总 token ≤ `maxChunkTokens`，则直接退化为单次 `summarizeWithFallback`
  2. **分块**：调用 `splitMessagesByTokenShare(messages, parts)` 分割消息
  3. **各块独立摘要**：逐块调用 `summarizeWithFallback`（`previousSummary=undefined`，各块独立）
  4. **合并摘要**：将所有部分摘要文本作为 `user` 角色的消息，使用 `MERGE_SUMMARIES_INSTRUCTIONS` 指导模型将它们合并为单一摘要，保留决策、TODO、约束等重要信息

- **合并指令**（`MERGE_SUMMARIES_INSTRUCTIONS`）：`"Merge these partial summaries into a single cohesive summary. Preserve decisions, TODOs, open questions, and any constraints."`

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 待摘要的消息列表 |
  | `model` | `ExtensionContext["model"]` | 用于生成摘要的模型元数据 |
  | `apiKey` | `string` | Provider API 密钥 |
  | `signal` | `AbortSignal` | 取消信号 |
  | `reserveTokens` | `number` | 为摘要输出预留的 token 数 |
  | `maxChunkTokens` | `number` | 每个摘要块的最大 token 数 |
  | `contextWindow` | `number` | 模型上下文窗口大小 |
  | `customInstructions` | `string?` | 自定义摘要指令（可选），会追加在合并指令之后 |
  | `previousSummary` | `string?` | 前一次摘要文本（可选） |
  | `parts` | `number?` | 分块数，默认 2 |
  | `minMessagesForSplit` | `number?` | 触发分块的最小消息数，默认 4 |

- **返回值**：`Promise<string>`，合并后的最终摘要文本。

#### `pruneHistoryForContextShare(params)`

- **位置**：`src/agents/compaction.ts:415`
- **签名**：

  ```ts
  function pruneHistoryForContextShare(params: {
    messages: AgentMessage[];
    maxContextTokens: number;
    maxHistoryShare?: number;
    parts?: number;
  }): {
    messages: AgentMessage[];
    droppedMessagesList: AgentMessage[];
    droppedChunks: number;
    droppedMessages: number;
    droppedTokens: number;
    keptTokens: number;
    budgetTokens: number;
  }
  ```

- **说明**：裁剪会话历史消息，使其适配模型上下文窗口中分配给历史的预算。这是压缩流程中"确定哪些消息需要被摘要或丢弃"的核心函数。

- **算法详解**：

  1. **计算历史预算**：`budgetTokens = floor(maxContextTokens * maxHistoryShare)`（默认 50%）

  2. **迭代裁剪循环**：
     - 计算当前 `keptMessages` 的总 token 数
     - 若仍超过 `budgetTokens`，调用 `splitMessagesByTokenShare(keptMessages, parts)` 分块
     - 若分块数 ≤ 1（消息无法继续分割），**停止循环**（避免无限循环）
     - 丢弃最旧的块（`chunks[0]`），保留其余块（`chunks[1:]`）

  3. **Tool use/result 配对修复**：
     - 每次丢弃一块后，调用 `repairToolUseResultPairing(flatRest)` 修复孤立的 `tool_result`
     - **问题根源**：当包含 `tool_use` 的块被丢弃后，对应的 `tool_result` 消息可能仍在保留的历史中，形成孤立引用
     - **后果**：Anthropic API 对孤立的 `tool_result`（找不到对应 `tool_use_id`）会返回 API 错误
     - **修复行为**：`repairToolUseResultPairing` 会删除这些孤立的 `tool_result`，并通过 `droppedOrphanCount` 报告删除数量

  4. **统计累计**：每次迭代累计 `droppedChunks`、`droppedMessages`、`droppedTokens`

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 完整的历史消息列表 |
  | `maxContextTokens` | `number` | 模型上下文窗口大小（token 数） |
  | `maxHistoryShare` | `number?` | 历史占上下文的最大比例，默认 `0.5` |
  | `parts` | `number?` | 每次分块的块数，默认 2 |

- **返回值**：
  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `messages` | `AgentMessage[]` | 裁剪后保留的消息列表 |
  | `droppedMessagesList` | `AgentMessage[]` | 被丢弃的消息列表（供摘要使用） |
  | `droppedChunks` | `number` | 丢弃的块数 |
  | `droppedMessages` | `number` | 丢弃的消息数（含修复时删除的孤立 `tool_result`） |
  | `droppedTokens` | `number` | 丢弃消息的估算总 token 数 |
  | `keptTokens` | `number` | 保留消息的估算总 token 数 |
  | `budgetTokens` | `number` | 历史预算 token 数（`maxContextTokens * maxHistoryShare`） |

#### `resolveContextWindowTokens(model)`

- **位置**：`src/agents/compaction.ts:485`
- **签名**：

  ```ts
  function resolveContextWindowTokens(
    model?: ExtensionContext["model"]
  ): number
  ```

- **说明**：从 Pi SDK 模型元数据中读取上下文窗口 token 数。若模型未提供 `contextWindow` 字段，回退到 `DEFAULT_CONTEXT_TOKENS`。返回值至少为 1。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `model` | `ExtensionContext["model"]?` | Pi SDK 的模型元数据（可选） |

- **返回值**：`number`，上下文窗口 token 数（至少为 1）。

---

## subagent-registry.ts — Subagent 运行生命周期注册表

**路径**：`src/agents/subagent-registry.ts`

该模块维护一个进程级的 subagent 运行记录映射表（`subagentRuns`），跟踪每个 subagent 运行从启动到清理的完整生命周期。注册表持久化到磁盘，支持 gateway 重启后的运行恢复。

---

### 模块级状态

该模块使用以下模块级变量维护运行时状态（不导出）：

| 变量 | 类型 | 说明 |
|---|---|---|
| `subagentRuns` | `Map<string, SubagentRunRecord>` | 运行 ID → 运行记录的映射，是注册表的核心数据结构 |
| `sweeper` | `NodeJS.Timeout \| null` | 定期清理已归档运行的定时器句柄 |
| `listenerStarted` | `boolean` | 是否已启动 agent 事件监听器（防止重复注册） |
| `listenerStop` | `(() => void) \| null` | 停止事件监听器的函数 |
| `restoreAttempted` | `boolean` | 是否已尝试从磁盘恢复（使用 `var` 避免循环 import 时的 TDZ） |
| `resumedRuns` | `Set<string>` | 已被恢复处理的运行 ID 集合（防止重复恢复） |
| `endedHookInFlightRunIds` | `Set<string>` | 当前正在执行 ended hook 的运行 ID 集合（防止并发重复触发） |
| `pendingLifecycleErrorByRunId` | `Map<string, {...}>` | 待延迟处理的生命周期 error 事件（等待可能的 start/end 重试） |

---

### 关键常量

| 常量 | 值 | 说明 |
|---|---|---|
| `SUBAGENT_ANNOUNCE_TIMEOUT_MS` | `120_000` | 单次 announce 流程的超时时间（2 分钟） |
| `MIN_ANNOUNCE_RETRY_DELAY_MS` | `1_000` | announce 重试的最小间隔（1 秒） |
| `MAX_ANNOUNCE_RETRY_DELAY_MS` | `8_000` | announce 重试的最大间隔（8 秒） |
| `MAX_ANNOUNCE_RETRY_COUNT` | `3` | announce 最大重试次数，超过后放弃（防止无限重试循环） |
| `ANNOUNCE_EXPIRY_MS` | `5 * 60_000` | announce 条目的最大存活时间（5 分钟），超时后强制过期 |
| `LIFECYCLE_ERROR_RETRY_GRACE_MS` | `15_000` | 生命周期 error 事件的延迟处理时间（15 秒），等待可能的 start/end 重试 |

---

### 生命周期说明

Subagent 运行的完整生命周期如下：

```
registerSubagentRun()
    │
    ├─ 写入 subagentRuns Map
    ├─ 启动 ensureListener()（监听 agent 生命周期事件）
    ├─ 持久化到磁盘
    └─ 异步等待：waitForSubagentCompletion()（via gateway RPC）
                  ↕ 也可通过 lifecycle 事件（内嵌运行）触发
    completeSubagentRun()
    │
    ├─ 更新 endedAt / outcome / endedReason
    ├─ 持久化
    ├─ 触发 emitSubagentEndedHookForRun()（可能延迟）
    └─ 启动 startSubagentAnnounceCleanupFlow()
           │
           └─ runSubagentAnnounceFlow()（发送完成通知给请求方）
                  │
                  └─ finalizeSubagentCleanup()
                         │
                         ├─ cleanup="delete": 从 Map 删除，持久化
                         └─ cleanup="keep":  标记 cleanupCompletedAt，持久化
```

---

### 导出函数

#### `initSubagentRegistry()`

- **位置**：`src/agents/subagent-registry.ts:1165`
- **签名**：`function initSubagentRegistry(): void`
- **说明**：初始化 subagent 注册表。从磁盘恢复上次未完成的运行记录，并为每个待处理的运行重启 announce 流程。应在 gateway 启动时调用一次。
- **内部流程**：调用 `restoreSubagentRunsOnce()`，该函数通过 `restoreAttempted` 标志确保只执行一次。

#### `registerSubagentRun(params)`

- **位置**：`src/agents/subagent-registry.ts:895`
- **签名**：

  ```ts
  function registerSubagentRun(params: {
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    requesterDisplayKey: string;
    task: string;
    cleanup: "delete" | "keep";
    label?: string;
    model?: string;
    runTimeoutSeconds?: number;
    expectsCompletionMessage?: boolean;
    spawnMode?: "run" | "session";
  }): void
  ```

- **说明**：注册一个新的 subagent 运行，启动生命周期跟踪。这是 subagent 生命周期的起点。

- **执行流程**：
  1. 读取配置，计算 `archiveAfterMs`（归档延时）和 `waitTimeoutMs`（等待超时）
  2. 根据 `spawnMode` 确定是否设置 `archiveAtMs`（`"session"` 模式不归档）
  3. 创建 `SubagentRunRecord` 写入 `subagentRuns`
  4. 调用 `ensureListener()` 确保生命周期事件监听器已启动
  5. 持久化到磁盘
  6. 若设置了 `archiveAtMs`，启动 `startSweeper()`
  7. 异步调用 `waitForSubagentCompletion(runId, waitTimeoutMs)`（via gateway RPC `agent.wait`）

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `runId` | `string` | 唯一运行 ID |
  | `childSessionKey` | `string` | subagent 会话的 session key |
  | `requesterSessionKey` | `string` | 发起请求的父会话 key |
  | `requesterOrigin` | `DeliveryContext?` | 请求方的投递上下文（channel、peer、account 等） |
  | `requesterDisplayKey` | `string` | 请求方的显示 key |
  | `task` | `string` | 任务描述 |
  | `cleanup` | `"delete" \| "keep"` | 完成后的清理策略 |
  | `label` | `string?` | 可选的运行标签 |
  | `model` | `string?` | 使用的模型 ID |
  | `runTimeoutSeconds` | `number?` | 超时秒数（覆盖全局配置） |
  | `expectsCompletionMessage` | `boolean?` | 是否期待完成消息（影响 hook 触发时机） |
  | `spawnMode` | `"run" \| "session"?` | 生命周期模式：`"run"` 为单次运行，`"session"` 为会话级持久 |

#### `markSubagentRunForSteerRestart(runId)`

- **位置**：`src/agents/subagent-registry.ts:794`
- **签名**：`function markSubagentRunForSteerRestart(runId: string): boolean`
- **说明**：将运行标记为"steer 重启抑制"状态，阻止在重启期间发出 announce（避免向请求方错误地报告运行完成）。在 steer（重新引导 agent 执行）操作开始前调用。
- **返回值**：`boolean`，`true` 表示标记成功（或已在抑制状态），`false` 表示运行不存在。

#### `clearSubagentRunSteerRestart(runId)`

- **位置**：`src/agents/subagent-registry.ts:811`
- **签名**：`function clearSubagentRunSteerRestart(runId: string): boolean`
- **说明**：清除 steer 重启抑制标记。如果被中断的运行在抑制期间已完成，清除标记后会立即重试清理流程，确保完成输出不丢失。
- **返回值**：`boolean`，`true` 表示清除成功（或已是正常状态），`false` 表示运行不存在。

#### `replaceSubagentRunAfterSteer(params)`

- **位置**：`src/agents/subagent-registry.ts:834`
- **签名**：

  ```ts
  function replaceSubagentRunAfterSteer(params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
  }): boolean
  ```

- **说明**：在 steer 重启完成后，用新的运行记录替换旧的运行记录。复制旧记录的所有元数据（会话 key、请求方信息、任务、标签等），重置时间戳和状态字段，然后等待新运行完成。
- **注意**：`previousRunId !== nextRunId` 时才删除旧记录；若相同则原地更新。`"session"` 模式的运行不设置 `archiveAtMs`。
- **返回值**：`boolean`，`true` 表示替换成功，`false` 表示找不到 `previousRunId` 且 `fallback` 为空。

#### `releaseSubagentRun(runId)`

- **位置**：`src/agents/subagent-registry.ts:1033`
- **签名**：`function releaseSubagentRun(runId: string): void`
- **说明**：从注册表中强制删除指定运行记录（清除待处理的 lifecycle error 定时器，从 Map 删除，持久化）。用于外部强制释放运行，不触发 announce 流程。若注册表变为空，停止 sweeper。

#### `markSubagentRunTerminated(params)`

- **位置**：`src/agents/subagent-registry.ts:1079`
- **签名**：

  ```ts
  function markSubagentRunTerminated(params: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
  }): number
  ```

- **说明**：标记一个或多个运行为已终止（killed）状态，同时触发 ended hook（不发起 announce 流程）。用于外部强制终止 subagent 运行（如用户 kill 命令）。

- **标记逻辑**：
  - 可通过 `runId` 或 `childSessionKey` 定位目标运行（两者可同时指定，取并集）
  - 只处理尚未结束的运行（`endedAt` 未设置）
  - 设置 `endedAt`、`outcome={status:"error", error:reason}`、`endedReason=KILLED`、`suppressAnnounceReason="killed"`
  - 标记 `cleanupHandled=true` 和 `cleanupCompletedAt`，跳过 announce 流程
  - 对每个受影响的 `childSessionKey` 触发一次 `emitSubagentEndedHookOnce`

- **返回值**：`number`，实际更新的运行数量。

#### `resolveRequesterForChildSession(childSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1048`
- **签名**：

  ```ts
  function resolveRequesterForChildSession(
    childSessionKey: string,
  ): {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
  } | null
  ```

- **说明**：通过子会话 key 反向查找其请求方信息（父会话 key 和投递上下文）。用于消息路由中确定 subagent 回复的发送目标。
- **返回值**：请求方信息对象，或 `null`（找不到对应记录）。

#### `isSubagentSessionRunActive(childSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1065`
- **签名**：`function isSubagentSessionRunActive(childSessionKey: string): boolean`
- **说明**：检查给定子会话是否有尚未结束的运行（`endedAt` 未设置）。用于判断 subagent 是否仍在执行。
- **返回值**：`boolean`，`true` 表示存在至少一个活跃运行。

#### `listSubagentRunsForRequester(requesterSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1140`
- **签名**：`function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[]`
- **说明**：列出指定请求方会话的所有 subagent 运行记录（包括已完成和进行中的）。
- **返回值**：`SubagentRunRecord[]`，按注册表中的迭代顺序返回。

#### `countActiveRunsForSession(requesterSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1144`
- **签名**：`function countActiveRunsForSession(requesterSessionKey: string): number`
- **说明**：统计指定请求方会话当前活跃（尚未结束）的 subagent 运行数量。使用只读快照（`getSubagentRunsSnapshotForRead`）访问，不修改状态。
- **返回值**：`number`，活跃运行数。

#### `countActiveDescendantRuns(rootSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1151`
- **签名**：`function countActiveDescendantRuns(rootSessionKey: string): number`
- **说明**：统计以 `rootSessionKey` 为根的所有后代 subagent 运行中，当前仍活跃的数量（递归统计）。使用只读快照。
- **返回值**：`number`，活跃后代运行数。

#### `listDescendantRunsForRequester(rootSessionKey)`

- **位置**：`src/agents/subagent-registry.ts:1158`
- **签名**：`function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[]`
- **说明**：列出以 `rootSessionKey` 为根的所有后代 subagent 运行记录（递归）。使用只读快照。
- **返回值**：`SubagentRunRecord[]`，所有后代运行记录。

---

### 测试辅助导出函数

以下函数仅供测试使用，不应在生产代码中调用：

#### `resetSubagentRegistryForTests(opts?)`

- **位置**：`src/agents/subagent-registry.ts:1011`
- **签名**：`function resetSubagentRegistryForTests(opts?: { persist?: boolean }): void`
- **说明**：重置注册表到初始状态，清空所有内存状态和定时器。`opts.persist` 默认为 `true`，会将空状态写入磁盘。

#### `addSubagentRunForTests(entry)`

- **位置**：`src/agents/subagent-registry.ts:1029`
- **签名**：`function addSubagentRunForTests(entry: SubagentRunRecord): void`
- **说明**：直接向注册表插入运行记录，绕过正常注册流程（不启动 listener、sweeper 或 waitForCompletion）。

---

## model-catalog.ts — 模型目录

**路径**：`src/agents/model-catalog.ts`

该模块负责加载和管理可用模型的目录，整合来自 Pi SDK（动态发现）和用户配置（opt-in providers）的模型信息。结果被缓存为 Promise，避免重复加载。

---

### 类型

#### `ModelCatalogEntry`

- **位置**：`src/agents/model-catalog.ts:8`
- **定义**：

  ```ts
  type ModelCatalogEntry = {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
  };
  ```

- **说明**：模型目录中的单条记录，描述一个可用模型的元数据。

  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `id` | `string` | 模型 ID（如 `"claude-opus-4-6"`） |
  | `name` | `string` | 模型显示名称 |
  | `provider` | `string` | Provider ID（如 `"anthropic"`），已规范化为小写 |
  | `contextWindow` | `number?` | 上下文窗口大小（token 数），来自 SDK 或配置 |
  | `reasoning` | `boolean?` | 是否支持 reasoning/思考模式 |
  | `input` | `Array<"text" \| "image">?` | 支持的输入类型 |

---

### 模块级状态

| 变量 | 类型 | 说明 |
|---|---|---|
| `modelCatalogPromise` | `Promise<ModelCatalogEntry[]> \| null` | 已启动的加载 Promise 缓存；`null` 表示需要重新加载 |
| `hasLoggedModelCatalogError` | `boolean` | 是否已记录过加载错误（防止日志洪泛） |
| `importPiSdk` | `() => Promise<PiSdkModule>` | Pi SDK 的动态 import 函数，测试时可替换为 mock |

---

### 导出函数

#### `loadModelCatalog(params?)`

- **位置**：`src/agents/model-catalog.ts:157`
- **签名**：

  ```ts
  async function loadModelCatalog(params?: {
    config?: OpenClawConfig;
    useCache?: boolean;
  }): Promise<ModelCatalogEntry[]>
  ```

- **说明**：加载并返回完整的模型目录。结果被缓存为 Promise（`modelCatalogPromise`），后续调用直接返回缓存，不重复加载。

- **加载流程**：
  1. **缓存检查**：`useCache=false` 时清除缓存，强制重新加载
  2. **加载配置**：使用 `params.config` 或调用 `loadConfig()` 获取配置
  3. **确保 models.json**：调用 `ensureOpenClawModelsJson(cfg)` 确保 Pi SDK 的模型配置文件存在
  4. **动态导入 Pi SDK**：通过 `importPiSdk()` 动态加载（**必须在 try/catch 内**，避免因一次失败而毒化缓存）
  5. **通过 ModelRegistry 发现模型**：初始化 `piSdk.ModelRegistry`，调用 `getAll()` 获取所有已发现的模型
  6. **合并 opt-in provider 模型**：调用 `mergeConfiguredOptInProviderModels`，将用户配置中的非 Pi-native provider 模型（如 `kilocode`）合并进来
  7. **OpenAI Codex Spark 回退**：调用 `applyOpenAICodexSparkFallback`，若目录中有 `gpt-5.3-codex` 但无 `gpt-5.3-codex-spark`，则自动补充后者
  8. **排序**：按 provider 名称（主键）和 name（次键）排序
  9. **空目录处理**：若最终结果为空，清除缓存（`modelCatalogPromise=null`），以便下次调用重试

- **错误处理**：加载失败时清除缓存、记录一次警告日志（`hasLoggedModelCatalogError` 防止重复），若部分模型已加载则返回已有结果，否则返回空数组。

- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `config` | `OpenClawConfig?` | 可选配置对象，不提供时从磁盘加载 |
  | `useCache` | `boolean?` | `false` 时强制绕过缓存重新加载，默认 `true` |

- **返回值**：`Promise<ModelCatalogEntry[]>`，按 provider+name 排序的模型列表。

#### `modelSupportsVision(entry)`

- **位置**：`src/agents/model-catalog.ts:247`
- **签名**：

  ```ts
  function modelSupportsVision(
    entry: ModelCatalogEntry | undefined,
  ): boolean
  ```

- **说明**：检查模型目录条目是否声明支持图像输入。简单检查 `entry.input` 数组是否包含 `"image"`。
- **参数**：`entry` — 模型目录条目，`undefined` 时返回 `false`。
- **返回值**：`boolean`，`true` 表示支持视觉（图像输入）。

#### `findModelInCatalog(catalog, provider, modelId)`

- **位置**：`src/agents/model-catalog.ts:254`
- **签名**：

  ```ts
  function findModelInCatalog(
    catalog: ModelCatalogEntry[],
    provider: string,
    modelId: string,
  ): ModelCatalogEntry | undefined
  ```

- **说明**：在模型目录中按 provider 和模型 ID 查找指定条目。查找时对 provider 和 modelId 均进行小写规范化（`toLowerCase().trim()`），支持大小写不敏感的匹配。
- **参数**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `catalog` | `ModelCatalogEntry[]` | 已加载的模型目录 |
  | `provider` | `string` | Provider ID（大小写不敏感） |
  | `modelId` | `string` | 模型 ID（大小写不敏感） |
- **返回值**：`ModelCatalogEntry \| undefined`，找到的条目或 `undefined`。

---

### 测试辅助导出函数

#### `resetModelCatalogCacheForTest()`

- **位置**：`src/agents/model-catalog.ts:146`
- **签名**：`function resetModelCatalogCacheForTest(): void`
- **说明**：重置模型目录缓存（`modelCatalogPromise=null`）、错误日志标志，并将 `importPiSdk` 恢复为默认 import 函数。测试结束后应调用。

#### `__setModelCatalogImportForTest(loader?)`

- **位置**：`src/agents/model-catalog.ts:153`
- **签名**：`function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void`
- **说明**：替换 Pi SDK 的动态 import 函数，用于在测试中模拟加载成功/失败场景（如模拟 `pnpm install` 期间的瞬时失败）。不传参数时恢复为默认实现。

---

*文档生成时间：2026-04-15。如需更新，请对照源文件的注释和逻辑重新核对行号。*
