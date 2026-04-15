# 路由系统架构文档

> 文件路径：`src/routing/`
> 本文档描述 OpenClaw 路由系统的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

路由系统将一条入站消息（携带 channel + peer + guild + roles 等上下文）映射到具体的 `(agentId, sessionKey)` 元组，决定由哪个 agent 以哪个会话来处理这条消息。

---

## 2. 目录结构

```
src/routing/
├── resolve-route.ts       # 路由解析核心（resolveAgentRoute）
├── bindings.ts            # binding 规则列表管理
├── session-key.ts         # session key 构建与解析
├── account-id.ts          # 账户 ID 规范化
└── account-lookup.ts      # 账户查找工具
```

---

## 3. 核心类型

### 3.1 路由输入（`src/routing/resolve-route.ts`）

```typescript
// src/routing/resolve-route.ts:21-37
export type RoutePeer = {
  kind: ChatType;   // "direct" | "group" | "thread"
  id: string;
};

export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  /** Discord member role IDs — used for role-based agent routing. */
  memberRoleIds?: string[];
};
```

### 3.2 路由结果（`src/routing/resolve-route.ts`）

```typescript
// src/routing/resolve-route.ts:39-57
export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  /** Match description for debugging/logging. */
  matchedBy:
    | "binding.peer"
    | "binding.peer.parent"
    | "binding.guild+roles"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};
```

---

## 4. 解析优先级

路由解析按以下优先级依次匹配 binding 规则：

```
1. binding.peer          — 精确匹配 peer ID（最高优先级）
2. binding.peer.parent   — 匹配父 peer（线程消息继承父 peer 的绑定）
3. binding.guild+roles   — 匹配 guild + 成员角色（Discord 角色路由）
4. binding.guild         — 匹配 guild（服务器/工作区级别）
5. binding.team          — 匹配 team（Slack workspace）
6. binding.account       — 匹配账户
7. binding.channel       — 匹配渠道（渠道级别默认 agent）
8. default               — 默认 agent（最低优先级）
```

---

## 5. Session Key

### 5.1 格式

```
agent-{id}:account-{acctId}:channel-{ch}:peer-{peerId}:type-{chatType}
```

主会话（DM 折叠）：`agent-{id}:main`

### 5.2 DM 作用域（dmScope）

| 作用域 | 说明 |
|--------|------|
| `main` | 所有 DM 共享一个会话（默认） |
| `per-peer` | 每个 peer 独立会话 |
| `per-channel-peer` | 每个渠道 + peer 独立会话 |
| `per-account-channel-peer` | 每个账户 + 渠道 + peer 独立会话 |

### 5.3 Session Key 构建（`src/routing/resolve-route.ts`）

```typescript
// src/routing/resolve-route.ts:85-106
export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** DM session scope. */
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
}): string {
  const channel = normalizeToken(params.channel) || "unknown";
  const peer = params.peer;
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
    channel,
    accountId: params.accountId,
    peerKind: peer?.kind ?? "direct",
    peerId: peer ? normalizeId(peer.id) || "unknown" : null,
    dmScope: params.dmScope,
    identityLinks: params.identityLinks,
  });
}
```

### 5.4 Session Key 工具（`src/routing/session-key.ts`）

```typescript
// src/routing/session-key.ts:19-27
export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export type SessionKeyShape = "missing" | "agent" | "legacy_or_alias" | "malformed_agent";

// Pre-compiled regex（性能优化）
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
```

Session key 形态分类（用于迁移和兼容性检查）：

```typescript
// src/routing/session-key.ts:71-80
export function classifySessionKeyShape(sessionKey: string | undefined | null): SessionKeyShape {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return "missing";
  }
  if (parseAgentSessionKey(raw)) {
    return "agent";
  }
  return raw.toLowerCase().startsWith("agent:") ? "malformed_agent" : "legacy_or_alias";
}
```

---

## 6. 账户 ID 规范化（`src/routing/account-id.ts`）

```typescript
// src/routing/account-id.ts（DEFAULT_ACCOUNT_ID）
export const DEFAULT_ACCOUNT_ID = "default";

// normalizeAccountId: 统一账户 ID 格式（lowercase trim）
export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_ACCOUNT_ID;
}
```

---

## 7. 数据流

```
入站消息（channel + peer + guildId + memberRoleIds）
      │
      ▼
resolveAgentRoute(input)
      │
      ├── listBindings(cfg)  // 获取所有 binding 规则
      │
      ├── 按优先级顺序匹配：
      │   1. peer 精确匹配
      │   2. parentPeer 匹配（线程继承）
      │   3. guild + roles 匹配
      │   4. guild 匹配
      │   5. team 匹配
      │   6. account 匹配
      │   7. channel 匹配
      │   8. 默认 agent
      │
      └── 返回 ResolvedAgentRoute
              ├── agentId
              ├── sessionKey（完整 key，用于持久化）
              └── mainSessionKey（主会话 key，用于 DM 折叠）
```
