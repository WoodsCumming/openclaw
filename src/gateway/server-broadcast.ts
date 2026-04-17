import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

/**
 * 敏感事件的 scope 守卫映射。
 * 只有持有对应 scope 的 operator 才能接收这些事件推送。
 * 例如 exec.approval.* 需要 operator.approvals scope，设备配对事件需要 operator.pairing scope。
 */
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};

/**
 * 广播事件携带的状态版本号，用于客户端去重和增量更新。
 * presence 版本变化表示在线状态有更新，health 版本变化表示健康状态有更新。
 */
export type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

/**
 * Gateway 事件广播选项。
 * @property dropIfSlow - 若客户端缓冲区已满（慢消费者），丢弃此帧而非关闭连接
 * @property stateVersion - 附带的状态版本号，客户端据此判断是否需要重新拉取状态
 */
export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;

/**
 * 检查客户端是否有权限接收指定事件。
 *
 * 逻辑：
 * - 未在 EVENT_SCOPE_GUARDS 中注册的事件，所有客户端均可接收
 * - node role 无法接收受保护事件
 * - operator.admin scope 可接收所有受保护事件
 * - 其他 operator 需持有事件对应的具体 scope
 *
 * @param client - WebSocket 客户端（含 role 和 scopes）
 * @param event - 事件名称
 * @returns 客户端有权接收该事件时返回 true
 */
function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  return required.some((scope) => scopes.includes(scope));
}

/**
 * 创建 Gateway 事件广播器工厂。
 *
 * 返回两个函数：
 * - `broadcast`：向所有连接的客户端广播事件（按 scope 过滤），附带全局递增序列号
 * - `broadcastToConnIds`：仅向指定 connId 集合广播（定向推送，不递增全局序列号）
 *
 * 慢消费者处理：
 * - `dropIfSlow=true` 时跳过缓冲区满的客户端
 * - `dropIfSlow=false`（默认）时关闭慢消费者连接（code 1008）
 *
 * @param params.clients - 当前所有活跃 WebSocket 客户端集合
 * @returns 包含 broadcast 和 broadcastToConnIds 的对象
 */
export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ) => {
    if (params.clients.size === 0) {
      return;
    }
    const isTargeted = Boolean(targetConnIds);
    const eventSeq = isTargeted ? undefined : ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    if (shouldLogWs()) {
      const logMeta: Record<string, unknown> = {
        event,
        seq: eventSeq ?? "targeted",
        clients: params.clients.size,
        targets: targetConnIds ? targetConnIds.size : undefined,
        dropIfSlow: opts?.dropIfSlow,
        presenceVersion: opts?.stateVersion?.presence,
        healthVersion: opts?.stateVersion?.health,
      };
      if (event === "agent") {
        Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
      }
      logWs("out", "event", logMeta);
    }
    for (const c of params.clients) {
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      if (!hasEventScope(c, event)) {
        continue;
      }
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) =>
    broadcastInternal(event, payload, opts);

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  return { broadcast, broadcastToConnIds };
}
