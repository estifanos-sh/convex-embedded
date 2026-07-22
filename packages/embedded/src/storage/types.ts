import type { UserIdentity } from "convex/server";
import type { JSONValue, ValidatorJSON } from "convex/values";

import type { EmbeddedCrdtMeta } from "../meta";

/**
 * Scalar value that can be stored in an extracted indexed column or bound.
 *
 * @internal
 */
export type ColValue = string | number | bigint | boolean | null | undefined;

/**
 * Ordered extracted column entries. Runtime writes use this shape so the native binding can marshal
 * columns without first materializing and then enumerating an object.
 *
 * @internal
 */
export type ColEntries = [name: string, value: ColValue][];

/**
 * Extracted column input. Object form is retained for tests and adapter callers.
 *
 * @internal
 */
export type ColValues = Record<string, ColValue> | ColEntries;

/**
 * Stored Convex document payload without system fields.
 *
 * @internal
 */
export type StoredDocData = Record<string, unknown>;

/**
 * Extracted physical column definition.
 *
 * @internal
 */
export interface ColumnDef {
  name: string;
  field?: string;
}

/**
 * Storage index definition.
 *
 * `fields` are Convex field paths. `columns`, when present, are the physical storage columns that
 * implement those fields.
 *
 * @internal
 */
export interface IndexDef {
  name: string;
  fields: string[];
  columns?: string[];
}

/**
 * Explicit embedded CRDT field definition extracted from schema validators.
 *
 * Plain Convex fields are implicit registers and are intentionally omitted.
 *
 * @internal
 */
export type CrdtFieldDef = EmbeddedCrdtMeta & { field: string };

/**
 * Storage table definition.
 *
 * @internal
 */
export interface TableDef {
  name: string;
  placement: "replicated" | "device";
  columns: ColumnDef[];
  crdtFields?: CrdtFieldDef[];
  localFields?: LocalFieldDef[];
  document?: ValidatorJSON;
  indexes: IndexDef[];
}

export interface LocalFieldDef {
  field: string;
  validator: ValidatorJSON;
}

/**
 * Complete storage schema derived from a Convex schema.
 *
 * @internal
 */
export interface StoreSchema {
  hash?: string;
  tables: TableDef[];
}

/**
 * Materialized stored document returned by a backend: the document fields with the system
 * fields spliced in. Backends produce these by parsing one JSON page text, so the runtime never
 * pays a per-document parse or spread.
 *
 * @internal
 */
export type StoredDoc = Record<string, unknown> & {
  _id: string;
  _creationTime: number;
};

/**
 * Write operation in a write batch.
 *
 * @internal
 */
export interface DocWrite {
  table: string;
  id: string;
  data: StoredDocData;
  cols: ColValues;
  creationTime: number;
}

/**
 * Delete operation in a write batch.
 *
 * @internal
 */
export interface DeleteIn {
  table: string;
  id: string;
}

/**
 * Explicit embedded CRDT intent recorded durably alongside the projection write.
 *
 * @internal
 */
export type CrdtOp =
  | { table: string; id: string; field: string; kind: "count.add"; delta: number }
  | { table: string; id: string; field: string; kind: "set.add"; value: unknown }
  | { table: string; id: string; field: string; kind: "set.delete"; value: unknown }
  | {
      table: string;
      id: string;
      field: string;
      kind: "text.splice";
      index: number;
      delete: number;
      insert: string;
    };

/**
 * Atomic storage write batch.
 *
 * @internal
 */
export interface WriteBatch {
  docWrites: DocWrite[];
  deletes: DeleteIn[];
  localFieldWrites?: LocalFieldWrite[];
  localFieldDeletes?: LocalFieldDelete[];
  crdtOps?: CrdtOp[];
  /** Existing rows whose staged docWrite only materializes {@link crdtOps}. */
  crdtOnlyIds?: DeleteIn[];
  crdtRestores?: CrdtRestore[];
  freshIds?: DeleteIn[];
  dataOnlyIds?: DeleteIn[];
  idMappings?: IdMapping[];
  /** Local-only schedule rows folded into the mutation's commit transaction for crash atomicity. */
  schedules?: ScheduledJob[];
}

export interface LocalFieldWrite {
  table: string;
  id: string;
  field: string;
  value: unknown;
}

export interface LocalFieldDelete {
  table: string;
  id: string;
  field: string;
}

export interface CrdtRestore extends CrdtSnapshot {
  table: string;
  id: string;
}

/**
 * Source metadata for a storage commit.
 *
 * @internal
 */
type CommitChanges = { changes: "include" | "omit" };

export type CommitOptions = CommitChanges &
  (
    | { source: "remote" }
    | { source: "device" }
    | { source: "local"; mutation: "none" }
    | {
        source: "local";
        mutation: "push";
        mutationId: string;
        push: { json: string; nowMs: number };
      }
    | {
        source: "local";
        mutation: "existing";
        mutationId: string;
        mutationResult?: string;
      }
    | {
        source: "local";
        mutation: "terminal";
        mutationId: string;
        mutationName: string;
        mutationArgs: string;
        mutationResult: string;
        mutationIsFresh: boolean;
        push?: { json: string; nowMs: number };
      }
  );

/**
 * Single-docWrite commit metadata. This lets the runtime carry the common one-row write shape to
 * native storage without first materializing a generic batch.
 *
 * @internal
 */
export interface OneDocWriteCommit {
  dataOnly?: boolean;
  fresh?: boolean;
  docWrite: DocWrite;
}

/**
 * Durable mutation call metadata used for idempotent local retries.
 *
 * @internal
 */
export interface MutationCall {
  args: string;
  mutationId: string;
  name: string;
}

/**
 * Durable mutation status returned by storage.
 *
 * @internal
 */
export interface MutationRecord {
  commitSeq?: number;
  error?: string;
  mutationId: string;
  result?: string;
  status: "accepted" | "committed" | "failed";
}

/**
 * One row-level change produced by a committed storage batch.
 *
 * @internal
 */
export type StorageRowChange =
  | { id: string; op: "delete"; table: string }
  | { id: string; op: "write"; row: StoredDoc | Record<string, unknown>; table: string };

/**
 * Result metadata for a committed storage batch.
 *
 * @internal
 */
export interface CommitResult {
  changedTables: string[];
  changes: StorageRowChange[];
  commitSeq: number;
  /** CRDT-field edits this commit produced; `update` is base64 Loro bytes carried on the one push. */
  crdtOps?: CommitCrdtWireOp[];
}

/** A committed CRDT-field edit in wire shape — the client carries these on `embedded:push`. */
export interface CommitCrdtWireOp {
  table: string;
  id: string;
  field: string;
  kind: "text" | "count" | "set";
  update: string;
}

/**
 * Indexed bound expression for storage pushdown.
 *
 * @internal
 */
export type Bound =
  | { kind: "eq"; value: ColValue }
  | {
      kind: "range";
      lower?: ColValue;
      lowerInclusive?: boolean;
      upper?: ColValue;
      upperInclusive?: boolean;
    };

/**
 * Hard ceiling on rows in one scan page.
 *
 * @internal
 */
export const READ_CAP = 32_768;

/**
 * Page size used when {@link ReadSpec.pageSize} is omitted.
 *
 * @internal
 */
export const DEFAULT_READ_PAGE = 1_024;

/**
 * Paged storage scan request.
 *
 * Scans are total: every (table, index, bounds, order) executes. Bounds the storage layer cannot
 * represent exactly are widened, so a page may over-approximate — the runtime re-checks exact
 * Convex order and bounds on the decoded documents.
 *
 * Pages resume through keyset cursors over the physical order columns
 * (`index columns…, creation_time_ms, id`). Cursors are stable under inserts and deletes outside
 * the visited prefix; a document whose key columns change mid-pagination may be seen twice or
 * skipped, matching Convex pagination semantics.
 *
 * @internal
 */
export interface ReadSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
  order: "asc" | "desc";
  /** Max rows in this page, `1..=READ_CAP`. Defaults to {@link DEFAULT_READ_PAGE}. */
  pageSize?: number;
  /**
   * Opaque continuation token from a prior page of the same (table, index, bounds-shape, order).
   * Produced and parsed only by the storage backend.
   */
  cursor?: string;
  /**
   * Alternative to `cursor`: resume strictly after this explicit key tuple, one value per
   * physical order column (`index columns…, creation_time_ms, id`).
   */
  resumeAfterKey?: ColValue[];
}

/**
 * One page of documents. `cursor` is `null` when the scan is exhausted.
 *
 * @internal
 */
export interface DocPage {
  docs: StoredDoc[];
  cursor: string | null;
  /**
   * Per-row adoption version sidecar (contract §11 D1): `{ localId: seq }`, the remote sequence at which
   * each row was last adopted. Kept out of the app-row JSON (compact-splice invariant). Absent
   * entries → version 0, so the server conservatively re-reads for conflict detection.
   */
  versions?: Record<string, number>;
  /** Device-only fields keyed by local document id, kept outside replicated row JSON. */
  deviceFields?: Record<string, Record<string, unknown>>;
}

/**
 * One page of document keys as parallel arrays — no per-key objects. `cursor` is `null` when
 * the scan is exhausted.
 *
 * @internal
 */
export interface KeyPage {
  ids: string[];
  creationTimes: number[];
  cursor: string | null;
}

/**
 * Rows removed by {@link LedgerSurface.delete}.
 *
 * @internal
 */
export interface DeleteResult {
  commitsDeleted: number;
  mutationsDeleted: number;
}

/**
 * Durable local-to-server ID state. A mapped ID always carries its hosted value.
 *
 * @internal
 */
type IdMappingBase = {
  table: string;
  localId: string;
  createdTime: number;
  updatedTime: number;
};

export type IdMapping = IdMappingBase &
  (
    | { mapping: "local" }
    | { mapping: "mapped"; convexId: string }
    | { mapping: "deleted"; convexId?: string }
  );

/**
 * Internal dirty-head diagnostic row exposed to devtools and metal benchmarks.
 *
 * @internal
 */
export interface DirtyHeadDebug {
  table: string;
  id: string;
  op: "write" | "delete";
  firstCommitSeq: number;
  updatedCommitSeq: number;
  createdTime: number;
  updatedTime: number;
  serverDocumentId?: string | null;
  baseProjectionHash?: string | null;
  baseRootId?: string | null;
  baseNodeId?: string | null;
  logicalClock: number;
}

/** Internal projection-state diagnostic exposed only through devtools/metal snapshots. @internal */
export interface RemoteDocDebug {
  table: string;
  localDocumentId: string;
  currentRevId: string;
  serverDocumentId: string;
  projectionHash: string;
  currentRootId?: string;
  currentNodeId?: string;
  serverBase?: string;
  logicalClock: number;
  updatedTime: number;
}

/**
 * Metadata for a locally stored file/blob.
 *
 * @internal
 */
export interface FileMetadata {
  storageId: string;
  sha256: string;
  size: number;
  contentType?: string;
  source?: string;
  createdTime: number;
  updatedTime: number;
}

/**
 * Atomic local file store input: blob bytes plus metadata.
 *
 * @internal
 */
export interface FileStore {
  bytes: Uint8Array;
  metadata: FileMetadata;
}

/**
 * One pending file upload queue row.
 *
 * @internal
 */
export type PendingUpload = {
  localStorageId: string;
  sha256: string;
  size: number;
  contentType?: string;
  createdTime: number;
  updatedTime: number;
} & ({ lease: "pending" } | { lease: "claimed"; owner: string; leaseUntil: number });

/**
 * Local scheduler job state.
 *
 * @internal
 */
export type ScheduledState = "pending" | "running" | "complete" | "canceled" | "failed";

/**
 * Convex function kind supported by local scheduler jobs.
 *
 * @internal
 */
export type ScheduledFunctionKind = "mutation" | "action";

/**
 * One persisted local scheduler job.
 *
 * @internal
 */
export type ScheduledJob = {
  jobId: string;
  kind: ScheduledFunctionKind;
  name: string;
  args: string;
  dueTime: number;
  createdTime: number;
  updatedTime: number;
} & (
  | { state: "pending" }
  | { state: "running"; leaseUntil: number }
  | { state: "complete" }
  | { state: "canceled" }
  | { state: "failed" }
);

/**
 * Storage count request.
 *
 * @internal
 */
export interface CountSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
}

/**
 * Document operations.
 *
 * `page.read` is total — every spec executes (with widened bounds when necessary), so the runtime
 * always re-checks exact Convex order and bounds on the results. `count.read` returns `null` when its
 * bounds cannot be represented exactly (a widened count would over-count); callers count through
 * `key.page.read` instead.
 *
 * @internal
 */
export interface DocSurface {
  /** Read one document by id. */
  read(table: string, id: string): Promise<StoredDoc | undefined>;
  device?: { read(table: string, id: string): Promise<Record<string, unknown>> };
  /**
   * Read one row's adoption version (the point-read counterpart of the page
   * `versions` sidecar): the remote `seq` the row was last adopted at, or
   * `undefined` when it carries none (contract §11-D1). Backs the push read-set
   * point base-version.
   */
  version: { read(table: string, id: string): Promise<number | undefined> };
  crdt: {
    read(table: string, id: string, field: string): Promise<number | undefined>;
    snapshot: {
      read(table: string, id: string, ops?: CrdtOp[]): Promise<CrdtSnapshot[]>;
    };
  };
  /** One page of documents. */
  page: { read(spec: ReadSpec): Promise<DocPage> };
  count: { read(spec: CountSpec): Promise<number | null> };
  /**
   * The last accepted authoritative base a row's projection durably retains (Cut 7 §4.3 [V5-BASE]).
   * Present even after a local dirty delete; the retained-result cache splices it for a referenced
   * row that is locally dirty-deleted. `undefined` when the row has no projection.
   */
  base?: { read(table: string, id: string): Promise<StoredDoc | undefined> };
}

export interface CrdtSnapshot {
  field: string;
  kind: "text" | "count" | "set";
  headSeq: number;
  projectionHash: string;
  bytes: ArrayBuffer;
  hash: string;
}

/**
 * One decoded retained authored-result cache entry (Cut 7 §3): the normalized skeleton bytes and the
 * encoded `resultRows` the runtime reconstructs against local row state.
 *
 * @internal
 */
export interface ResultEntry {
  key: string;
  function: string;
  args: string;
  schemaHash: string;
  moduleHash: string;
  skeleton: Uint8Array;
  paths: Uint8Array;
  skeletonHash: string;
  clock: number;
}

/**
 * Retained authored-result cache operations (Cut 7 §3/§4). `read` backs the cache-serve lookup keyed
 * by the TS-authoritative `resultCacheKey`; `write` is used by tests and the runtime-driven apply.
 *
 * @internal
 */
export interface ResultSurface {
  read(key: string): Promise<ResultEntry | undefined>;
  write(entry: ResultEntry): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Key-projection operations: document data never leaves storage.
 *
 * @internal
 */
export interface KeySurface {
  page: { read(spec: ReadSpec): Promise<KeyPage> };
}

/**
 * Durable mutation record operations, used for idempotent local retries.
 *
 * @internal
 */
export interface MutationSurface {
  write(call: MutationCall, options?: { fresh?: boolean }): Promise<MutationRecord>;
  fail(mutationId: string, error: string): Promise<void>;
}

/** SQLite WAL maintenance kept below the document/revision checkpoint vocabulary. @internal */
export interface WalSurface {
  write(): Promise<void>;
}

/**
 * Commit/mutation ledger operations.
 *
 * @internal
 */
export interface LedgerSurface {
  /**
   * Delete commit/mutation ledger rows at or below the consumer watermark `upToSeq`. The newest
   * commit row is always retained so `commitSeq` stays monotonic; mutations that never committed
   * are never touched. Future replication calls this with its delivered watermark.
   */
  delete(upToSeq: number): Promise<DeleteResult>;
}

/**
 * Binary blob operations. Bytes cross the boundary without any text encoding.
 *
 * @internal
 */
export interface BlobSurface {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Durable id-map operations.
 *
 * @internal
 */
export interface IdSurface {
  write(mapping: IdMapping): Promise<void>;
  read(table: string, localId: string): Promise<IdMapping | undefined>;
  page: { read(table: string): Promise<IdMapping[]> };
  delete(table: string, localId: string): Promise<void>;
}

/**
 * Local file metadata operations.
 *
 * @internal
 */
export interface FileSurface {
  write(input: FileStore): Promise<void>;
  meta: { write(metadata: FileMetadata): Promise<void> };
  read(storageId: string): Promise<FileMetadata | undefined>;
  delete(storageId: string): Promise<void>;
}

/**
 * Exact command for the upload-lease lifecycle write.
 *
 * @internal
 */
export type UploadLeaseWrite =
  | {
      lease: "claimed";
      localStorageId?: string;
      owner: string;
      nowMs: number;
      leaseUntil: number;
    }
  | {
      lease: "pending";
      localStorageId: string;
      owner: string;
      nowMs: number;
    };

/**
 * Lease lifecycle for a local pending upload, collapsed into one write.
 *
 * @internal
 */
export interface UploadLeaseSurface {
  write(args: UploadLeaseWrite): Promise<PendingUpload | undefined>;
}

/**
 * Local pending upload queue operations.
 *
 * @internal
 */
export interface UploadSurface {
  write(upload: PendingUpload): Promise<void>;
  read(): Promise<PendingUpload[]>;
  lease: UploadLeaseSurface;
  complete(
    localStorageId: string,
    owner: string,
    convexId: string,
    nowMs: number,
  ): Promise<boolean>;
  delete(localStorageId: string): Promise<void>;
}

/**
 * Local scheduled job operations.
 *
 * `lease.write` is the ownership boundary: a runtime writes one upload into the claimed state, then
 * completes/fails/cancels it before another runtime can claim it.
 *
 * @internal
 */
export interface ScheduleSurface {
  write(job: ScheduledJob): Promise<void>;
  read(): Promise<ScheduledJob[]>;
  lease: { write(nowMs: number): Promise<ScheduledJob | undefined> };
  complete(jobId: string, nowMs: number): Promise<ScheduledJob | undefined>;
  fail(jobId: string, nowMs: number): Promise<ScheduledJob | undefined>;
  cancel(jobId: string, nowMs: number): Promise<ScheduledJob | undefined>;
}

/**
 * Native remote replication lifecycle owned by a platform storage backend.
 *
 * @internal
 */
/**
 * The pull subscription a client publishes (contract §11 D3): the query the server re-runs under
 * normal in-handler auth to authorize, derive the read-set, and pull initial state. The server owns scoping;
 * the client publishes one exact descriptor per watched query and never sends a computed range.
 *
 * @internal
 */
export interface RemoteSubscription {
  fn: string;
  args: JSONValue;
  /**
   * TS-authoritative retained-result cache key (Cut 7 §1/§14) over `fn` + `canonicalJson(args)` +
   * identity partition + runtime schema/module hashes, stored verbatim by the Rust apply.
   */
  resultCacheKey: string;
  cursor?: {
    path: string;
    boundary: {
      rowId: string;
      values: Array<{ field: string; value?: JSONValue; missing?: true }>;
    };
  };
}

export interface RemoteScope {
  subscriptions: RemoteSubscription[];
}

export interface RemoteSurface {
  start(options: RemoteStartOptions): Promise<void>;
  close(): Promise<void>;
  /** Pull once; `localProgress` controls whether durable local upload work is inspected. */
  pull?(localProgress: boolean): Promise<RemoteTick>;
  identity?(): Promise<RemoteIdentity>;
  doc?: {
    push(
      table: string,
      id: string,
      token: { firstCommitSeq: number; updatedCommitSeq: number },
    ): Promise<RemoteDocPushWire>;
  };
  scope?: { write(scope: RemoteScope): Promise<void> };
}

/** Identity and wire revision accepted by the selected Convex deployment. @internal */
export interface RemoteIdentity {
  identity: UserIdentity | null;
  identityKey?: string;
  protocolVersion: number;
}

export interface RemoteDocPushWire {
  /** Browser remote-actor contention observed before this foreground replay started. */
  actorQueueDepth?: number;
  /** Browser remote-actor wait observed before this foreground replay started. */
  actorQueueMs?: number;
  state: "blocked" | "settled" | "stale";
  tick: RemoteTick;
}

/** One native remote replication tick result. @internal */
export interface RemoteTick {
  /** Native actor transport transition; absent when connectivity did not change. */
  connected?: boolean;
  changedTables: string[];
  rowsApplied: number;
  pullAttempted: number;
  /** Authoritative row changes durably applied during this tick. */
  pullChangesApplied: number;
  /** Complete authoritative membership snapshots durably committed during this tick. */
  pullSnapshots: number;
  pushAccepted: number;
  pushAttempted: number;
  pushConflicts: number;
  pushRebases: number;
  received: number;
  reconnected: boolean;
  pushed: number;
  /** Replays the server rejected this tick; skipped so one poison record cannot wedge the pump. */
  pushFailed: number;
  retainedRevisions: RemoteReroot[];
  sent: number;
  receiptsPushed: number;
  storeJobs: number;
  /**
   * Count of retained pull results this tick that failed to apply for a permanent (non-transient)
   * reason — an incompatible, corrupt, or unsatisfiable checkpoint manifest. Reported once and held
   * without re-attempt until the live manifest changes; never silently resolved.
   */
  pullDiagnostics: number;
  /** Permanent pull-application failure detail for diagnostics. */
  pullError?: string;
  /**
   * Retained-result cache keys (Cut 7 §5) whose reconstruction changed this tick with no member or
   * projection row change. The runtime reruns the matching table-invisible watch by key.
   */
  changedResults: string[];
  /** Authoritative durable and actor-owned work remaining after this tick. */
  pending?: RemotePending;
}

/** Work that must reach zero before remote replication is converged. @internal */
export interface RemotePending {
  checkpoints: number;
  inflight: number;
  mutations: number;
  scope: number;
  settlements: number;
  uploads: number;
}

/**
 * A server re-root surfaced this tick: a local edit lost a compare-and-swap and was archived (a
 * conflict the app can act on), not destroyed.
 *
 * @internal
 */
export interface RemoteReroot {
  table: string;
  id: string;
  revId: string;
}

/**
 * Native remote replication configuration. Function paths are intentionally
 * absent: the Rust remote owns the canonical `embedded:pull` / `embedded:push`
 * protocol constants.
 *
 * @internal
 */
export interface RemoteStartOptions {
  auth?: (args: { forceRefreshToken: boolean }) => Promise<string | null> | string | null;
  clientId?: string;
  /** Exact prior runtime identities approved for transport-only replay by this build. */
  compatiblePriorRuntimes?: readonly RemoteRuntimeIdentity[];
  moduleGraphHash: string;
  /** Receives native actor transitions after their local transaction commits. */
  notify?: (tick: RemoteTick) => void;
  operationTimeoutMs?: number;
  protocolVersion: number;
  receiveTimeoutMs?: number;
  schemaHash: string;
  /** Internal browser WASM socket bridge. */
  transport?: RemoteTransportHost;
  url: string;
}

/** Runtime identity fields carried by a durable mutation envelope. @internal */
export interface RemoteRuntimeIdentity {
  moduleGraphHash: string;
  protocolVersion: number;
  schemaHash: string;
}

/** Internal raw transport host for the browser WASM remote driver. @internal */
export interface RemoteTransportHost {
  close(): Promise<void>;
  connect(args: { url: string }): Promise<void>;
  monotonicMs(): number;
  nowMs(): number;
  receive(args: {
    timeoutMs: number;
  }): Promise<
    { kind: "closed"; reason?: string } | { kind: "message"; message: string } | { kind: "timeout" }
  >;
  runStoreJob(): void;
  send(args: { message: string }): Promise<void>;
  /**
   * Transfers a claimed pending upload's bytes to the upload URL minted by `embedded:upload`, then
   * returns the hosted storage id. The WASM remote driver invokes this during `drain_uploads` so
   * in-browser replication can complete file uploads through the existing local upload path.
   */
  upload(args: {
    bytes: Uint8Array;
    contentType?: string;
    localStorageId: string;
    sha256: string;
    size: number;
    uploadUrl: string;
  }): Promise<{ storageId: string }>;
}

/**
 * Monotonic creation-time clock. Synchronous: it never touches the database.
 *
 * @internal
 */
export interface ClockSurface {
  read(): number;
}

/**
 * Optional storage behavior flags used by runtime fast paths.
 *
 * @internal
 */
export interface RuntimeStorageCapabilities {
  /** Backend scans enforce bounds and page size exactly, so query terminals can skip rechecks. */
  hasExactBounds?: boolean;
}

/**
 * Runtime storage contract used by the JavaScript Convex execution layer: one-word noun
 * namespaces whose methods are one-word verbs, plus root operations whose scope is the whole
 * store (`commit` spans the doc tables and both ledgers in one transaction).
 *
 * @internal
 */
export interface RuntimeStorage {
  readonly capabilities?: RuntimeStorageCapabilities;
  readonly identity?: {
    read(): Promise<{ identity: UserIdentity | null; identityKey: string }>;
    write(identityKey: string): Promise<void>;
  };
  readonly doc: DocSurface;
  readonly key: KeySurface;
  readonly clock: ClockSurface;
  readonly id: IdSurface;
  readonly result?: ResultSurface;
  readonly mutation?: MutationSurface;
  readonly remote?: RemoteSurface;
  commit(batch: WriteBatch, options?: CommitOptions): Promise<CommitResult>;
  commitOneDocWrite?(commit: OneDocWriteCommit, options?: CommitOptions): Promise<CommitResult>;
}

/**
 * Read-only subset of {@link RuntimeStorage}.
 *
 * @internal
 */
export type RuntimeStorageReader = Pick<
  RuntimeStorage,
  "capabilities" | "doc" | "key" | "id" | "result" | "remote"
>;

/**
 * Read/write runtime storage contract.
 *
 * @internal
 */
export type RuntimeStorageWriter = RuntimeStorage;

/**
 * Lifecycle-capable storage backend.
 *
 * @internal
 */
export interface StorageBackend extends RuntimeStorage {
  readonly identity: {
    read(): Promise<{ identity: UserIdentity | null; identityKey: string }>;
    write(identityKey: string): Promise<void>;
  };
  readonly mutation: MutationSurface;
  readonly ledger: LedgerSurface;
  readonly blob: BlobSurface;
  readonly file: FileSurface;
  readonly id: IdSurface;
  readonly upload: UploadSurface;
  readonly schedule: ScheduleSurface;
  readonly wal: WalSurface;
  readonly remote?: RemoteSurface;
  dirtyHeadsDebugRead?(): Promise<DirtyHeadDebug[]>;
  remoteDocDebugRead?(table: string, localId: string): Promise<RemoteDocDebug | undefined>;
  setup(schema: StoreSchema): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
