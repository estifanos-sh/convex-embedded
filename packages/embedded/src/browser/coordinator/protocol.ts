import {
  WorkerCommand,
  WorkerEvent,
  type RuntimeIdentity,
  type SerializedError,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol";

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
export const CoordinatorProtocol = 2;

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
      protocol: typeof CoordinatorProtocol;
      scope: string;
      storagePath: string;
      workerId: string;
    }
  | {
      identity: RuntimeIdentity;
      leaderEpoch: string;
      leaderId: string;
      op: typeof ControlOp.BroadcastLeader;
      protocol: typeof CoordinatorProtocol;
      scope: string;
    };

export type PeerMessage =
  | {
      clientId: string;
      identity: RuntimeIdentity;
      op: typeof PeerOp.Attach;
      protocol: typeof CoordinatorProtocol;
      remote?: InitRequest["remote"];
      scope: string;
      storagePath: string;
      workerId: string;
    }
  | {
      fromWorkerId: string;
      leaderEpoch: string;
      op: typeof PeerOp.Request;
      protocol: typeof CoordinatorProtocol;
      request: WorkerRequest;
    }
  | {
      leaderEpoch: string;
      op: typeof PeerOp.RequestAck;
      protocol: typeof CoordinatorProtocol;
      requestId: number;
    }
  | {
      leaderEpoch: string;
      leaderId: string;
      op: typeof PeerOp.Attached;
      protocol: typeof CoordinatorProtocol;
    }
  | {
      code: RejectCodeValue;
      error: SerializedError;
      leaderEpoch: string;
      op: typeof PeerOp.Rejected;
      protocol: typeof CoordinatorProtocol;
    }
  | {
      leaderEpoch: string;
      op: typeof PeerOp.Response;
      protocol: typeof CoordinatorProtocol;
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
      isWorkerRequest(value.request),
  ],
  [
    PeerOp.RequestAck,
    (value) => typeof value.leaderEpoch === "string" && typeof value.requestId === "number",
  ],
  [
    PeerOp.Attached,
    (value) => typeof value.leaderEpoch === "string" && typeof value.leaderId === "string",
  ],
  [
    PeerOp.Rejected,
    (value) =>
      typeof value.code === "number" &&
      typeof value.leaderEpoch === "string" &&
      isSerializedError(value.error),
  ],
  [
    PeerOp.Response,
    (value) => typeof value.leaderEpoch === "string" && isWorkerResponse(value.response),
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
  requestId: number,
): Extract<PeerMessage, { op: typeof PeerOp.RequestAck }> {
  return {
    leaderEpoch,
    op: PeerOp.RequestAck,
    protocol: CoordinatorProtocol,
    requestId,
  };
}

export function isControlMessage(value: unknown): value is ControlMessage {
  if (!isRecord(value) || value.protocol !== CoordinatorProtocol) return false;
  return controlValidators.get(value.op as ControlOpCode)?.(value) ?? false;
}

export function isPeerMessage(value: unknown): value is PeerMessage {
  if (!isRecord(value) || value.protocol !== CoordinatorProtocol) return false;
  return peerValidators.get(value.op as PeerOpCode)?.(value) ?? false;
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  return (
    isRecord(value) &&
    typeof value.moduleGraphHash === "string" &&
    typeof value.packageVersion === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.schemaHash === "string" &&
    typeof value.storageId === "string" &&
    typeof value.storeFormatVersion === "number" &&
    typeof value.wasmAbiVersion === "number"
  );
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
    (value.compatiblePriorRuntimes === undefined ||
      (Array.isArray(value.compatiblePriorRuntimes) &&
        value.compatiblePriorRuntimes.every(isRemoteRuntimeIdentity))) &&
    typeof value.moduleGraphHash === "string" &&
    (value.operationTimeoutMs === undefined || typeof value.operationTimeoutMs === "number") &&
    (value.receiveTimeoutMs === undefined || typeof value.receiveTimeoutMs === "number") &&
    typeof value.protocolVersion === "number" &&
    typeof value.schemaHash === "string" &&
    typeof value.url === "string"
  );
}

function isRemoteRuntimeIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.moduleGraphHash === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.schemaHash === "string"
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
