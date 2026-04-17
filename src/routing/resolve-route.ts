import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ChatType } from "../channels/chat-type.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { logDebug } from "../logger.js";
import { listBindings } from "./bindings.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAccountId,
  normalizeAgentId,
  sanitizeAgentId,
} from "./session-key.js";

/** @deprecated Use ChatType from channels/chat-type.js */
export type RoutePeerKind = ChatType;

/**
 * 路由中的 peer（对话对象）标识，由消息类型和 ID 组成。
 * @property kind - 聊天类型：direct（私聊）/ group（群组）/ thread（线程）
 * @property id - 渠道内的 peer 唯一标识（如 Telegram chat_id、Discord channel_id）
 */
export type RoutePeer = {
  kind: ChatType;
  id: string;
};

/**
 * 路由解析的输入参数，描述一条入站消息的完整上下文。
 * @property cfg - 当前 OpenClaw 配置（含 bindings 路由规则）
 * @property channel - 渠道 ID（如 "telegram"、"discord"）
 * @property accountId - 渠道账户 ID（多账户渠道时区分）
 * @property peer - 消息来源 peer（私聊/群组/线程）
 * @property parentPeer - 线程的父 peer（用于线程 binding 继承）
 * @property guildId - 服务器/工作区 ID（Discord guild、Slack workspace）
 * @property teamId - 团队 ID
 * @property memberRoleIds - 消息发送者的角色 ID 列表（Discord roles）
 */
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

/**
 * 路由解析结果，确定处理该消息的 agent 和会话。
 * @property agentId - 目标 agent ID
 * @property channel - 规范化后的渠道 ID
 * @property accountId - 规范化后的账户 ID
 * @property sessionKey - 完整会话 key，用于持久化和并发控制
 * @property mainSessionKey - 主会话 key（DM 折叠用，所有 DM 共享）
 * @property matchedBy - 命中的 binding 层级，用于调试日志
 */
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

export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";

/** 规范化 token 字符串：trim + lowercase，用于渠道 ID / accountId 等的比对。 */
function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** 规范化 ID 值：将字符串 trim，数字转字符串，其他返回空字符串。 */
function normalizeId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

/**
 * 判断 binding 的 accountId 模式是否匹配实际账户 ID。
 * - 空模式：匹配默认账户（DEFAULT_ACCOUNT_ID）
 * - "*"：匹配任意账户
 * - 其他：规范化后精确匹配
 */
function matchesAccountId(match: string | undefined, actual: string): boolean {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID;
  }
  if (trimmed === "*") {
    return true;
  }
  return normalizeAccountId(trimmed) === actual;
}

/**
 * 根据路由上下文构建 agent 会话 key。
 *
 * 会话 key 格式取决于 dmScope 配置：
 * - main：所有 DM 共享 `agent-{id}:main`
 * - per-peer：每个 peer 独立 `agent-{id}:...:peer-{peerId}`
 * - per-channel-peer：渠道 + peer 隔离
 * - per-account-channel-peer：账户 + 渠道 + peer 完全隔离
 *
 * @param params.agentId - agent ID
 * @param params.channel - 渠道 ID
 * @param params.peer - peer 信息（可选）
 * @param params.dmScope - DM 会话作用域（来自配置 session.dmScope）
 * @param params.identityLinks - 身份链接映射（用于跨渠道会话合并）
 * @returns 小写规范化的会话 key 字符串
 */
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

function listAgents(cfg: OpenClawConfig) {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? agents : [];
}

function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string {
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    return sanitizeAgentId(resolveDefaultAgentId(cfg));
  }
  const normalized = normalizeAgentId(trimmed);
  const agents = listAgents(cfg);
  if (agents.length === 0) {
    return sanitizeAgentId(trimmed);
  }
  const match = agents.find((agent) => normalizeAgentId(agent.id) === normalized);
  if (match?.id?.trim()) {
    return sanitizeAgentId(match.id.trim());
  }
  return sanitizeAgentId(resolveDefaultAgentId(cfg));
}

function matchesChannel(
  match: { channel?: string | undefined } | undefined,
  channel: string,
): boolean {
  const key = normalizeToken(match?.channel);
  if (!key) {
    return false;
  }
  return key === channel;
}

type NormalizedPeerConstraint =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "valid"; kind: ChatType; id: string };

type NormalizedBindingMatch = {
  accountPattern: string;
  peer: NormalizedPeerConstraint;
  guildId: string | null;
  teamId: string | null;
  roles: string[] | null;
};

type EvaluatedBinding = {
  binding: ReturnType<typeof listBindings>[number];
  match: NormalizedBindingMatch;
};

type BindingScope = {
  peer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: Set<string>;
};

type EvaluatedBindingsCache = {
  bindingsRef: OpenClawConfig["bindings"];
  byChannelAccount: Map<string, EvaluatedBinding[]>;
};

const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2000;

/**
 * 获取指定渠道账户的已评估 binding 列表（带缓存）。
 *
 * 缓存策略：以 OpenClawConfig 对象为 WeakMap key，
 * 配置未变化时命中缓存，配置对象更换时自动失效。
 * 单个配置对象的缓存条目上限为 2000 个渠道账户组合。
 *
 * @param cfg - 当前配置
 * @param channel - 规范化渠道 ID
 * @param accountId - 规范化账户 ID
 * @returns 已过滤出匹配该渠道+账户的 binding 列表
 */
function getEvaluatedBindingsForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBinding[] {
  const bindingsRef = cfg.bindings;
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cache =
    existing && existing.bindingsRef === bindingsRef
      ? existing
      : { bindingsRef, byChannelAccount: new Map<string, EvaluatedBinding[]>() };
  if (cache !== existing) {
    evaluatedBindingsCacheByCfg.set(cfg, cache);
  }

  const cacheKey = `${channel}\t${accountId}`;
  const hit = cache.byChannelAccount.get(cacheKey);
  if (hit) {
    return hit;
  }

  const evaluated: EvaluatedBinding[] = listBindings(cfg).flatMap((binding) => {
    if (!binding || typeof binding !== "object") {
      return [];
    }
    if (!matchesChannel(binding.match, channel)) {
      return [];
    }
    if (!matchesAccountId(binding.match?.accountId, accountId)) {
      return [];
    }
    return [{ binding, match: normalizeBindingMatch(binding.match) }];
  });

  cache.byChannelAccount.set(cacheKey, evaluated);
  if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
    cache.byChannelAccount.clear();
    cache.byChannelAccount.set(cacheKey, evaluated);
  }

  return evaluated;
}

function normalizePeerConstraint(
  peer: { kind?: string; id?: string } | undefined,
): NormalizedPeerConstraint {
  if (!peer) {
    return { state: "none" };
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeId(peer.id);
  if (!kind || !id) {
    return { state: "invalid" };
  }
  return { state: "valid", kind, id };
}

function normalizeBindingMatch(
  match:
    | {
        accountId?: string | undefined;
        peer?: { kind?: string; id?: string } | undefined;
        guildId?: string | undefined;
        teamId?: string | undefined;
        roles?: string[] | undefined;
      }
    | undefined,
): NormalizedBindingMatch {
  const rawRoles = match?.roles;
  return {
    accountPattern: (match?.accountId ?? "").trim(),
    peer: normalizePeerConstraint(match?.peer),
    guildId: normalizeId(match?.guildId) || null,
    teamId: normalizeId(match?.teamId) || null,
    roles: Array.isArray(rawRoles) && rawRoles.length > 0 ? rawRoles : null,
  };
}

function hasGuildConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.guildId);
}

function hasTeamConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.teamId);
}

function hasRolesConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.roles);
}

function matchesBindingScope(match: NormalizedBindingMatch, scope: BindingScope): boolean {
  if (match.peer.state === "invalid") {
    return false;
  }
  if (match.peer.state === "valid") {
    if (!scope.peer || scope.peer.kind !== match.peer.kind || scope.peer.id !== match.peer.id) {
      return false;
    }
  }
  if (match.guildId && match.guildId !== scope.guildId) {
    return false;
  }
  if (match.teamId && match.teamId !== scope.teamId) {
    return false;
  }
  if (match.roles) {
    for (const role of match.roles) {
      if (scope.memberRoleIds.has(role)) {
        return true;
      }
    }
    return false;
  }
  return true;
}

/**
 * 核心路由解析函数：将入站消息映射到 (agentId, sessionKey)。
 *
 * 按优先级依次匹配 8 个 binding 层级：
 * 1. binding.peer — 精确匹配 peer ID（最高优先级）
 * 2. binding.peer.parent — 匹配父 peer（线程继承）
 * 3. binding.guild+roles — guild + 成员角色组合匹配
 * 4. binding.guild — guild 级别匹配
 * 5. binding.team — team 级别匹配
 * 6. binding.account — 账户级别匹配
 * 7. binding.channel — 渠道级别匹配（accountId="*"）
 * 8. default — 使用配置中的默认 agent
 *
 * 每个层级找到第一个匹配的 binding 后立即返回，不继续向下匹配。
 * 开启 verbose 日志时输出详细匹配过程。
 *
 * @param input - 路由输入（含消息上下文和配置）
 * @returns 路由结果（agentId + sessionKey + matchedBy）
 */
export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer
    ? {
        kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
        id: normalizeId(input.peer.id),
      }
    : null;
  const guildId = normalizeId(input.guildId);
  const teamId = normalizeId(input.teamId);
  const memberRoleIds = input.memberRoleIds ?? [];
  const memberRoleIdSet = new Set(memberRoleIds);

  const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);

  const dmScope = input.cfg.session?.dmScope ?? "main";
  const identityLinks = input.cfg.session?.identityLinks;

  const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const sessionKey = buildAgentSessionKey({
      agentId: resolvedAgentId,
      channel,
      accountId,
      peer,
      dmScope,
      identityLinks,
    }).toLowerCase();
    const mainSessionKey = buildAgentMainSessionKey({
      agentId: resolvedAgentId,
      mainKey: DEFAULT_MAIN_KEY,
    }).toLowerCase();
    return {
      agentId: resolvedAgentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      matchedBy,
    };
  };

  const shouldLogDebug = shouldLogVerbose();
  const formatPeer = (value?: RoutePeer | null) =>
    value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
  const formatNormalizedPeer = (value: NormalizedPeerConstraint) => {
    if (value.state === "none") {
      return "none";
    }
    if (value.state === "invalid") {
      return "invalid";
    }
    return `${value.kind}:${value.id}`;
  };

  if (shouldLogDebug) {
    logDebug(
      `[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`,
    );
    for (const entry of bindings) {
      logDebug(
        `[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`,
      );
    }
  }
  // Thread parent inheritance: if peer (thread) didn't match, check parent peer binding
  const parentPeer = input.parentPeer
    ? {
        kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
        id: normalizeId(input.parentPeer.id),
      }
    : null;
  const baseScope = {
    guildId,
    teamId,
    memberRoleIds: memberRoleIdSet,
  };

  const tiers: Array<{
    matchedBy: Exclude<ResolvedAgentRoute["matchedBy"], "default">;
    enabled: boolean;
    scopePeer: RoutePeer | null;
    predicate: (candidate: EvaluatedBinding) => boolean;
  }> = [
    {
      matchedBy: "binding.peer",
      enabled: Boolean(peer),
      scopePeer: peer,
      predicate: (candidate) => candidate.match.peer.state === "valid",
    },
    {
      matchedBy: "binding.peer.parent",
      enabled: Boolean(parentPeer && parentPeer.id),
      scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
      predicate: (candidate) => candidate.match.peer.state === "valid",
    },
    {
      matchedBy: "binding.guild+roles",
      enabled: Boolean(guildId && memberRoleIds.length > 0),
      scopePeer: peer,
      predicate: (candidate) =>
        hasGuildConstraint(candidate.match) && hasRolesConstraint(candidate.match),
    },
    {
      matchedBy: "binding.guild",
      enabled: Boolean(guildId),
      scopePeer: peer,
      predicate: (candidate) =>
        hasGuildConstraint(candidate.match) && !hasRolesConstraint(candidate.match),
    },
    {
      matchedBy: "binding.team",
      enabled: Boolean(teamId),
      scopePeer: peer,
      predicate: (candidate) => hasTeamConstraint(candidate.match),
    },
    {
      matchedBy: "binding.account",
      enabled: true,
      scopePeer: peer,
      predicate: (candidate) => candidate.match.accountPattern !== "*",
    },
    {
      matchedBy: "binding.channel",
      enabled: true,
      scopePeer: peer,
      predicate: (candidate) => candidate.match.accountPattern === "*",
    },
  ];

  for (const tier of tiers) {
    if (!tier.enabled) {
      continue;
    }
    const matched = bindings.find(
      (candidate) =>
        tier.predicate(candidate) &&
        matchesBindingScope(candidate.match, {
          ...baseScope,
          peer: tier.scopePeer,
        }),
    );
    if (matched) {
      if (shouldLogDebug) {
        logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
      }
      return choose(matched.binding.agentId, tier.matchedBy);
    }
  }

  return choose(resolveDefaultAgentId(input.cfg), "default");
}
