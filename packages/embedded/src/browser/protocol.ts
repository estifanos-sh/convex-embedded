/**
 * Minimal worker shape used by the browser embedded runtime.
 *
 * @internal
 */
export type EmbeddedWorker = {
  addEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
  addEventListener(type: "error" | "messageerror", callback: (event: unknown) => void): void;
  close?(): void;
  postMessage(message: unknown, transfer?: object[]): void;
  removeEventListener(type: "message", callback: (event: { data: unknown }) => void): void;
  removeEventListener(type: "error" | "messageerror", callback: (event: unknown) => void): void;
  start?(): void;
  terminate?(): void;
};

/**
 * Browser worker source used by internal tests.
 *
 * @internal
 */
export type EmbeddedWorkerSource = EmbeddedWorker | (() => EmbeddedWorker);

/**
 * Runtime identity shared by browser clients and the elected browser runtime leader.
 *
 * @internal
 */
export interface RuntimeIdentity {
  moduleGraphHash: string;
  packageVersion: string;
  protocolVersion: number;
  schemaHash: string;
  storageId: string;
  wasmAbiVersion: number;
}

export const WorkerCommand = {
  Init: 1,
  Query: 2,
  Mutation: 3,
  WatchStart: 4,
  WatchStop: 5,
  Close: 6,
  Heartbeat: 7,
} as const;

export type WorkerCommandCode = (typeof WorkerCommand)[keyof typeof WorkerCommand];

export const WorkerEvent = {
  Result: 1,
  MutationAccepted: 2,
  WatchUpdated: 3,
  WatchFailed: 4,
  Debug: 5,
} as const;

export type WorkerEventCode = (typeof WorkerEvent)[keyof typeof WorkerEvent];

export const PortCommand = {
  Connect: 1,
} as const;

export type WorkerRequest =
  | {
      clientId?: string;
      debug?: boolean;
      id: number;
      identity?: RuntimeIdentity;
      op: typeof WorkerCommand.Init;
      storagePath: string;
    }
  | {
      args: Record<string, unknown>;
      clientId?: string;
      id: number;
      name: string;
      op: typeof WorkerCommand.Query;
    }
  | {
      args: Record<string, unknown>;
      clientId?: string;
      id: number;
      /**
       * Durable idempotency key, baked into the request when it is first constructed so ledger
       * replays after a leader change reuse the same key and the store dedups across epochs.
       */
      mutationId: string;
      name: string;
      op: typeof WorkerCommand.Mutation;
    }
  | {
      args: Record<string, unknown>;
      clientId?: string;
      id: number;
      name: string;
      op: typeof WorkerCommand.WatchStart;
      watchId: number;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.WatchStop;
      watchId: number;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.Close;
    }
  | {
      clientId: string;
      id: number;
      op: typeof WorkerCommand.Heartbeat;
    };

export type WorkerPortRequest = {
  op: typeof PortCommand.Connect;
  port: EmbeddedWorker;
};

export type WorkerResponse =
  | {
      error?: SerializedError;
      id: number;
      op: typeof WorkerEvent.Result;
      result?: unknown;
    }
  | {
      id: number;
      mutationId: string;
      op: typeof WorkerEvent.MutationAccepted;
    }
  | {
      op: typeof WorkerEvent.WatchUpdated;
      value: unknown;
      watchId: number;
    }
  | {
      error: SerializedError;
      op: typeof WorkerEvent.WatchFailed;
      watchId: number;
    }
  | {
      detail?: unknown;
      op: typeof WorkerEvent.Debug;
      phase: string;
    };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export function deserializeError(error: SerializedError): Error {
  const out = new Error(error.message);
  out.name = error.name ?? "Error";
  out.stack = error.stack;
  return out;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
