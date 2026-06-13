import type { ValidatorJSON } from "convex/values";

/**
 * Scalar value that can be stored in an extracted indexed column or bound.
 *
 * @internal
 */
export type ColValue = string | number | bigint | boolean | null | undefined;

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
 * Storage table definition.
 *
 * @internal
 */
export interface TableDef {
  name: string;
  columns: ColumnDef[];
  document?: ValidatorJSON;
  indexes: IndexDef[];
}

/**
 * Complete storage schema derived from a Convex schema.
 *
 * @internal
 */
export interface StoreSchema {
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
 * Upsert operation in a write batch.
 *
 * @internal
 */
export interface UpsertIn {
  table: string;
  id: string;
  data: StoredDocData;
  cols: Record<string, ColValue>;
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
 * Atomic storage write batch.
 *
 * @internal
 */
export interface WriteBatch {
  upserts: UpsertIn[];
  deletes: DeleteIn[];
}

/**
 * Source metadata for a storage commit.
 *
 * @internal
 */
export interface CommitOptions {
  mutationId?: string;
  mutationResult?: string;
  source: "local" | "remote";
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
 * Result metadata for a committed storage batch.
 *
 * @internal
 */
export interface CommitResult {
  changedTables: string[];
  commitSeq: number;
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
export const SCAN_CAP = 32_768;

/**
 * Page size used when {@link ScanSpec.pageSize} is omitted.
 *
 * @internal
 */
export const DEFAULT_SCAN_PAGE = 1_024;

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
export interface ScanSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
  order: "asc" | "desc";
  /** Max rows in this page, `1..=SCAN_CAP`. Defaults to {@link DEFAULT_SCAN_PAGE}. */
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
 * Rows removed by {@link LedgerSurface.prune}.
 *
 * @internal
 */
export interface PruneResult {
  commitsDeleted: number;
  mutationsDeleted: number;
}

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
 * `scan` is total — every spec executes (with widened bounds when necessary), so the runtime
 * always re-checks exact Convex order and bounds on the results. `count` returns `null` when its
 * bounds cannot be represented exactly (a widened count would over-count); callers count through
 * `key.scan` instead.
 *
 * @internal
 */
export interface DocSurface {
  /** Read one document by id. */
  read(table: string, id: string): Promise<StoredDoc | undefined>;
  /** One page of documents. */
  scan(spec: ScanSpec): Promise<DocPage>;
  count(spec: CountSpec): Promise<number | null>;
}

/**
 * Key-projection operations: document data never leaves storage.
 *
 * @internal
 */
export interface KeySurface {
  scan(spec: ScanSpec): Promise<KeyPage>;
}

/**
 * Durable mutation record operations, used for idempotent local retries.
 *
 * @internal
 */
export interface MutationSurface {
  begin(call: MutationCall): Promise<MutationRecord>;
  fail(mutationId: string, error: string): Promise<void>;
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
  prune(upToSeq: number): Promise<PruneResult>;
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
 * Monotonic creation-time clock. Synchronous: it never touches the database.
 *
 * @internal
 */
export interface ClockSurface {
  next(): number;
}

/**
 * Runtime storage contract used by the JavaScript Convex execution layer: one-word noun
 * namespaces whose methods are one-word verbs, plus root operations whose scope is the whole
 * store (`commit` spans the doc tables and both ledgers in one transaction).
 *
 * @internal
 */
export interface RuntimeStorage {
  readonly doc: DocSurface;
  readonly key: KeySurface;
  readonly clock: ClockSurface;
  readonly mutation?: MutationSurface;
  commit(batch: WriteBatch, options?: CommitOptions): Promise<CommitResult>;
}

/**
 * Read-only subset of {@link RuntimeStorage}.
 *
 * @internal
 */
export type RuntimeStorageReader = Pick<RuntimeStorage, "doc" | "key">;

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
  readonly mutation: MutationSurface;
  readonly ledger: LedgerSurface;
  readonly blob: BlobSurface;
  setup(schema: StoreSchema): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
