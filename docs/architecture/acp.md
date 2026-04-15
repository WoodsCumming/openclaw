# ACP 服务架构文档

> 文件路径：`src/acp/`
> 本文档描述 OpenClaw ACP（Agent Client Protocol）服务的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

ACP（Agent Client Protocol）是 OpenClaw 与外部 AI agent 运行时通信的标准协议。基于 `@agentclientprotocol/sdk`，允许 Pi CLI、Claude Code 等外部 agent 通过标准协议接入 OpenClaw Gateway，使用 OpenClaw 的渠道能力（发送消息、访问工具等）。

---

## 2. 目录结构

```
src/acp/
├── server.ts              # ACP 服务端入口（serveAcpGateway）
├── translator.ts          # ACP ↔ Gateway 协议翻译（AcpGatewayAgent）
├── session-mapper.ts      # ACP 会话 ↔ Gateway 会话 双向映射
├── session.ts             # ACP 会话管理
├── client.ts              # ACP 客户端（用于测试）
├── policy.ts              # ACP 访问策略
├── meta.ts                # ACP meta 字段解析工具
├── types.ts               # ACP 类型定义
├── secret-file.ts         # 从文件读取 ACP 认证 secret
├── event-mapper.ts        # Gateway 事件 → ACP 事件映射
├── commands.ts            # ACP 命令处理
└── runtime/               # ACP 运行时
    ├── types.ts            # 运行时类型
    ├── registry.ts         # 会话注册表
    ├── session-identity.ts # 会话身份
    ├── session-identifiers.ts # 会话标识符
    ├── session-meta.ts     # 会话元数据
    ├── errors.ts           # 错误类型
    └── error-text.ts       # 错误文本
```

---

## 3. ACP 服务端（`src/acp/server.ts`）

`serveAcpGateway()` 启动 ACP 服务，建立与 Gateway 的 WebSocket 连接，并通过 `AcpGatewayAgent` 翻译层桥接 ACP 协议：

```typescript
// src/acp/server.ts:15-28
export async function serveAcpGateway(opts: AcpServerOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const connection = buildGatewayConnectionDetails({
    config: cfg,
    url: opts.gatewayUrl,
  });
  const creds = resolveGatewayCredentialsFromConfig({
    cfg,
    env: process.env,
    explicitAuth: {
      token: opts.gatewayToken,
      password: opts.gatewayPassword,
    },
  });
```

Gateway 客户端连接管理（支持自动重连）：

```typescript
// src/acp/server.ts:58-76
const gateway = new GatewayClient({
  url: connection.url,
  token: creds.token,
  // ...
  onEvent: (evt) => {
    void agent?.handleGatewayEvent(evt);  // 转发 Gateway 事件给 ACP agent
  },
  onHelloOk: () => {
    resolveGatewayReady();
    agent?.handleGatewayReconnect();      // 重连后通知 ACP agent
  },
  onConnectError: (err) => {
    rejectGatewayReady(err);
  },
  onClose: (code, reason) => {
    if (!stopped) {
      rejectGatewayReady(new Error(`gateway closed before ready (${code}): ${reason}`));
    }
    agent?.handleGatewayDisconnect(`${code}: ${reason}`);
    if (stopped) {
      onClosed();
    }
  },
});
```

---

## 4. 会话映射（`src/acp/session-mapper.ts`）

ACP 会话与 Gateway 会话通过 `resolveSessionKey()` 双向映射，支持标签（label）和精确 key 两种查找方式：

```typescript
// src/acp/session-mapper.ts:5-23
export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}
```

会话 key 解析（优先标签 → 精确 key → 默认 fallback）：

```typescript
// src/acp/session-mapper.ts:25-58
export async function resolveSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<string> {
  // 1. 优先使用 sessionLabel（通过 sessions.resolve RPC 解析）
  if (params.meta.sessionLabel) {
    const resolved = await params.gateway.request<{ ok: true; key: string }>("sessions.resolve", {
      label: params.meta.sessionLabel,
    });
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${params.meta.sessionLabel}`);
    }
    return resolved.key;
  }
  // 2. 使用精确 sessionKey
  if (params.meta.sessionKey) {
    if (!requireExisting) {
      return params.meta.sessionKey;
    }
    // ...
  }
  // 3. fallback 到默认 key
}
```

---

## 5. 协议翻译层（`src/acp/translator.ts`）

`AcpGatewayAgent` 负责将 ACP 协议消息翻译为 Gateway WebSocket 调用，是 ACP 服务的核心翻译层。

---

## 6. 数据流

```
外部 AI Agent（Pi CLI / Claude Code）
      │  ACP 协议（stdio / HTTP）
      ▼
serveAcpGateway()
      │
      ├── GatewayClient（WebSocket 连接到 Gateway）
      │
      ├── AcpGatewayAgent（协议翻译）
      │   ├── ACP 消息 → Gateway RPC 调用
      │   └── Gateway 事件 → ACP 响应
      │
      └── session-mapper（会话 key 解析）
```
