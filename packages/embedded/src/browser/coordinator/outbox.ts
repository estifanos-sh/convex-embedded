import { deferred, type Deferred } from "../../promise";
import {
  serializeError,
  WorkerCommand,
  WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol";
import type { Timer } from "./protocol";

export type WatchStartRequest = Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStart }>;

interface StoredEntry {
  accepted: boolean;
  ackTimer?: Timer;
  confirmed: boolean;
  request: WorkerRequest;
  sent: boolean;
  settled: Deferred<void>;
}

export interface RequestOutboxOptions {
  clearTimer(timer: Timer): void;
  post(response: WorkerResponse): void;
  setTimer(callback: () => void, ms: number): Timer;
}

export class RequestOutbox {
  private readonly desired = new Map<number, WatchStartRequest>();
  private readonly entries = new Map<number, StoredEntry>();

  constructor(private readonly options: RequestOutboxOptions) {}

  record(request: WorkerRequest): void {
    if (request.op === WorkerCommand.WatchStart) {
      this.desired.set(request.watchId, request);
    }
    if (request.op === WorkerCommand.WatchStop) {
      this.desired.delete(request.watchId);
      this.cancelPendingWatchStart(request.watchId);
    }
    this.ensureEntry(request);
  }

  markSent(requestId: number): void {
    const entry = this.entries.get(requestId);
    if (entry) entry.sent = true;
  }

  confirm(requestId: number): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.confirmed = true;
    this.clearAckTimer(entry);
  }

  complete(response: WorkerResponse): void {
    if (response.op === WorkerEvent.MutationAccepted) {
      const entry = this.entries.get(response.id);
      if (!entry) return;
      entry.accepted = true;
      this.confirm(response.id);
      return;
    }
    if (response.op !== WorkerEvent.Result) return;
    const entry = this.entries.get(response.id);
    if (!entry) return;
    this.clearAckTimer(entry);
    this.entries.delete(response.id);
    entry.settled.resolve();
  }

  armAckTimer(requestId: number, ms: number, onTimeout: () => void): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    this.clearAckTimer(entry);
    entry.ackTimer = this.options.setTimer(() => {
      const current = this.entries.get(requestId);
      if (current?.ackTimer === undefined) return;
      current.ackTimer = undefined;
      onTimeout();
    }, ms);
  }

  clearAllAckTimers(): void {
    for (const entry of this.entries.values()) this.clearAckTimer(entry);
  }

  desiredWatches(): WatchStartRequest[] {
    return [...this.desired.values()];
  }

  ownershipRequests(): WorkerRequest[] {
    const requests: WorkerRequest[] = [...this.desired.values()];
    for (const [requestId, entry] of this.entries) {
      const request = entry.request;
      if (request.op === WorkerCommand.WatchStart && this.desired.has(request.watchId)) continue;
      if (entry.sent && !isOwnershipReplaySafe(request)) {
        const error = indeterminateOperationError(request);
        this.clearAckTimer(entry);
        this.entries.delete(requestId);
        this.options.post({
          error: serializeError(error),
          id: request.id,
          op: WorkerEvent.Result,
        });
        entry.settled.reject(error);
        continue;
      }
      requests.push(request);
    }
    return requests;
  }

  rejectAll(error: unknown): void {
    this.clearAllAckTimers();
    for (const entry of this.entries.values()) {
      // An accepted-but-unsettled mutation may have committed durably during a runtime ownership
      // change; surface it as indeterminate (matching proxy.dispose) rather than a clean failure,
      // so the client does not treat a possibly-committed mutation as rejected.
      const settleError =
        entry.accepted && entry.request.op === WorkerCommand.Mutation
          ? indeterminateMutationError()
          : error;
      this.options.post({
        error: serializeError(settleError),
        id: entry.request.id,
        op: WorkerEvent.Result,
      });
      entry.settled.reject(settleError);
    }
    this.entries.clear();
    for (const request of this.desired.values()) {
      this.options.post({
        error: serializeError(error),
        op: WorkerEvent.WatchFailed,
        watchId: request.watchId,
      });
    }
    this.desired.clear();
  }

  private ensureEntry(request: WorkerRequest): StoredEntry {
    const existing = this.entries.get(request.id);
    if (existing) return existing;
    const entry: StoredEntry = {
      accepted: false,
      confirmed: false,
      request,
      sent: false,
      settled: deferred(),
    };
    entry.settled.promise.catch(() => undefined);
    this.entries.set(request.id, entry);
    return entry;
  }

  private cancelPendingWatchStart(watchId: number): void {
    for (const [requestId, entry] of this.entries) {
      if (entry.request.op !== WorkerCommand.WatchStart || entry.request.watchId !== watchId) {
        continue;
      }
      this.clearAckTimer(entry);
      this.entries.delete(requestId);
      this.options.post({ id: entry.request.id, op: WorkerEvent.Result });
      entry.settled.resolve();
    }
  }

  private clearAckTimer(entry: StoredEntry): void {
    if (entry.ackTimer === undefined) return;
    this.options.clearTimer(entry.ackTimer);
    entry.ackTimer = undefined;
  }
}

/** An indeterminate-mutation error whose `name` matches proxy.ts `IndeterminateMutationError`. */
function indeterminateMutationError(): Error {
  const error = new Error(
    "The mutation was accepted but its result was lost during a runtime ownership change.",
  );
  error.name = "ConvexEmbeddedMutationIndeterminateError";
  return error;
}

function indeterminateOperationError(request: WorkerRequest): Error {
  const operation =
    request.op === WorkerCommand.Route ? `hosted ${request.kind}` : "browser operation";
  const error = new Error(
    `The ${operation} may have completed before browser runtime ownership changed; Embedded will not execute it again.`,
  );
  error.name = "ConvexEmbeddedOperationIndeterminateError";
  return error;
}

function isOwnershipReplaySafe(request: WorkerRequest): boolean {
  switch (request.op) {
    case WorkerCommand.Query:
    case WorkerCommand.Action:
    case WorkerCommand.Mutation:
    case WorkerCommand.WatchStart:
    case WorkerCommand.WatchStop:
    case WorkerCommand.Close:
    case WorkerCommand.IdentityRead:
    case WorkerCommand.IdentityWrite:
    case WorkerCommand.RemoteIdentityRead:
    case WorkerCommand.RemoteNetworkWrite:
      return true;
    case WorkerCommand.Route:
      return request.kind === "query";
    case WorkerCommand.Init:
    case WorkerCommand.Upload:
    case WorkerCommand.Devtools:
    case WorkerCommand.AuthTokenResult:
    case WorkerCommand.StorageOwnerWrite:
      return false;
  }
}
