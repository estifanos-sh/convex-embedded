import type { EmbeddedConflictEvent, EmbeddedInternalEvent } from "./events";
import type { Runner } from "./runtime/runner";
import type { RemotePending, RemoteReroot, RemoteTick } from "./storage/types";
import { getTimerTime } from "./time";

/** A permanent authoritative result failure blocks convergence until that result changes. */
export const REMOTE_PULL_DIAGNOSTIC_ERROR =
  "Remote pull result could not be applied. Replication is blocked until the authoritative result changes.";

export function consumeRemoteTick(
  tick: RemoteTick,
  runner: Runner,
  emit: (event: EmbeddedInternalEvent) => void,
): void {
  const changedTables = remoteTickTables(tick);
  if (changedTables.length) runner.invalidate(changedTables, "remote");
  // Cut 7 §5: a membership-free result change (scalar/aggregate/transformed) touches no table, so it
  // reruns its table-invisible watch by key — never routed through changedTables.
  if (tick.changedResults.length) runner.rerunResults(tick.changedResults);
  if (tick.retainedRevisions.length) emit(conflictEvent(tick.retainedRevisions));
}

export function remoteTickTables(tick: RemoteTick): string[] {
  return [
    ...new Set([
      ...tick.changedTables,
      ...tick.retainedRevisions.map((revision) => revision.table),
    ]),
  ];
}

export function remoteTickHasWork(tick: RemoteTick): boolean {
  return (
    tick.changedTables.length > 0 ||
    tick.rowsApplied > 0 ||
    tick.pullChangesApplied > 0 ||
    tick.pullSnapshots > 0 ||
    tick.pushAccepted > 0 ||
    tick.pushAttempted > 0 ||
    tick.pushConflicts > 0 ||
    tick.pushRebases > 0 ||
    tick.pushFailed > 0 ||
    tick.received > 0 ||
    tick.reconnected ||
    tick.pushed > 0 ||
    tick.sent > 0 ||
    tick.receiptsPushed > 0 ||
    tick.storeJobs > 0 ||
    tick.pullDiagnostics > 0 ||
    tick.changedResults.length > 0 ||
    tick.retainedRevisions.length > 0
  );
}

/** True only for an authoritative actor snapshot with no durable or in-flight work. */
export function remotePendingIsEmpty(pending: RemotePending | undefined): boolean {
  return (
    pending !== undefined &&
    pending.checkpoints === 0 &&
    pending.inflight === 0 &&
    pending.mutations === 0 &&
    pending.scope === 0 &&
    pending.settlements === 0 &&
    pending.uploads === 0
  );
}

/** Merge progress from serialized push and pull phases; the latter owns the final pending state. */
export function mergeRemoteTicks(first: RemoteTick, last: RemoteTick): RemoteTick {
  return {
    changedResults: [...new Set([...first.changedResults, ...last.changedResults])],
    changedTables: [...new Set([...first.changedTables, ...last.changedTables])],
    pending: last.pending ?? first.pending,
    pullAttempted: first.pullAttempted + last.pullAttempted,
    pullChangesApplied: first.pullChangesApplied + last.pullChangesApplied,
    pullDiagnostics: first.pullDiagnostics + last.pullDiagnostics,
    pullError: first.pullError ?? last.pullError,
    pullSnapshots: first.pullSnapshots + last.pullSnapshots,
    pushAccepted: first.pushAccepted + last.pushAccepted,
    pushAttempted: first.pushAttempted + last.pushAttempted,
    pushConflicts: first.pushConflicts + last.pushConflicts,
    pushFailed: first.pushFailed + last.pushFailed,
    pushRebases: first.pushRebases + last.pushRebases,
    pushed: first.pushed + last.pushed,
    received: first.received + last.received,
    reconnected: first.reconnected || last.reconnected,
    retainedRevisions: [...first.retainedRevisions, ...last.retainedRevisions],
    rowsApplied: first.rowsApplied + last.rowsApplied,
    sent: first.sent + last.sent,
    receiptsPushed: first.receiptsPushed + last.receiptsPushed,
    storeJobs: first.storeJobs + last.storeJobs,
  };
}

function conflictEvent(reroots: RemoteReroot[]): EmbeddedConflictEvent {
  return {
    at: getTimerTime(),
    conflicts: reroots.map((reroot) => ({
      id: reroot.id,
      revId: reroot.revId,
      table: reroot.table,
    })),
    type: "conflict",
  };
}
