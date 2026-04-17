import type { IncomingMessage } from "node:http";
import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";
import {
  isLocalishHost,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
} from "./net.js";

export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
export type ResolvedGatewayAuthModeSource =
  | "override"
  | "config"
  | "password"
  | "token"
  | "default";

/**
 * Gateway 认证解析结果，描述当前生效的认证模式和凭据。
 * 由 {@link resolveGatewayAuth} 从配置和环境变量计算得出。
 * @property mode - 认证模式：none（无需认证）/ token / password / trusted-proxy
 * @property modeSource - 模式来源，用于调试（override > config > 凭据推断 > default）
 * @property allowTailscale - 是否允许 Tailscale 身份认证
 */
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};

/**
 * Gateway 认证结果。
 * @property ok - 认证是否通过
 * @property method - 实际使用的认证方式
 * @property user - 认证用户标识（Tailscale login 或 trusted-proxy 用户头）
 * @property reason - 认证失败原因代码（如 "token_mismatch"）
 * @property rateLimited - 是否被速率限制拦截
 * @property retryAfterMs - 速率限制时建议的重试等待时间（毫秒）
 */
export type GatewayAuthResult = {
  ok: boolean;
  method?: "none" | "token" | "password" | "tailscale" | "device-token" | "trusted-proxy";
  user?: string;
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

export type GatewayAuthSurface = "http" | "ws-control-ui";

export type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
  /**
   * Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled.
   * WS Control UI enables it intentionally for tokenless trusted-host login.
   */
  authSurface?: GatewayAuthSurface;
  /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
  rateLimiter?: AuthRateLimiter;
  /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
  clientIp?: string;
  /** Optional limiter scope; defaults to shared-secret auth scope. */
  rateLimitScope?: string;
  /** Trust X-Real-IP only when explicitly enabled. */
  allowRealIpFallback?: boolean;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

/** 规范化登录名：trim + lowercase，用于 Tailscale 用户名比对。 */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** 从 HTTP header 值中取第一个字符串（处理数组形式的 header）。 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

/**
 * 从请求中解析 Tailscale 客户端 IP。
 * 信任来自 loopback（127.0.0.1 / ::1）的 X-Forwarded-For，
 * 因为 Tailscale serve 代理始终运行在本机。
 */
function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    trustedProxies: [...TAILSCALE_TRUSTED_PROXIES],
  });
}

/**
 * 从请求中解析真实客户端 IP，支持可信代理的 X-Forwarded-For 穿透。
 * @param req - HTTP 请求
 * @param trustedProxies - 可信代理 IP 列表
 * @param allowRealIpFallback - 是否信任 X-Real-IP 头（需显式启用）
 */
function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
    allowRealIpFallback,
  });
}

/**
 * 判断请求是否来自本机直连（非通过代理转发）。
 *
 * 满足以下所有条件时返回 true：
 * 1. 客户端 IP 是 loopback 地址
 * 2. Host 是本地地址（localhost / 127.x / ::1）
 * 3. 没有转发头，或转发头来自可信代理
 *
 * 用于决定是否允许无 token 的 loopback 访问。
 */
export function isLocalDirectRequest(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): boolean {
  if (!req) {
    return false;
  }
  const clientIp = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ?? "";
  if (!isLoopbackAddress(clientIp)) {
    return false;
  }

  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return isLocalishHost(req.headers?.host) && (!hasForwarded || remoteIsTrustedProxy);
}

/**
 * 从请求头中提取 Tailscale 用户信息。
 * Tailscale serve 代理会注入 tailscale-user-login / tailscale-user-name 等头。
 * @returns 用户信息对象，或 null（若头不存在或为空）
 */
function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

/**
 * 判断请求是否经由 Tailscale serve 代理转发。
 * 条件：remote address 为 loopback 且同时存在 X-Forwarded-For/Proto/Host 三个头。
 */
function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

/**
 * 通过 Tailscale whois API 验证请求头中的用户身份。
 *
 * 验证流程：
 * 1. 从请求头提取 tailscale-user-login
 * 2. 确认请求来自 Tailscale 代理（非伪造头）
 * 3. 调用 tailscaleWhois(clientIp) 获取真实身份
 * 4. 比对头中的 login 与 whois 返回的 login（防止头伪造）
 *
 * @returns 验证成功返回 {ok:true, user}，失败返回 {ok:false, reason}
 */
async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

/**
 * 从配置和环境变量计算 Gateway 认证配置。
 *
 * 优先级（高到低）：
 * 1. authOverride（运行时覆盖，如 CLI 参数）
 * 2. authConfig（配置文件中的 gateway.auth）
 * 3. 环境变量（OPENCLAW_GATEWAY_TOKEN 等）
 *
 * 模式推断（未显式配置时）：有 password → password 模式；有 token → token 模式；否则 token 模式（无凭据）。
 *
 * @param params.authConfig - 配置文件中的认证配置
 * @param params.authOverride - 运行时覆盖配置（优先级最高）
 * @param params.env - 环境变量（默认 process.env）
 * @param params.tailscaleMode - Tailscale 集成模式
 * @returns 解析后的认证配置
 */
export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  authOverride?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const baseAuthConfig = params.authConfig ?? {};
  const authOverride = params.authOverride ?? undefined;
  const authConfig: GatewayAuthConfig = { ...baseAuthConfig };
  if (authOverride) {
    if (authOverride.mode !== undefined) {
      authConfig.mode = authOverride.mode;
    }
    if (authOverride.token !== undefined) {
      authConfig.token = authOverride.token;
    }
    if (authOverride.password !== undefined) {
      authConfig.password = authOverride.password;
    }
    if (authOverride.allowTailscale !== undefined) {
      authConfig.allowTailscale = authOverride.allowTailscale;
    }
    if (authOverride.rateLimit !== undefined) {
      authConfig.rateLimit = authOverride.rateLimit;
    }
    if (authOverride.trustedProxy !== undefined) {
      authConfig.trustedProxy = authOverride.trustedProxy;
    }
  }
  const env = params.env ?? process.env;
  const resolvedCredentials = resolveGatewayCredentialsFromValues({
    configToken: authConfig.token,
    configPassword: authConfig.password,
    env,
    includeLegacyEnv: false,
    tokenPrecedence: "config-first",
    passwordPrecedence: "config-first",
  });
  const token = resolvedCredentials.token;
  const password = resolvedCredentials.password;
  const trustedProxy = authConfig.trustedProxy;

  let mode: ResolvedGatewayAuth["mode"];
  let modeSource: ResolvedGatewayAuth["modeSource"];
  if (authOverride?.mode !== undefined) {
    mode = authOverride.mode;
    modeSource = "override";
  } else if (authConfig.mode) {
    mode = authConfig.mode;
    modeSource = "config";
  } else if (password) {
    mode = "password";
    modeSource = "password";
  } else if (token) {
    mode = "token";
    modeSource = "token";
  } else {
    mode = "token";
    modeSource = "default";
  }

  const allowTailscale =
    authConfig.allowTailscale ??
    (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");

  return {
    mode,
    modeSource,
    token,
    password,
    allowTailscale,
    trustedProxy,
  };
}

/**
 * 断言 Gateway 认证配置完整有效。
 * 在 Gateway 启动时调用，若配置不完整（如 token 模式但未配置 token）则抛出错误。
 * @throws Error 配置不完整时抛出含具体提示的错误
 */
export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)",
      );
    }
    if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {
      throw new Error(
        "gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)",
      );
    }
  }
}

/**
 * Check if the request came from a trusted proxy and extract user identity.
 * Returns the user identity if valid, or null with a reason if not.
 */
function authorizeTrustedProxy(params: {
  req?: IncomingMessage;
  trustedProxies?: string[];
  trustedProxyConfig: GatewayTrustedProxyConfig;
}): { user: string } | { reason: string } {
  const { req, trustedProxies, trustedProxyConfig } = params;

  if (!req) {
    return { reason: "trusted_proxy_no_request" };
  }

  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
    return { reason: "trusted_proxy_untrusted_source" };
  }

  const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
  for (const header of requiredHeaders) {
    const value = headerValue(req.headers[header.toLowerCase()]);
    if (!value || value.trim() === "") {
      return { reason: `trusted_proxy_missing_header_${header}` };
    }
  }

  const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
  if (!userHeaderValue || userHeaderValue.trim() === "") {
    return { reason: "trusted_proxy_user_missing" };
  }

  const user = userHeaderValue.trim();

  const allowUsers = trustedProxyConfig.allowUsers ?? [];
  if (allowUsers.length > 0 && !allowUsers.includes(user)) {
    return { reason: "trusted_proxy_user_not_allowed" };
  }

  return { user };
}

function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean {
  return authSurface === "ws-control-ui";
}

/**
 * 核心认证函数：验证 WebSocket/HTTP 连接请求是否有权访问 Gateway。
 *
 * 认证流程（按模式）：
 * - trusted-proxy：验证来源 IP 在可信代理列表中，并从指定 header 提取用户名
 * - none：直接放行
 * - token/password：先检查速率限制，再尝试 Tailscale 认证（ws-control-ui 表面），最后验证凭据
 *
 * 速率限制：失败时记录，成功时重置；被限制时返回 retryAfterMs。
 *
 * @param params - 认证参数，含认证配置、连接凭据、请求对象、速率限制器等
 * @returns 认证结果，包含 ok、method、user、reason 等字段
 */
export async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const authSurface = params.authSurface ?? "http";
  const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
  const localDirect = isLocalDirectRequest(
    req,
    trustedProxies,
    params.allowRealIpFallback === true,
  );

  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    if (!trustedProxies || trustedProxies.length === 0) {
      return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
    }

    const result = authorizeTrustedProxy({
      req,
      trustedProxies,
      trustedProxyConfig: auth.trustedProxy,
    });

    if ("user" in result) {
      return { ok: true, method: "trusted-proxy", user: result.user };
    }
    return { ok: false, reason: result.reason };
  }

  if (auth.mode === "none") {
    return { ok: true, method: "none" };
  }

  const limiter = params.rateLimiter;
  const ip =
    params.clientIp ??
    resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;
  const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
  if (limiter) {
    const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
    if (!rlCheck.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: rlCheck.retryAfterMs,
      };
    }
  }

  if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      limiter?.reset(ip, rateLimitScope);
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return { ok: false, reason: "token_missing_config" };
    }
    if (!connectAuth?.token) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_missing" };
    }
    if (!safeEqualSecret(connectAuth.token, auth.token)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqualSecret(password, auth.password)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "password_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "password" };
  }

  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

/**
 * HTTP 表面的 Gateway 认证入口。
 * 固定 authSurface="http"（禁用 Tailscale header 认证，防止 SSRF）。
 * @see authorizeGatewayConnect
 */
export async function authorizeHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http",
  });
}

/**
 * WebSocket Control UI 表面的 Gateway 认证入口。
 * 固定 authSurface="ws-control-ui"（允许 Tailscale header 认证，支持 tokenless 本地登录）。
 * @see authorizeGatewayConnect
 */
export async function authorizeWsControlUiGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "ws-control-ui",
  });
}
