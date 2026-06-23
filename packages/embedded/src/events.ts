/**
 * Typed local observability events emitted by embedded clients.
 *
 * @packageDocumentation
 */

/** Function or runtime operation reported by the embedded client. @public */
export type EmbeddedOperationKind = "query" | "mutation" | "action" | "upload" | "devtools";

/** Lifecycle state for operation events. @public */
export type EmbeddedOperationPhase = "start" | "finish";

/** Logical tracing lifecycle state. @public */
export type EmbeddedSpanPhase = "start" | "finish";

/** Per-mutation phase timings reported by local runtime diagnostics. @public */
export interface EmbeddedMutationTiming {
  argsEncodeMs: number;
  batchMs: number;
  beginMs: number;
  commitMs: number;
  handlerMs: number;
  mutationId: boolean;
  notifyMs: number;
  prepareMs: number;
  resultEncodeMs: number;
  totalMs: number;
}

/** Browser/native remote replication lifecycle state. @public */
export type EmbeddedRemoteStatus = "starting" | "started" | "tick" | "idle" | "error" | "closed";

/**
 * Boot-lifecycle transition an embedded runtime moves through while opening its local store.
 *
 * @public
 */
export type EmbeddedRuntimePhase =
  | "opfs-register"
  | "wasm-load"
  | "store-open"
  | "store-setup"
  | "store-checkpoint"
  | "remote-attach"
  | "ready";

/**
 * Degradation an app can observe while an embedded runtime boots or runs: a deployment mismatch, an
 * exhausted client rotation, OPFS handle-acquire contention, a store open slow past the notice
 * threshold, or a boot failure.
 *
 * @public
 */
export type EmbeddedRuntimeDegradation =
  | "deployment-mismatch"
  | "retired"
  | "opfs-acquire-retry"
  | "opfs-acquire-reclaimed"
  | "slow-open"
  | "corrupt"
  | "failed";

/** Row inserted or replaced by a local storage commit. @public */
export interface EmbeddedDataUpsert {
  id: string;
  row: Record<string, unknown>;
  table: string;
}

/** Row deleted by a local storage commit. @public */
export interface EmbeddedDataDelete {
  id: string;
  table: string;
}

/** Local function/upload operation event. @public */
export interface EmbeddedOperationEvent {
  args?: unknown;
  at: number;
  durationMs?: number;
  error?: string;
  id: number;
  kind: EmbeddedOperationKind;
  name: string;
  phase: EmbeddedOperationPhase;
  result?: unknown;
  resultSize?: number;
  status: "pending" | "success" | "error";
  timing?: EmbeddedMutationTiming;
  type: "operation";
}

/** Logical span event for cross-runtime tracing. @public */
export interface EmbeddedSpanEvent {
  at: number;
  durationMs?: number;
  error?: string;
  id: string;
  name: string;
  phase: EmbeddedSpanPhase;
  type: "span";
}

/** Local document/system-table row changes. @public */
export interface EmbeddedDataEvent {
  at: number;
  changedTables: string[];
  commitSeq?: number;
  deletes: EmbeddedDataDelete[];
  /** `"cache"` marks a value a retained-result cache-serve produced (Cut 7 §7); internal channel only. */
  source?: "local" | "remote" | "cache";
  type: "data";
  upserts: EmbeddedDataUpsert[];
}

/** Local file/upload/id-map changes. @public */
export interface EmbeddedStorageEvent {
  at: number;
  deletes: EmbeddedDataDelete[];
  type: "storage";
  upserts: EmbeddedDataUpsert[];
}

/** Remote replication status and error event. @public */
export interface EmbeddedRemoteEvent {
  at: number;
  attempt: number;
  durationMs?: number;
  error?: string;
  /** Foreground remote-actor contention for a replay push, when this event reports one. */
  foreground?: {
    actorQueueDepth: number;
    actorQueueMs: number;
  };
  nextRunAt?: number;
  status: EmbeddedRemoteStatus;
  tick?: {
    changedTables: string[];
    rowsApplied: number;
    pullAttempted: number;
    pushAccepted: number;
    pushAttempted: number;
    pushConflicts: number;
    pushRebases: number;
    received: number;
    reconnected: boolean;
    pushed: number;
    pushFailed: number;
    retainedRevisions: number;
    sent: number;
    settlementsAcknowledged: number;
    storeJobs: number;
  };
  type: "remote";
  wasmApiVersion?: number;
}

/**
 * Boot-lifecycle and degradation signal an embedded runtime surfaces while opening its local store.
 *
 * @remarks
 * A `phase` transition marks progress (store open, remote attach, ready); a `degradation` marks a
 * slow open or OPFS handle-acquire contention that an app can render instead of a dead spinner.
 * These are pure observability: they never change boot behavior.
 *
 * @public
 */
export interface EmbeddedRuntimeEvent {
  at: number;
  /** OPFS acquire attempt index for retry/reclaim degradation. */
  attempt?: number;
  /** Failure or degradation cause message when known. */
  error?: string;
  degradation?: EmbeddedRuntimeDegradation;
  phase?: EmbeddedRuntimePhase;
  type: "runtime";
  /** Elapsed store open/replay time, present on the slow-open notice. */
  waitedMs?: number;
}

/** A local after-image retained as a restorable revision. @public */
export interface EmbeddedConflict {
  id: string;
  revId: string;
  table: string;
}

/**
 * An authoritative result displaced a local after-image, which was retained rather than lost.
 * Apps inspect the revision through their normal authorized Convex history functions. @public
 */
export interface EmbeddedConflictEvent {
  at: number;
  conflicts: EmbeddedConflict[];
  type: "conflict";
}

/** Local scheduler row changes. @public */
export interface EmbeddedSchedulerEvent {
  at: number;
  deletes: EmbeddedDataDelete[];
  type: "scheduler";
  upserts: EmbeddedDataUpsert[];
}

/**
 * Any rich internal observability event.
 *
 * @remarks
 * These carry benchmark timings, spans, and per-tick replication detail. They feed devtools and the
 * internal channel; the public {@link EmbeddedPublicEvent} stream is a lean projection of this union.
 *
 * @internal
 */
export type EmbeddedEvent =
  | EmbeddedConflictEvent
  | EmbeddedDataEvent
  | EmbeddedOperationEvent
  | EmbeddedRemoteEvent
  | EmbeddedRuntimeEvent
  | EmbeddedSchedulerEvent
  | EmbeddedSpanEvent
  | EmbeddedStorageEvent;

/** Rich internal observability event; alias of {@link EmbeddedEvent}. @internal */
export type EmbeddedInternalEvent = EmbeddedEvent;

/** Listener over the rich internal event channel. @internal */
export type EmbeddedEventListener = (event: EmbeddedEvent) => void;

/** Listener over the rich internal event channel; alias of {@link EmbeddedEventListener}. @internal */
export type EmbeddedInternalEventListener = EmbeddedEventListener;

/**
 * The public embedded observability event stream: a stable discriminated union with core fields.
 *
 * @remarks
 * This is the exact V5 contract surface produced by {@link import("./client").EmbeddedClient.subscribeEvents}.
 * Richer internal shapes reach devtools through the internal channel; they are not app contracts.
 *
 * @public
 */
export type EmbeddedPublicEvent =
  | {
      type: "runtime";
      at: number;
      phase: "starting" | "store-open" | "schema-ready" | "ready" | "degraded" | "closed";
      error?: string;
    }
  | {
      type: "operation";
      at: number;
      operationId: string;
      functionName: string;
      kind: "query" | "mutation" | "action";
      phase:
        | "local-start"
        | "local-commit"
        | "remote-pending"
        | "rebase"
        | "applied"
        | "conflict"
        | "rejected"
        | "error";
      revisionIds?: string[];
      error?: string;
    }
  | {
      type: "remote";
      at: number;
      status: "starting" | "ready" | "idle" | "offline" | "error" | "closed";
      attempt: number;
      nextRunAt?: number;
      error?: string;
    }
  | {
      type: "data";
      at: number;
      source: "local" | "remote" | "restore" | "migration";
      tables: string[];
    }
  | {
      type: "crdt";
      at: number;
      table: string;
      rowId: string;
      field: string;
      state: "pending" | "rebased" | "checkpoint-requested" | "checkpoint-ready" | "corrupt";
    }
  | {
      type: "upload";
      at: number;
      uploadId: string;
      state: "local" | "uploading" | "hosted" | "failed";
      error?: string;
    }
  | {
      type: "schedule";
      at: number;
      scheduleId: string;
      state: "pending" | "hosted" | "running" | "complete" | "failed" | "cancelled";
    }
  | {
      type: "retention";
      at: number;
      target: "crdt" | "revision" | "file" | "mutation" | "client";
      processed: number;
      isDone: boolean;
    };

/** Listener registered with {@link import("./client").EmbeddedClient.subscribeEvents}. @public */
export type EmbeddedPublicEventListener = (event: EmbeddedPublicEvent) => void;

function mapRuntimeEvent(event: EmbeddedRuntimeEvent): EmbeddedPublicEvent {
  if (event.degradation === "corrupt") {
    return { type: "crdt", at: event.at, table: "", rowId: "", field: "", state: "corrupt" };
  }
  const phase: (EmbeddedPublicEvent & { type: "runtime" })["phase"] = event.degradation
    ? "degraded"
    : event.phase === "store-open"
      ? "store-open"
      : event.phase === "store-setup" ||
          event.phase === "store-checkpoint" ||
          event.phase === "remote-attach"
        ? "schema-ready"
        : event.phase === "ready"
          ? "ready"
          : "starting";
  return { type: "runtime", at: event.at, phase, ...(event.error ? { error: event.error } : {}) };
}

function mapRemoteEvent(event: EmbeddedRemoteEvent): EmbeddedPublicEvent {
  const status: (EmbeddedPublicEvent & { type: "remote" })["status"] =
    event.status === "started" || event.status === "tick"
      ? "ready"
      : event.status === "starting"
        ? "starting"
        : event.status === "idle"
          ? "idle"
          : event.status === "closed"
            ? "closed"
            : "error";
  return {
    type: "remote",
    at: event.at,
    status,
    attempt: event.attempt,
    ...(event.nextRunAt === undefined ? {} : { nextRunAt: event.nextRunAt }),
    ...(event.error ? { error: event.error } : {}),
  };
}

function mapOperationEvent(event: EmbeddedOperationEvent): EmbeddedPublicEvent | null {
  if (event.kind !== "query" && event.kind !== "mutation" && event.kind !== "action") return null;
  const phase: (EmbeddedPublicEvent & { type: "operation" })["phase"] =
    event.phase === "start" ? "local-start" : event.status === "error" ? "error" : "local-commit";
  return {
    type: "operation",
    at: event.at,
    operationId: String(event.id),
    functionName: event.name,
    kind: event.kind,
    phase,
    ...(event.error ? { error: event.error } : {}),
  };
}

/**
 * Projects one rich internal event to its public {@link EmbeddedPublicEvent}, or `null` when the event is
 * internal-only (spans, storage/scheduler row deltas, retained-conflict bookkeeping).
 *
 * @remarks
 * This is the single boundary between the internal channel and the public stream. It never widens the
 * public union: an internal shape with no stable public meaning maps to `null`.
 *
 * @internal
 */
export function mapPublicEvent(event: EmbeddedEvent): EmbeddedPublicEvent | null {
  switch (event.type) {
    case "runtime":
      return mapRuntimeEvent(event);
    case "remote":
      return mapRemoteEvent(event);
    case "operation":
      return mapOperationEvent(event);
    case "data":
      return {
        type: "data",
        at: event.at,
        // The public V5 union carries no "cache" source; a cache-serve is the app's local optimistic
        // value, so it projects to "local". The "cache" distinction stays on the internal channel.
        source: event.source === undefined || event.source === "cache" ? "local" : event.source,
        tables: event.changedTables,
      };
    default:
      return null;
  }
}
