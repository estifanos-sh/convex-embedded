/**
 * Framework-agnostic convergence loop for a single embedded text field.
 *
 * @remarks
 * {@link createTextField} generalizes the editor loop the demos hand-rolled. Every write diffs the
 * live local value against the latest desired value and carries the whole-base fingerprint the engine
 * enforces; a stale-base or out-of-range rejection stays pending and retries from a fresh read. The
 * authoritative return value is adopted as the new baseline so the field self-heals toward
 * convergence without ever dropping a pending edit.
 *
 * @packageDocumentation
 */
import { isSpliceRangeError, isStaleTextBaseError } from "../crdt/intent";
import { base, diff } from "./base";

/** Inputs {@link createTextField} needs to persist one text field on the caller's behalf. */
export interface TextFieldOptions<R> {
  /** The live local value of the field, re-read on every write so a diff never uses a stale mirror. */
  read: () => string;
  /** Persist one splice under its whole-base fingerprint; resolves once the write has applied. */
  write: (splice: { index: number; delete: number; insert: string }, base: string) => Promise<R>;
  /** Pull the field's authoritative value out of the write's return, adopted as the next baseline. */
  extract: (result: R) => string;
  /** Trailing debounce before a write, in milliseconds. */
  delayMs?: number;
  /** Longest a pending edit waits before a write is forced, in milliseconds. */
  maxLatencyMs?: number;
}

/** Handle for driving one field's convergence loop. */
export interface TextFieldWriter {
  /** Record the latest desired value and re-arm the write debounce. */
  queue(desired: string): void;
  /** Write any pending edit now instead of waiting for the debounce. */
  flush(): void;
  /** Resolve once the field has converged on the desired value; rejects if a write finally failed. */
  settle(): Promise<void>;
  /** Abandon pending work and detach timers; in-flight writes are ignored once they resolve. */
  close(): void;
  /** Adopt an externally arrived authoritative value as the new baseline, rebasing any pending edit. */
  adopt(authoritative: string): void;
  /** Whether the desired value differs from the last adopted baseline. */
  readonly isDirty: boolean;
  /** Whether a write is in flight or scheduled. */
  readonly isSettling: boolean;
}

const DEFAULT_DELAY_MS = 40;
const DEFAULT_MAX_LATENCY_MS = 160;

export function createTextField<R>(options: TextFieldOptions<R>): TextFieldWriter {
  const read = options.read;
  const runWrite = options.write;
  const extract = options.extract;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;

  let desired = read();
  let baseline = desired;
  let inFlight: Promise<R> | null = null;
  let flushAfterFlight = false;
  let pendingAdopt: string | null = null;
  let errored = false;
  let lastError: Error | undefined;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  function clearTimers(): void {
    if (trailingTimer !== undefined) clearTimeout(trailingTimer);
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    trailingTimer = undefined;
    maxTimer = undefined;
  }

  function schedule(): void {
    if (closed) return;
    if (trailingTimer !== undefined) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(flush, delayMs);
    if (maxTimer === undefined) maxTimer = setTimeout(flush, maxLatencyMs);
  }

  function converged(): boolean {
    return (
      !errored &&
      inFlight === null &&
      trailingTimer === undefined &&
      maxTimer === undefined &&
      !flushAfterFlight &&
      baseline === desired
    );
  }

  function notifySettled(): void {
    if (errored) {
      const failure = lastError ?? new Error("text field write failed");
      for (const waiter of waiters.splice(0)) waiter.reject(failure);
      return;
    }
    if (!converged()) return;
    for (const waiter of waiters.splice(0)) waiter.resolve();
  }

  function settleClean(): void {
    baseline = desired;
    clearTimers();
    notifySettled();
  }

  function settleWrite(authoritative: string): void {
    const adopted = pendingAdopt;
    pendingAdopt = null;
    baseline = adopted ?? authoritative;
  }

  function handleError(error: unknown): void {
    if (isStaleTextBaseError(error) || isSpliceRangeError(error)) return;
    errored = true;
    lastError = error instanceof Error ? error : new Error(String(error));
    notifySettled();
  }

  function beginWrite(): void {
    const before = read();
    const splice = diff(before, desired);
    if (splice === undefined) {
      settleClean();
      return;
    }
    const task: Promise<R> = base(before).then((fingerprint) => runWrite(splice, fingerprint));
    inFlight = task;
    void task
      .then(
        (result) => {
          if (inFlight === task) settleWrite(extract(result));
        },
        (error: unknown) => {
          if (inFlight === task) handleError(error);
        },
      )
      .finally(() => {
        if (inFlight !== task) return;
        inFlight = null;
        if (errored) {
          flushAfterFlight = false;
          return;
        }
        if (desired === baseline) {
          flushAfterFlight = false;
          notifySettled();
          return;
        }
        if (flushAfterFlight) {
          flushAfterFlight = false;
          beginWrite();
        } else {
          schedule();
        }
      });
  }

  function flush(): void {
    if (closed) return;
    clearTimers();
    if (inFlight !== null) {
      flushAfterFlight = true;
      return;
    }
    errored = false;
    lastError = undefined;
    beginWrite();
  }

  function queue(next: string): void {
    if (closed) return;
    desired = next;
    errored = false;
    lastError = undefined;
    schedule();
  }

  function adopt(authoritative: string): void {
    if (closed) return;
    errored = false;
    lastError = undefined;
    if (inFlight !== null) {
      pendingAdopt = authoritative;
      return;
    }
    const hadPendingEdit = desired !== baseline;
    baseline = authoritative;
    if (!hadPendingEdit) {
      desired = authoritative;
      clearTimers();
      notifySettled();
      return;
    }
    if (desired === baseline) {
      clearTimers();
      notifySettled();
      return;
    }
    schedule();
  }

  function settle(): Promise<void> {
    if (errored) return Promise.reject(lastError ?? new Error("text field write failed"));
    if (converged()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiters.push({ resolve: () => resolve(), reject });
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimers();
    inFlight = null;
    flushAfterFlight = false;
    pendingAdopt = null;
    for (const waiter of waiters.splice(0)) waiter.resolve();
  }

  return {
    queue,
    flush,
    settle,
    close,
    adopt,
    get isDirty(): boolean {
      return desired !== baseline;
    },
    get isSettling(): boolean {
      return (
        inFlight !== null ||
        trailingTimer !== undefined ||
        maxTimer !== undefined ||
        flushAfterFlight
      );
    },
  };
}
