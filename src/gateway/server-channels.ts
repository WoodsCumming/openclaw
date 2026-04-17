import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";

/**
 * 渠道崩溃后的指数退避重启策略。
 * 初始等待 5 秒，每次翻倍，最长等待 5 分钟，附加 10% 随机抖动防止惊群效应。
 */
const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
/** 渠道自动重启的最大尝试次数。超过此次数后停止重启并记录错误日志。 */
const MAX_RESTART_ATTEMPTS = 10;

export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

/**
 * 创建空的渠道运行时存储。
 * 每个渠道拥有独立的存储，包含：
 * - aborts：每个账户的 AbortController（用于停止渠道）
 * - tasks：每个账户的运行 Promise（用于等待停止完成）
 * - runtimes：每个账户的当前运行时快照
 */
function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

/**
 * 判断账户配置是否处于启用状态。
 * 若账户对象不存在或未设置 enabled 字段，默认视为启用。
 * @param account - 渠道账户配置对象
 * @returns 账户启用时返回 true
 */
function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

/**
 * 获取渠道的默认运行时快照（用于初始化尚未运行的账户状态）。
 * 优先使用插件定义的 defaultRuntime，回退到仅含 accountId 的最小快照。
 */
function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

type ChannelManagerOptions = {
  loadConfig: () => OpenClawConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
};

type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
};

/**
 * 创建渠道生命周期管理器。
 *
 * 管理所有渠道账户的启动、停止和自动重启，是 Gateway 中渠道运行时的唯一控制点。
 *
 * 核心机制：
 * - 每个渠道账户有独立的 AbortController 和 Promise 追踪
 * - 账户崩溃后按 CHANNEL_RESTART_POLICY 指数退避自动重启
 * - 手动停止的账户标记到 manuallyStopped 集合，不会自动重启
 * - 通过 plugin.gateway.startAccount / stopAccount 钩子驱动实际启停
 *
 * @param opts.loadConfig - 动态加载最新配置的函数（每次启动时调用）
 * @param opts.channelLogs - 各渠道的子系统日志实例
 * @param opts.channelRuntimeEnvs - 各渠道的运行时环境
 * @returns 渠道管理器接口
 */
// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const { loadConfig, channelLogs, channelRuntimeEnvs } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  // Tracks restart attempts per channel:account. Reset on successful start.
  const restartAttempts = new Map<string, number>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
    const cfg = loadConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId ? [accountId] : plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) {
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
        }
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        if (!enabled) {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: false,
            configured: true,
            running: false,
            lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
          });
          return;
        }

        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (!configured) {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: false,
            running: false,
            lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
          });
          return;
        }

        const rKey = restartKey(channelId, id);
        if (!preserveManualStop) {
          manuallyStopped.delete(rKey);
        }

        const abort = new AbortController();
        store.aborts.set(id, abort);
        if (!preserveRestartAttempts) {
          restartAttempts.delete(rKey);
        }
        setRuntime(channelId, id, {
          accountId: id,
          enabled: true,
          configured: true,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
          reconnectAttempts: preserveRestartAttempts ? (restartAttempts.get(rKey) ?? 0) : 0,
        });

        const log = channelLogs[channelId];
        const task = startAccount({
          cfg,
          accountId: id,
          account,
          runtime: channelRuntimeEnvs[channelId],
          abortSignal: abort.signal,
          log,
          getStatus: () => getRuntime(channelId, id),
          setStatus: (next) => setRuntime(channelId, id, next),
        });
        const trackedPromise = Promise.resolve(task)
          .catch((err) => {
            const message = formatErrorMessage(err);
            setRuntime(channelId, id, { accountId: id, lastError: message });
            log.error?.(`[${id}] channel exited: ${message}`);
          })
          .finally(() => {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              lastStopAt: Date.now(),
            });
          })
          .then(async () => {
            if (manuallyStopped.has(rKey)) {
              return;
            }
            const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
            restartAttempts.set(rKey, attempt);
            if (attempt > MAX_RESTART_ATTEMPTS) {
              log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
              return;
            }
            const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
            log.info?.(
              `[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
            );
            setRuntime(channelId, id, {
              accountId: id,
              reconnectAttempts: attempt,
            });
            try {
              await sleepWithAbort(delayMs, abort.signal);
              if (manuallyStopped.has(rKey)) {
                return;
              }
              if (store.tasks.get(id) === trackedPromise) {
                store.tasks.delete(id);
              }
              if (store.aborts.get(id) === abort) {
                store.aborts.delete(id);
              }
              await startChannelInternal(channelId, id, {
                preserveRestartAttempts: true,
                preserveManualStop: true,
              });
            } catch {
              // abort or startup failure — next crash will retry
            }
          })
          .finally(() => {
            if (store.tasks.get(id) === trackedPromise) {
              store.tasks.delete(id);
            }
            if (store.aborts.get(id) === abort) {
              store.aborts.delete(id);
            }
          });
        store.tasks.set(id, trackedPromise);
      }),
    );
  };

  /**
   * 启动指定渠道的一个或所有账户。
   * 若账户已在运行中（tasks Map 中存在），跳过不重复启动。
   * @param channelId - 渠道 ID
   * @param accountId - 可选，指定账户 ID；不传则启动该渠道所有账户
   */
  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    await startChannelInternal(channelId, accountId);
  };

  /**
   * 停止指定渠道的一个或所有账户。
   * 将账户加入 manuallyStopped 集合，阻止自动重启。
   * 先触发 AbortController，再调用 plugin.gateway.stopAccount（如有），最后等待任务完成。
   * @param channelId - 渠道 ID
   * @param accountId - 可选，指定账户 ID；不传则停止该渠道所有账户
   */
  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) {
      return;
    }
    const cfg = loadConfig();
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          return;
        }
        manuallyStopped.add(restartKey(channelId, id));
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  /**
   * 按注册顺序依次启动所有已注册渠道插件的账户。
   * Gateway 启动时调用，顺序执行（非并发）以避免资源竞争。
   */
  const startChannels = async () => {
    for (const plugin of listChannelPlugins()) {
      await startChannel(plugin.id);
    }
  };

  /**
   * 标记渠道账户已登出（会话失效）。
   * 更新运行时快照：running=false，connected=false（若原来有 connected 字段）。
   * @param channelId - 渠道 ID
   * @param cleared - 若为 true，将 lastError 设为 "logged out"；否则保留原有错误
   * @param accountId - 可选，不传则使用渠道默认账户
   */
  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = loadConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  /**
   * 获取所有渠道账户的当前运行时快照。
   * 合并持久化的 runtimes 状态与插件的 describeAccount 描述，
   * 返回按渠道 ID 索引的快照对象，供 Gateway health/status 接口使用。
   * @returns 包含 channels（默认账户）和 channelAccounts（所有账户）的快照
   */
  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = loadConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured;
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        next.enabled = enabled;
        next.configured = typeof configured === "boolean" ? configured : (next.configured ?? true);
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  const isManuallyStopped_ = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts_ = (channelId: ChannelId, accountId: string): void => {
    restartAttempts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStopped_,
    resetRestartAttempts: resetRestartAttempts_,
  };
}
