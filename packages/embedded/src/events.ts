/**
 * Internal diagnostics emitted by embedded runtimes and consumed by the private devtools bridge.
 *
 * @packageDocumentation
 */

/** Function or runtime operation reported by the embedded client. @internal */
export type EmbeddedOperationKind = "query" | "mutation" | "action" | "upload" | "devtools";

/** Lifecycle state for operation events. @internal */
export type EmbeddedOperationPhase = "start" | "finish";

/** Logical tracing lifecycle state. @internal */
export type EmbeddedSpanPhase = "start" | "finish";

/** Per-mutation phase timings reported by local runtime diagnostics. @internal */
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

/** Browser/native remote replication lifecycle state. @internal */
export type EmbeddedRemoteStatus =
  | "starting"
  | "started"
  | "connected"
  | "tick"
  | "idle"
  | "offline"
  | "error"
  | "closed";

/**
 * Boot-lifecycle transition an embedded runtime moves through while opening its local store.
 *
 * @internal
 */
export type EmbeddedRuntimePhase =
  | "opfs-register"
  | "wasm-load"
  | "store-open"
  | "store-setup"
  | "store-wal-write"
  | "remote-attach"
  | "ready";

/**
 * Degradation an app can observe while an embedded runtime boots or runs: a deployment mismatch, an
 * exhausted client rotation, OPFS handle-acquire contention, a store open slow past the notice
 * threshold, a temporary in-memory storage fallback, or a boot failure.
 *
 * @internal
 */
export type EmbeddedRuntimeDegradation =
  | "deployment-mismatch"
  | "retired"
  | "opfs-acquire-retry"
  | "opfs-acquire-reclaimed"
  | "temporary-storage"
  | "slow-open"
  | "corrupt"
  | "failed";

/** Row inserted or replaced by a local storage commit. @internal */
export interface EmbeddedDataWrite {
  id: string;
  row: Record<string, unknown>;
  table: string;
}

/** Row deleted by a local storage commit. @internal */
export interface EmbeddedDataDelete {
  id: string;
  table: string;
}

/** Local function/upload operation event. @internal */
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

/** Logical span event for cross-runtime tracing. @internal */
export interface EmbeddedSpanEvent {
  at: number;
  durationMs?: number;
  error?: string;
  id: string;
  name: string;
  phase: EmbeddedSpanPhase;
  type: "span";
}

/** Local document/system-table row changes. @internal */
export interface EmbeddedDataEvent {
  at: number;
  changedTables: string[];
  commitSeq?: number;
  deletes: EmbeddedDataDelete[];
  /** `"cache"` marks a value a retained-result cache-serve produced (Cut 7 §7); internal channel only. */
  source?: "local" | "remote" | "cache";
  type: "data";
  docWrites: EmbeddedDataWrite[];
}

/** Local file/upload/id-map changes. @internal */
export interface EmbeddedStorageEvent {
  at: number;
  deletes: EmbeddedDataDelete[];
  type: "storage";
  docWrites: EmbeddedDataWrite[];
}

/** Remote replication status and error event. @internal */
export interface EmbeddedRemoteEvent {
  at: number;
  attempt: number;
  /** Browser leader incarnation; a change resets the per-runtime generation and sequence fence. */
  incarnation?: string;
  /** Remote actor incarnation; higher generations supersede every earlier event. */
  generation?: number;
  durationMs?: number;
  error?: string;
  /** Foreground remote-actor contention for a replay push, when this event reports one. */
  foreground?: {
    actorQueueDepth: number;
    actorQueueMs: number;
  };
  nextRunAt?: number;
  status: EmbeddedRemoteStatus;
  /** Monotonic event sequence within one generation. */
  sequence?: number;
  tick?: {
    connected?: boolean;
    changedTables: string[];
    rowsApplied: number;
    /** Permanent pull-application diagnostics retained until a new snapshot succeeds. */
    pullDiagnostics?: number;
    pullError?: string;
    pullAttempted: number;
    pullSnapshots?: number;
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
    receiptsPushed: number;
    storeJobs: number;
    pending?: {
      checkpoints: number;
      inflight: number;
      mutations: number;
      scope: number;
      settlements: number;
      uploads: number;
    };
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
 * @internal
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

/** A local after-image retained as a restorable revision. @internal */
export interface EmbeddedConflict {
  id: string;
  revId: string;
  table: string;
}

/**
 * An authoritative result displaced a local after-image, which was retained rather than lost.
 * Apps inspect the revision through their normal authorized Convex history functions. @internal
 */
export interface EmbeddedConflictEvent {
  at: number;
  conflicts: EmbeddedConflict[];
  type: "conflict";
}

/** Local scheduler row changes. @internal */
export interface EmbeddedSchedulerEvent {
  at: number;
  deletes: EmbeddedDataDelete[];
  type: "scheduler";
  docWrites: EmbeddedDataWrite[];
}

/**
 * Any rich observability event produced inside the embedded runtime.
 *
 * @remarks
 * Diagnostics are intentionally an implementation detail. The app-facing client
 * exposes connection state and durable mutation settlements instead; the optional
 * devtools package consumes this union through its private bridge.
 *
 * @internal
 */
export type DiagnosticEvent =
  | EmbeddedConflictEvent
  | EmbeddedDataEvent
  | EmbeddedOperationEvent
  | EmbeddedRemoteEvent
  | EmbeddedRuntimeEvent
  | EmbeddedSchedulerEvent
  | EmbeddedSpanEvent
  | EmbeddedStorageEvent;

/** Listener over the rich internal diagnostics channel. @internal */
export type DiagnosticEventListener = (event: DiagnosticEvent) => void;
