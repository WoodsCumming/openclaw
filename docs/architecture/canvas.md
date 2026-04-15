# Canvas / A2UI 架构文档

> 文件路径：`src/canvas-host/`
> 本文档描述 OpenClaw Canvas（Agent-to-UI）可视化工作区的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

Canvas 是 Agent 驱动的**可视化工作区**，允许 agent 渲染富媒体界面（图表、交互式 UI、实时数据展示等）。Canvas 服务作为独立的 Express + WebSocket 服务器运行，托管 A2UI（Agent-to-UI）静态资源，通过 Gateway 的 `node.canvas.capability.refresh` RPC 方法管理 Canvas URL 授权。

---

## 2. 目录结构

```
src/canvas-host/
├── server.ts              # Canvas 服务器实现（createCanvasHostHandler、startCanvasHostServer）
├── a2ui.ts                # A2UI bundle 处理（静态资源服务 + live reload）
├── file-resolver.ts       # 文件路径安全解析（防路径遍历）
├── server.test.ts         # 服务器测试
└── a2ui/                  # A2UI bundle 目录
    └── .bundle.hash        # bundle 哈希（自动生成，勿手动修改）
```

---

## 3. Canvas 服务器（`src/canvas-host/server.ts`）

### 3.1 核心类型

```typescript
// src/canvas-host/server.ts:22-56
export type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;        // Canvas 文件根目录
  port?: number;           // 监听端口
  listenHost?: string;     // 监听地址
  allowInTests?: boolean;  // 测试环境允许启动
  liveReload?: boolean;    // 开发模式 live reload
};

export type CanvasHostServer = {
  port: number;
  rootDir: string;
  close: () => Promise<void>;
};

export type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  // 处理 HTTP 请求（静态文件、A2UI bundle）
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  // 处理 WebSocket 升级（live reload 连接）
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};
```

### 3.2 默认 Canvas 页面

Canvas 服务器提供内置的 HTML 页面，用于展示 Canvas 状态：

```typescript
// src/canvas-host/server.ts:58-80（defaultIndexHTML 函数）
function defaultIndexHTML() {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; ... }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); ... }
  ...
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>OpenClaw Canvas</h1>
```

---

## 4. A2UI 集成（`src/canvas-host/a2ui.ts`）

A2UI（Agent-to-UI）是 agent 渲染界面的核心 bundle。

**关键路径常量：**

```typescript
// src/canvas-host/a2ui.ts（路径常量）
export const A2UI_PATH = "/a2ui";           // A2UI bundle 路径前缀
export const CANVAS_HOST_PATH = "/canvas";  // Canvas 服务根路径
export const CANVAS_WS_PATH = "/canvas/ws"; // Canvas WebSocket 路径
```

**Live Reload：** 使用 `chokidar` 监听 bundle 文件变化，通过 WebSocket 推送 live reload 信号（开发模式）：

```typescript
// src/canvas-host/server.ts:7
import chokidar from "chokidar";  // 文件系统监听（Canvas live reload）
```

---

## 5. 文件安全解析（`src/canvas-host/file-resolver.ts`）

`resolveFileWithinRoot()` 防止路径遍历攻击，确保请求的文件路径在 rootDir 范围内：

```typescript
// src/canvas-host/file-resolver.ts（resolveFileWithinRoot）
export function resolveFileWithinRoot(rootDir: string, urlPath: string): string | null {
  const normalized = normalizeUrlPath(urlPath);
  const resolved = path.resolve(rootDir, normalized.slice(1));  // 去掉前导 /
  // 确保解析后的路径仍在 rootDir 内
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    return null;  // 路径遍历攻击，拒绝
  }
  return resolved;
}
```

---

## 6. Gateway 集成

Canvas 通过 Gateway RPC 方法管理 URL 授权：

- `node.canvas.capability.refresh`：刷新 Canvas URL 授权（iOS/Android/macOS 节点调用）
- Canvas 服务器端口通过 Gateway 的 `canvasHostServerPort` 参数传递
- Canvas WebSocket 连接通过 Gateway HTTP 服务器的升级处理器代理

---

## 7. Bundle 哈希

`src/canvas-host/a2ui/.bundle.hash` 是自动生成的文件，记录当前 A2UI bundle 的哈希值：
- 通过 `pnpm canvas:a2ui:bundle` 或 `scripts/bundle-a2ui.sh` 重新生成
- 忽略意外变更；提交时作为独立 commit
