export { deferred, type Deferred } from "../../promise";

export const HELLO_INTERVAL_MS = 100;
export const ATTACH_TIMEOUT_MS = 1_000;
export const FORWARD_ACK_TIMEOUT_MS = 1_000;
export const LEADER_RECOVERY_TIMEOUT_MS = 5_000;

export interface CoordinatorTimeouts {
  helloIntervalMs: number;
  attachTimeoutMs: number;
  forwardAckTimeoutMs: number;
  leaderRecoveryTimeoutMs: number;
}

export const DEFAULT_COORDINATOR_TIMEOUTS: CoordinatorTimeouts = {
  attachTimeoutMs: ATTACH_TIMEOUT_MS,
  forwardAckTimeoutMs: FORWARD_ACK_TIMEOUT_MS,
  helloIntervalMs: HELLO_INTERVAL_MS,
  leaderRecoveryTimeoutMs: LEADER_RECOVERY_TIMEOUT_MS,
};

export function clientId(request: { clientId?: string; id: number }): string {
  return typeof request.clientId === "string"
    ? request.clientId
    : `client:${Math.trunc(request.id / 1_000_000)}`;
}

export function localClientKey(workerId: string, id: string): string {
  return `${workerId}:${id}`;
}
