# 记忆系统架构文档

> 文件路径：`src/memory/`
> 本文档描述 OpenClaw 向量记忆后端的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

记忆系统为 agent 提供**持久化语义记忆**能力，支持将会话内容、文档等信息嵌入为向量，并通过语义搜索检索相关记忆片段注入 system prompt。

---

## 2. 目录结构

```
src/memory/
├── manager.ts                  # 记忆索引管理器（MemoryIndexManager）
├── manager-embedding-ops.ts    # 嵌入操作（批量嵌入、缓存）
├── manager-search.ts           # 搜索实现（向量搜索、关键词搜索）
├── manager-sync-ops.ts         # 同步操作（增量同步、原子重索引）
├── embeddings.ts               # 嵌入 provider 接口与工厂
├── embeddings-openai.ts        # OpenAI 嵌入（text-embedding-3-*）
├── embeddings-gemini.ts        # Google Gemini 嵌入
├── embeddings-voyage.ts        # Voyage AI 嵌入
├── embeddings-mistral.ts       # Mistral 嵌入
├── embeddings-remote-provider.ts # 远程 HTTP 嵌入 provider
├── batch-openai.ts             # OpenAI Batch API
├── batch-gemini.ts             # Gemini 批量嵌入
├── batch-voyage.ts             # Voyage 批量嵌入
├── batch-http.ts               # HTTP 批量嵌入
├── batch-runner.ts             # 批量执行器
├── batch-output.ts             # 批量输出处理
├── search-manager.ts           # 搜索管理器
├── query-expansion.ts          # 查询扩展（关键词提取）
├── hybrid.ts                   # 混合检索（BM25 + 向量）
├── sqlite-vec.ts               # SQLite-vec 向量扩展
├── sqlite.ts                   # SQLite 数据库操作
├── temporal-decay.ts           # 时序衰减（记忆时效性）
├── session-files.ts            # 会话文件处理
├── mmr.ts                      # 最大边际相关性（MMR）去重
├── qmd-manager.ts              # QMD（查询 Markdown）管理器
├── internal.ts                 # 内部工具
├── fs-utils.ts                 # 文件系统工具
└── types.ts                    # 类型定义
```

**扩展包：**
- `extensions/memory-core/` — 核心记忆功能扩展
- `extensions/memory-lancedb/` — LanceDB 向量存储后端

---

## 3. 核心管理器（`src/memory/manager.ts`）

`MemoryIndexManager` 继承 `MemoryManagerEmbeddingOps`，实现 `MemorySearchManager` 接口：

```typescript
// src/memory/manager.ts:33-80
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";        // 向量存储表
const FTS_TABLE = "chunks_fts";           // 全文搜索表
const EMBEDDING_CACHE_TABLE = "embedding_cache"; // 嵌入缓存表
const BATCH_FAILURE_LIMIT = 2;            // 批量失败上限

const INDEX_CACHE = new Map<string, MemoryIndexManager>();  // 单例缓存

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  // 支持的嵌入 provider（自动检测可用性）
  private readonly requestedProvider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "auto";
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral";
  protected fallbackReason?: string;
  // 各 provider 客户端
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  // 批量嵌入配置
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected db: DatabaseSync;             // SQLite 数据库连接
  protected readonly sources: Set<MemorySource>;
  // 向量搜索配置
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  // 全文搜索配置
  protected readonly fts: {
    // ...
  };
}
```

---

## 4. 嵌入 Provider

### 4.1 Provider 接口（`src/memory/embeddings.ts`）

```typescript
// src/memory/embeddings.ts（EmbeddingProvider 接口）
export type EmbeddingProvider = {
  embed: (texts: string[]) => Promise<EmbeddingProviderResult>;
  dims: number;        // 向量维度
  model: string;       // 模型名称
};
```

### 4.2 支持的 Provider

| Provider | 模型示例 | 向量维度 |
|----------|---------|---------|
| OpenAI | text-embedding-3-small / large | 1536 / 3072 |
| Google Gemini | text-embedding-004 | 768 |
| Voyage AI | voyage-3 / voyage-code-3 | 1024 |
| Mistral | mistral-embed | 1024 |
| 本地（HuggingFace） | BAAI/bge-small-en | 可变 |
| 远程 HTTP | 自定义端点 | 可变 |

---

## 5. 向量存储

### 5.1 SQLite-vec（本地，默认）

使用 `sqlite-vec` SQLite 扩展提供向量相似度搜索：

```typescript
// src/memory/manager.ts:34-36
const VECTOR_TABLE = "chunks_vec";   // 向量数据表
const FTS_TABLE = "chunks_fts";      // FTS5 全文搜索表
const EMBEDDING_CACHE_TABLE = "embedding_cache";  // 嵌入结果缓存
```

### 5.2 LanceDB（扩展，`extensions/memory-lancedb/`）

LanceDB 提供更高性能的向量存储，适合大规模记忆库。

### 5.3 远程 HTTP

支持通过 HTTP API 连接远程向量存储服务。

---

## 6. 检索策略

### 6.1 混合检索（`src/memory/hybrid.ts`）

结合向量相似度和 BM25 关键词搜索，提高检索精度：

```typescript
// src/memory/hybrid.ts（mergeHybridResults）
export function mergeHybridResults(
  vectorResults: MemorySearchResult[],
  keywordResults: MemorySearchResult[],
  opts: { vectorWeight?: number; keywordWeight?: number }
): MemorySearchResult[] {
  // 归一化分数后加权合并
}
```

### 6.2 MMR（最大边际相关性，`src/memory/mmr.ts`）

去除冗余结果，提高检索多样性：
- 选择与查询相关度高且与已选结果相似度低的片段
- 避免返回高度重复的记忆片段

### 6.3 时序衰减（`src/memory/temporal-decay.ts`）

对旧记忆进行分数衰减，优先返回最近相关的记忆。

### 6.4 查询扩展（`src/memory/query-expansion.ts`）

从用户查询中提取关键词，用于 BM25 全文搜索，提升召回率。

---

## 7. 批量嵌入

批量嵌入支持并发处理和失败重试：

```typescript
// src/memory/manager.ts:58-68
protected batch: {
  enabled: boolean;
  wait: boolean;            // 等待批量任务完成
  concurrency: number;      // 并发批次数
  pollIntervalMs: number;   // 轮询间隔
  timeoutMs: number;        // 超时时间
};
protected batchFailureCount = 0;
protected batchFailureLastError?: string;
protected batchFailureLock: Promise<void> = Promise.resolve();
```

批量失败超过 `BATCH_FAILURE_LIMIT`（2次）后，自动降级到单条嵌入模式。

---

## 8. 嵌入缓存

嵌入结果缓存到 SQLite（`embedding_cache` 表），避免重复计算相同文本的嵌入向量，节省 API 调用费用。
