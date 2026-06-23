import type { EmbeddedConflictEvent, EmbeddedInternalEvent } from "./events";
import type { Runner } from "./runtime/runner";
import type { RemoteReroot, RemoteTick } from "./storage/types";
import { getTimerTime } from "./time";

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
    tick.pushAccepted > 0 ||
    tick.pushAttempted > 0 ||
    tick.pushRebases > 0 ||
    tick.received > 0 ||
    tick.reconnected ||
    tick.pushed > 0 ||
    tick.changedResults.length > 0 ||
    tick.retainedRevisions.length > 0
  );
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
