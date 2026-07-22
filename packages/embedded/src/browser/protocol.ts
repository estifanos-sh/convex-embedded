import { ConvexError } from "convex/values";

import { decodeError, encodeError } from "../runtime/codec";
import type { RunnerDevtoolsRequest, RunMutationTiming } from "../runtime/runner";
import type { EmbeddedEvent } from "../events";

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
  storeFormatVersion: number;
  wasmAbiVersion: number;
}

export const WorkerCommand = {
  Init: 1,
  Query: 2,
  Mutation: 3,
  WatchStart: 4,
  WatchStop: 5,
  Close: 6,
  Upload: 9,
  Devtools: 10,
  AuthTokenResult: 11,
  Route: 12,
  IdentityRead: 13,
  IdentityWrite: 14,
  RemoteIdentityRead: 15,
  RemoteNetworkWrite: 16,
  StorageOwnerWrite: 17,
} as const;

export type WorkerCommandCode = (typeof WorkerCommand)[keyof typeof WorkerCommand];

export const WorkerEvent = {
  Result: 1,
  MutationAccepted: 2,
  WatchUpdated: 3,
  WatchFailed: 4,
  Debug: 5,
  Event: 6,
  AuthTokenRequest: 7,
  WatchPatched: 8,
  /** The worker-owned store is terminal; the page must dispose its runner and storage lease. */
  Terminal: 9,
} as const;

export type WorkerRequest =
  | {
      clientId?: string;
      debug?: boolean;
      id: number;
      identity?: RuntimeIdentity;
      op: typeof WorkerCommand.Init;
      remote?: {
        authFetchToken: boolean;
        clientId?: string;
        compatiblePriorRuntimes?: readonly import("../storage/types").RemoteRuntimeIdentity[];
        moduleGraphHash: string;
        operationTimeoutMs?: number;
        protocolVersion: number;
        receiveTimeoutMs?: number;
        schemaHash: string;
        url: string;
      };
      storagePath: string;
      storageOwner?: boolean;
    }
  | {
      authRequestId: number;
      clientId?: string;
      error?: SerializedError;
      id: number;
      op: typeof WorkerCommand.AuthTokenResult;
      token?: string | null;
    }
  | {
      args: Record<string, unknown>;
      auth?: unknown;
      clientId?: string;
      id: number;
      name: string;
      op: typeof WorkerCommand.Query;
    }
  | {
      args: Record<string, unknown>;
      auth?: unknown;
      clientId?: string;
      id: number;
      /**
       * Durable idempotency key, baked into the request when it is first constructed so ledger
       * replays after a leader change reuse the same key and the store dedups across epochs.
       */
      mutationId: string;
      mutationIsFresh?: boolean;
      name: string;
      op: typeof WorkerCommand.Mutation;
      /** Stable random source for deterministic hosted replay across leader changes. */
      rngSeed: string;
    }
  | {
      args: Record<string, unknown>;
      clientId?: string;
      id: number;
      kind: "query" | "mutation" | "action";
      name: string;
      op: typeof WorkerCommand.Route;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.IdentityRead;
    }
  | {
      clientId?: string;
      id: number;
      identityKey: string;
      op: typeof WorkerCommand.IdentityWrite;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.RemoteIdentityRead;
    }
  | {
      clientId?: string;
      id: number;
      online: boolean;
      op: typeof WorkerCommand.RemoteNetworkWrite;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.StorageOwnerWrite;
    }
  | {
      bytes: Uint8Array;
      clientId?: string;
      contentType?: string;
      id: number;
      op: typeof WorkerCommand.Upload;
      url: string;
    }
  | {
      clientId?: string;
      id: number;
      op: typeof WorkerCommand.Devtools;
      request: RunnerDevtoolsRequest;
    }
  | {
      args: Record<string, unknown>;
      auth?: unknown;
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
    };

export type WorkerResponse =
  | {
      error?: SerializedError;
      id: number;
      op: typeof WorkerEvent.Result;
      result?: unknown;
      timing?: RunMutationTiming;
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
      op: typeof WorkerEvent.WatchPatched;
      patch: WatchPatch;
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
    }
  | {
      event: EmbeddedEvent;
      op: typeof WorkerEvent.Event;
    }
  | {
      authRequestId: number;
      forceRefreshToken: boolean;
      op: typeof WorkerEvent.AuthTokenRequest;
    }
  | {
      error: SerializedError;
      op: typeof WorkerEvent.Terminal;
    };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  convex?: string;
}

export type WatchPatch = {
  changes: Array<{ index: number; value: unknown }>;
  kind: "arrayRows";
  length: number;
};

export function deserializeError(error: SerializedError): Error {
  if (error.convex !== undefined) {
    const out = decodeError(error.convex);
    if (error.stack !== undefined) out.stack = error.stack;
    return out;
  }
  const out = new Error(error.message);
  out.name = error.name ?? "Error";
  out.stack = error.stack;
  return out;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ConvexError) {
    return {
      convex: encodeError(error),
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
