# Cron 定时任务架构文档

> 文件路径：`src/cron/`
> 本文档描述 OpenClaw 内置定时任务调度系统的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

Cron 系统为 agent 提供**定时任务调度**能力，支持将任务绑定到特定 agent 会话，在指定时间自动触发 agent 执行。支持标准 cron 表达式、每日/每周快捷配置，以及 webhook 回调。

---

## 2. 目录结构

```
src/cron/
├── service.ts               # CronService 类（公共 API）
├── service/                 # 服务实现细节
│   ├── ops.ts               # 操作实现（start、stop、add、run 等）
│   ├── state.ts             # 服务状态（CronServiceState、CronServiceDeps）
│   ├── schedule.ts          # 调度逻辑
│   └── ...
├── types.ts                 # 类型定义（CronJob、CronJobCreate、CronJobPatch）
├── store.ts                 # 任务持久化存储
├── schedule.ts              # cron 表达式解析
├── normalize.ts             # 任务配置规范化
├── run-log.ts               # 执行日志
├── parse.ts                 # cron 表达式解析工具
├── delivery.ts              # 任务交付（触发 agent 执行）
├── legacy-delivery.ts       # 旧版交付兼容
├── isolated-agent/          # 隔离 agent 执行
│   ├── run.ts               # 在独立 agent 上下文中运行
│   └── ...
├── session-reaper.ts        # 会话清理
└── stagger.ts               # 错峰执行（top-of-hour stagger）
```

---

## 3. CronService（`src/cron/service.ts`）

`CronService` 是 Cron 系统的公共接口，通过依赖注入的 `CronServiceDeps` 初始化：

```typescript
// src/cron/service.ts:1-56
import * as ops from "./service/ops.js";
import { type CronServiceDeps, createCronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export class CronService {
  private readonly state;
  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() {
    await ops.start(this.state);      // 启动调度器，加载持久化任务
  }

  stop() {
    ops.stop(this.state);             // 停止调度器，清理定时器
  }

  async status() {
    return await ops.status(this.state);   // 返回所有任务的当前状态
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await ops.list(this.state, opts);  // 列出任务（可过滤禁用任务）
  }

  async listPage(opts?: ops.CronListPageOptions) {
    return await ops.listPage(this.state, opts);  // 分页列出任务
  }

  async add(input: CronJobCreate) {
    return await ops.add(this.state, input);  // 添加新任务
  }

  async update(id: string, patch: CronJobPatch) {
    return await ops.update(this.state, id, patch);  // 更新任务配置
  }

  async remove(id: string) {
    return await ops.remove(this.state, id);  // 删除任务
  }

  async run(id: string, mode?: "due" | "force") {
    return await ops.run(this.state, id, mode);  // 手动触发任务（due=仅到期时，force=强制）
  }

  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }

  // 立即唤醒或等待下次心跳
  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
```

---

## 4. 任务类型（`src/cron/types.ts`）

```typescript
// src/cron/types.ts（CronJob 核心字段）
export type CronJob = {
  id: string;
  name: string;
  schedule: string;         // cron 表达式（"0 9 * * *"）或快捷值（"daily"、"weekly"）
  agentId?: string;         // 绑定的 agent ID
  sessionKey?: string;      // 绑定的会话 key
  message?: string;         // 触发时发送的消息
  webhookUrl?: string;      // webhook 回调 URL
  enabled: boolean;
  lastRunAt?: number;       // 上次执行时间（Unix ms）
  nextRunAt?: number;       // 下次执行时间（Unix ms）
  lastStatus?: "ok" | "error" | "skipped";
};

export type CronJobCreate = Omit<CronJob, "id" | "lastRunAt" | "nextRunAt" | "lastStatus">;

export type CronJobPatch = Partial<Omit<CronJobCreate, "id">>;
```

---

## 5. 任务调度

### 5.1 cron 表达式支持

标准 5 字段 cron 表达式：`分 时 日 月 周`

示例：
- `0 9 * * *` — 每天 9:00
- `0 9 * * 1` — 每周一 9:00
- `*/30 * * * *` — 每 30 分钟

### 5.2 错峰执行（`src/cron/stagger.ts`）

`top-of-hour stagger`：整点任务自动错开执行时间，防止大量任务同时触发，减少 API 压力。

### 5.3 执行模式

| 模式 | 说明 |
|------|------|
| `due` | 仅在任务到期时执行（跳过未到期任务） |
| `force` | 强制立即执行（忽略调度时间） |

---

## 6. 隔离 Agent 执行（`src/cron/isolated-agent/`）

Cron 任务在独立的 agent 上下文中运行，与主会话隔离：

- 使用 `CommandLane.Cron` 队列（独立于主 agent 队列）
- 支持绑定到特定 agent + 会话
- 执行结果记录到 `run-log.ts`

---

## 7. 任务持久化（`src/cron/store.ts`）

任务配置持久化到磁盘（`~/.openclaw/cron.json`），Gateway 重启后自动恢复。

---

## 8. Webhook 回调

任务可配置 `webhookUrl`，触发时向该 URL 发送 HTTP POST 请求（携带任务 ID 和执行结果）。支持 SSRF 防护（通过 `src/infra/net/ssrf.ts`）。
