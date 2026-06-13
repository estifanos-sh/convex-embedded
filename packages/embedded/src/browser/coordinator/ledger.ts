import { deferred, type Deferred } from "../../util";
import { WorkerCommand, WorkerEvent, type WorkerRequest, type WorkerResponse } from "../protocol";
import { serializeErrorLike } from "./state";
import type { Timer } from "./protocol";

export const MAX_LEDGER_REQUESTS = 1_000;
export const MAX_DESIRED_WATCHES = 1_000;

export type WatchStartRequest = Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStart }>;

export interface LedgerEntry {
  accepted: boolean;
  acknowledged: boolean;
  request: WorkerRequest;
  sent: boolean;
}

interface StoredEntry extends LedgerEntry {
  ackTimer?: Timer;
  settled: Deferred<void>;
}

export interface RequestLedgerOptions {
  clearTimer(timer: Timer): void;
  post(response: WorkerResponse): void;
  setTimer(callback: () => void, ms: number): Timer;
}

export class RequestLedger {
  private readonly desired = new Map<number, WatchStartRequest>();
  private readonly entries = new Map<number, StoredEntry>();

  constructor(private readonly options: RequestLedgerOptions) {}

  record(request: WorkerRequest): LedgerEntry | undefined {
    if (request.op === WorkerCommand.Heartbeat) return undefined;
    // Validate both ceilings BEFORE mutating any state, so a thrown limit error never strands a
    // half-recorded desired watch (which would otherwise replay forever).
    if (
      request.op === WorkerCommand.WatchStart &&
      !this.desired.has(request.watchId) &&
      this.desired.size >= MAX_DESIRED_WATCHES
    ) {
      throw new Error(`ConvexEmbeddedClient has too many active watches (${MAX_DESIRED_WATCHES}).`);
    }
    if (!this.entries.has(request.id) && this.entries.size >= MAX_LEDGER_REQUESTS) {
      throw new Error(
        `ConvexEmbeddedClient queued too many requests while the browser runtime is changing owners (${MAX_LEDGER_REQUESTS}).`,
      );
    }
    if (request.op === WorkerCommand.WatchStart) {
      this.desired.set(request.watchId, request);
    }
    if (request.op === WorkerCommand.WatchStop) {
      this.desired.delete(request.watchId);
      this.cancelPendingWatchStart(request.watchId);
    }
    const entry = this.ensureEntry(request);
    return publicEntry(entry);
  }

  markSent(requestId: number): void {
    const entry = this.entries.get(requestId);
    if (entry) entry.sent = true;
  }

  acknowledge(requestId: number): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.acknowledged = true;
    this.clearAckTimer(entry);
  }

  settle(response: WorkerResponse): void {
    if (response.op === WorkerEvent.MutationAccepted) {
      const entry = this.entries.get(response.id);
      if (!entry) return;
      entry.accepted = true;
      this.acknowledge(response.id);
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
      if (!current?.ackTimer) return;
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

  replayableRequests(): WorkerRequest[] {
    const requests: WorkerRequest[] = [...this.desired.values()];
    for (const entry of this.entries.values()) {
      const request = entry.request;
      if (request.op === WorkerCommand.WatchStart && this.desired.has(request.watchId)) continue;
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
        error: serializeErrorLike(settleError),
        id: entry.request.id,
        op: WorkerEvent.Result,
      });
      entry.settled.reject(settleError);
    }
    this.entries.clear();
    for (const request of this.desired.values()) {
      this.options.post({
        error: serializeErrorLike(error),
        op: WorkerEvent.WatchFailed,
        watchId: request.watchId,
      });
    }
    this.desired.clear();
  }

  onSettled(requestId: number): Promise<void> {
    return this.entries.get(requestId)?.settled.promise ?? Promise.resolve();
  }

  private ensureEntry(request: WorkerRequest): StoredEntry {
    const existing = this.entries.get(request.id);
    if (existing) return existing;
    const entry: StoredEntry = {
      accepted: false,
      acknowledged: false,
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
    if (!entry.ackTimer) return;
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

function publicEntry(entry: StoredEntry): LedgerEntry {
  return {
    accepted: entry.accepted,
    acknowledged: entry.acknowledged,
    request: entry.request,
    sent: entry.sent,
  };
}
