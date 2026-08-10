import {
  WorkerCommand,
  WorkerEvent,
  type RuntimeIdentity,
  type SerializedError,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol";
import { CURRENT_BROWSER_COORDINATION_CONTRACT_ID } from "./contract";

export type InitRequest = Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>;

export type Timer = ReturnType<typeof setTimeout>;

export type BroadcastChannelLike = {
  addEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
  close(): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
};

export type LockManagerLike = {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
};

export const ControlOp = {
  SeekLeader: 1,
  BroadcastLeader: 2,
} as const;

export type ControlOpCode = (typeof ControlOp)[keyof typeof ControlOp];

export const PeerOp = {
  Attach: 1,
  Request: 2,
  RequestAck: 3,
  Attached: 4,
  Rejected: 5,
  Response: 6,
} as const;

export type PeerOpCode = (typeof PeerOp)[keyof typeof PeerOp];
/** Exact contract required for one browser coordination session. @internal */
export const BrowserCoordinationContractId = CURRENT_BROWSER_COORDINATION_CONTRACT_ID;

/**
 * Why a leader rejected an attach. Identity and storage-path mismatches are permanent — the
 * follower must fail instead of retrying; anything else is retried with bounded backoff.
 */
export const RejectCode = {
  IdentityMismatch: 1,
  StoragePathMismatch: 2,
  Internal: 3,
  RemoteMismatch: 4,
  DeploymentMismatch: 5,
} as const;

export type RejectCodeValue = (typeof RejectCode)[keyof typeof RejectCode];

/** An attach rejection carrying its structured {@link RejectCode}. */
export class AttachRejection extends Error {
  constructor(
    readonly code: RejectCodeValue,
    message: string,
    name = "ConvexEmbeddedAttachRejection",
  ) {
    super(message);
    this.name = name;
  }
}

export type ControlMessage =
  | {
      clientId: string;
      identity: RuntimeIdentity;
      op: typeof ControlOp.SeekLeader;
      coordinationId: typeof BrowserCoordinationContractId;
      scope: string;
      storagePath: string;
      workerId: string;
    }
  | {
      identity: RuntimeIdentity;
      leaderEpoch: string;
      /** Canonical decimal term allocated by the physical store owner. */
      leaderFence: string;
      leaderId: string;
      op: typeof ControlOp.BroadcastLeader;
      coordinationId: typeof BrowserCoordinationContractId;
      scope: string;
    };

export type PeerMessage =
  | {
      clientId: string;
      identity: RuntimeIdentity;
      leaderEpoch: string;
      /** The term advertised by the leader this attach is targeting. */
      leaderFence: string;
      op: typeof PeerOp.Attach;
      coordinationId: typeof BrowserCoordinationContractId;
      remote?: InitRequest["remote"];
      scope: string;
      storagePath: string;
      workerId: string;
    }
  | {
      fromWorkerId: string;
      leaderEpoch: string;
      leaderFence: string;
      op: typeof PeerOp.Request;
      coordinationId: typeof BrowserCoordinationContractId;
      request: WorkerRequest;
    }
  | {
      leaderEpoch: string;
      leaderFence: string;
      op: typeof PeerOp.RequestAck;
      coordinationId: typeof BrowserCoordinationContractId;
      requestId: number;
    }
  | {
      leaderEpoch: string;
      leaderFence: string;
      leaderId: string;
      /** The leader's device-only module configuration, which a follower cannot read itself. */
      localConfigured?: boolean;
      op: typeof PeerOp.Attached;
      coordinationId: typeof BrowserCoordinationContractId;
    }
  | {
      code: RejectCodeValue;
      error: SerializedError;
      leaderEpoch: string;
      leaderFence: string;
      op: typeof PeerOp.Rejected;
      coordinationId: typeof BrowserCoordinationContractId;
    }
  | {
      leaderEpoch: string;
      leaderFence: string;
      op: typeof PeerOp.Response;
      coordinationId: typeof BrowserCoordinationContractId;
      response: WorkerResponse;
    };

type Validator = (value: Record<string, unknown>) => boolean;

const controlValidators = new Map<ControlOpCode, Validator>([
  [
    ControlOp.SeekLeader,
    (value) =>
      typeof value.clientId === "string" &&
      isRuntimeIdentity(value.identity) &&
      typeof value.scope === "string" &&
      typeof value.storagePath === "string" &&
      typeof value.workerId === "string",
  ],
  [
    ControlOp.BroadcastLeader,
    (value) =>
      isRuntimeIdentity(value.identity) &&
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      typeof value.leaderId === "string" &&
      typeof value.scope === "string",
  ],
]);

const peerValidators = new Map<PeerOpCode, Validator>([
  [
    PeerOp.Attach,
    (value) =>
      typeof value.clientId === "string" &&
      isRuntimeIdentity(value.identity) &&
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      (value.remote === undefined || isRemoteInit(value.remote)) &&
      typeof value.scope === "string" &&
      typeof value.storagePath === "string" &&
      typeof value.workerId === "string",
  ],
  [
    PeerOp.Request,
    (value) =>
      typeof value.fromWorkerId === "string" &&
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      isWorkerRequest(value.request),
  ],
  [
    PeerOp.RequestAck,
    (value) =>
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      typeof value.requestId === "number",
  ],
  [
    PeerOp.Attached,
    (value) =>
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      typeof value.leaderId === "string",
  ],
  [
    PeerOp.Rejected,
    (value) =>
      typeof value.code === "number" &&
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      isSerializedError(value.error),
  ],
  [
    PeerOp.Response,
    (value) =>
      typeof value.leaderEpoch === "string" &&
      isCanonicalFence(value.leaderFence) &&
      isWorkerResponse(value.response),
  ],
]);

export function controlChannelName(storageId: string): string {
  return `convex-embedded:storage:${safe(storageId)}:control`;
}

export function storageOwnerLockName(identity: RuntimeIdentity): string {
  return `convex-embedded:storage-owner:${safe(identity.storageId)}`;
}

export function workerChannelName(scope: string, workerId: string): string {
  return `${scope}:worker:${workerId}`;
}

export function workerLockName(scope: string, workerId: string): string {
  return `${scope}:worker:${workerId}`;
}

export function requestAck(
  leaderEpoch: string,
  leaderFence: string,
  requestId: number,
): Extract<PeerMessage, { op: typeof PeerOp.RequestAck }> {
  return {
    leaderEpoch,
    leaderFence,
    op: PeerOp.RequestAck,
    coordinationId: BrowserCoordinationContractId,
    requestId,
  };
}

/** A decimal term is a wire value, not a JavaScript number: no signs, exponents, or leading zeroes. */
export function isCanonicalFence(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

/** Compare two validated decimal terms without losing precision to Number. */
export function compareFence(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isControlMessage(value: unknown): value is ControlMessage {
  if (!hasCurrentCoordinationId(value)) return false;
  return controlValidators.get(value.op as ControlOpCode)?.(value) ?? false;
}

export function isPeerMessage(value: unknown): value is PeerMessage {
  if (!hasCurrentCoordinationId(value)) return false;
  return peerValidators.get(value.op as PeerOpCode)?.(value) ?? false;
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  return (
    isRecord(value) &&
    typeof value.moduleGraphHash === "string" &&
    typeof value.packageVersion === "string" &&
    typeof value.contractId === "string" &&
    typeof value.schemaHash === "string" &&
    typeof value.storageId === "string" &&
    typeof value.storeFormatVersion === "number" &&
    typeof value.storageBindingId === "string"
  );
}

/** Frames from another bundle must never reach a handler: reload before rejoining the channel. */
export function hasCurrentCoordinationId(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.coordinationId === "string" &&
    value.coordinationId === BrowserCoordinationContractId
  );
}

/**
 * Identifies a frame that cannot safely be interpreted on a private coordination channel.
 *
 * A future bundle may introduce a new numeric operation before this bundle knows its enum member.
 * Those channels carry coordination frames only, so any numeric `op` without this exact contract
 * is fail-closed. Messages without an operation remain unrelated noise and are ignored.
 */
export function isForeignCoordinationFrame(value: unknown): boolean {
  return isRecord(value) && typeof value.op === "number" && !hasCurrentCoordinationId(value);
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.op === "number" &&
    workerCommands.has(value.op)
  );
}

function isRemoteInit(value: unknown): value is NonNullable<InitRequest["remote"]> {
  return (
    isRecord(value) &&
    typeof value.authFetchToken === "boolean" &&
    typeof value.moduleGraphHash === "string" &&
    (value.operationTimeoutMs === undefined || typeof value.operationTimeoutMs === "number") &&
    (value.receiveTimeoutMs === undefined || typeof value.receiveTimeoutMs === "number") &&
    typeof value.contractId === "string" &&
    typeof value.schemaHash === "string" &&
    typeof value.url === "string"
  );
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return isRecord(value) && typeof value.op === "number" && workerEvents.has(value.op);
}

function isSerializedError(value: unknown): value is SerializedError {
  return isRecord(value) && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safe(value: string): string {
  return value.replace(/[^0-9A-Z_a-z.-]/g, "_");
}

const workerCommands = new Set<number>(Object.values(WorkerCommand));
const workerEvents = new Set<number>(Object.values(WorkerEvent));
