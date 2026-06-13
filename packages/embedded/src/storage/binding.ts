import { encode, reviveDoc } from "../runtime/codec";
import type {
  BlobSurface,
  Bound,
  ClockSurface,
  ColValue,
  CountSpec,
  CommitOptions,
  CommitResult,
  DocSurface,
  KeySurface,
  LedgerSurface,
  MutationCall,
  MutationRecord,
  MutationSurface,
  ScanSpec,
  StorageBackend,
  StoreSchema,
  StoredDoc,
  WriteBatch,
} from "./types";

export interface BindingTaggedValue {
  text?: string;
  real?: number;
  int?: string;
  bool?: boolean;
  /** Convex `undefined` (a missing field). All-absent means `null`. */
  undef?: boolean;
}

export interface BindingColValue extends BindingTaggedValue {
  name: string;
}

export interface BindingBound {
  kind: "eq" | "range";
  value?: BindingTaggedValue;
  lower?: BindingTaggedValue;
  lowerInclusive?: boolean;
  upper?: BindingTaggedValue;
  upperInclusive?: boolean;
}

export interface BindingScanSpec {
  table: string;
  index?: string;
  bounds?: BindingBound[];
  order: "asc" | "desc";
  pageSize?: number;
  cursor?: string;
  resumeAfterKey?: BindingTaggedValue[];
}

export interface BindingCountSpec {
  table: string;
  index?: string;
  bounds?: BindingBound[];
}

export interface BindingUpsert {
  table: string;
  id: string;
  data: string;
  cols: BindingColValue[];
  creationTime: number;
}

export interface BindingWriteBatch {
  upserts: BindingUpsert[];
  deletes: { table: string; id: string }[];
}

export interface BindingCommitOptions {
  mutationId?: string;
  mutationResult?: string;
  source?: "local" | "remote";
}

export interface BindingCommitResult {
  changedTables: string[];
  commitSeq: bigint | number;
}

/**
 * One scan page as a single JSON text: one string crossing and one `JSON.parse` per page.
 * Document pages parse to `StoredDoc[]`; key pages parse to `{ ids, cts }`.
 */
export interface BindingPage {
  text: string;
  cursor?: string | null;
}

export interface BindingPruneResult {
  commitsDeleted: bigint | number;
  mutationsDeleted: bigint | number;
}

export interface BindingMutationCall {
  args: string;
  mutationId: string;
  name: string;
}

export interface BindingMutationRecord {
  commitSeq?: bigint | number | null;
  error?: string | null;
  mutationId: string;
  result?: string | null;
  status: "accepted" | "committed" | "failed";
}

/**
 * Raw storage binding shape shared by the NAPI and wasm adapters. Mirrors the napi `Store`
 * surface exactly: the flattened `nounVerb` form of each `noun.verb` operation, every database
 * call asynchronous, and `clockNext` synchronous (clock-only).
 *
 * @internal
 */
export interface StoreBinding {
  setup(schema: StoreSchema): Promise<void>;
  mutationBegin(call: BindingMutationCall): Promise<BindingMutationRecord>;
  mutationFail(mutationId: string, error: string): Promise<void>;
  clockNext(): number;
  commit(batch: BindingWriteBatch, options?: BindingCommitOptions): Promise<BindingCommitResult>;
  docRead(table: string, id: string): Promise<string | undefined | null>;
  docScan(spec: BindingScanSpec): Promise<BindingPage>;
  keyScan(spec: BindingScanSpec): Promise<BindingPage>;
  docCount(spec: BindingCountSpec): Promise<number | bigint | null>;
  ledgerPrune(upToSeq: number): Promise<BindingPruneResult>;
  blobRead(key: string): Promise<Uint8Array | null>;
  blobWrite(key: string, bytes: Uint8Array): Promise<void>;
  blobDelete(key: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void> | void;
}

/**
 * Contract adapter that hides raw Rust binding values from the runtime.
 *
 * @internal
 */
export class StoreAdapter implements StorageBackend {
  constructor(private readonly inner: StoreBinding) {}

  readonly doc: DocSurface = {
    read: async (table, id) => {
      const text = await this.inner.docRead(table, id);
      return text ? parseDoc(text) : undefined;
    },
    scan: async (spec) => {
      const page = await this.inner.docScan(this.toBindingScanSpec(spec));
      return { docs: parseDocs(page.text), cursor: page.cursor ?? null };
    },
    count: async (spec) => {
      const n = await this.inner.docCount(this.toBindingCountSpec(spec));
      return n === null ? null : Number(n);
    },
  };

  readonly key: KeySurface = {
    scan: async (spec) => {
      const page = await this.inner.keyScan(this.toBindingScanSpec(spec));
      const keys = JSON.parse(page.text) as { ids: string[]; cts: number[] };
      return { ids: keys.ids, creationTimes: keys.cts, cursor: page.cursor ?? null };
    },
  };

  readonly clock: ClockSurface = {
    next: () => this.inner.clockNext(),
  };

  readonly mutation: MutationSurface = {
    begin: async (call: MutationCall) =>
      fromBindingMutationRecord(
        await this.inner.mutationBegin({
          args: call.args,
          mutationId: call.mutationId,
          name: call.name,
        }),
      ),
    fail: async (mutationId, error) => {
      await this.inner.mutationFail(mutationId, error);
    },
  };

  readonly ledger: LedgerSurface = {
    prune: async (upToSeq) => {
      const result = await this.inner.ledgerPrune(upToSeq);
      return {
        commitsDeleted: Number(result.commitsDeleted),
        mutationsDeleted: Number(result.mutationsDeleted),
      };
    },
  };

  readonly blob: BlobSurface = {
    read: async (key) => {
      const bytes = await this.inner.blobRead(key);
      if (bytes === null) return null;
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    write: (key, bytes) => this.inner.blobWrite(key, bytes),
    delete: (key) => this.inner.blobDelete(key),
  };

  setup(schema: StoreSchema): Promise<void> {
    return this.inner.setup(schema);
  }

  async commit(batch: WriteBatch, options?: CommitOptions): Promise<CommitResult> {
    const result = await this.inner.commit(
      {
        upserts: batch.upserts.map((upsert) => ({
          table: upsert.table,
          id: upsert.id,
          data: encodeDocData(upsert.data),
          cols: Object.entries(upsert.cols).map(([name, value]) => toBindingColValue(name, value)),
          creationTime: upsert.creationTime,
        })),
        deletes: batch.deletes,
      },
      {
        mutationId: options?.mutationId,
        mutationResult: options?.mutationResult,
        source: options?.source,
      },
    );
    return fromBindingCommitResult(result);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }

  close(): Promise<void> {
    return Promise.resolve(this.inner.close());
  }

  private toBindingScanSpec(spec: ScanSpec): BindingScanSpec {
    return {
      table: spec.table,
      index: spec.index,
      bounds: this.toBindingBounds(spec.table, spec.index, spec.bounds),
      order: spec.order,
      pageSize: spec.pageSize,
      cursor: spec.cursor,
      resumeAfterKey: spec.resumeAfterKey && this.toBindingKey(spec, spec.resumeAfterKey),
    };
  }

  private toBindingCountSpec(spec: CountSpec): BindingCountSpec {
    return {
      table: spec.table,
      index: spec.index,
      bounds: this.toBindingBounds(spec.table, spec.index, spec.bounds),
    };
  }

  /** Tag a resume key tuple. Order keys carry no affinity — the value type drives the tag. */
  private toBindingKey(_spec: ScanSpec, key: ColValue[]): BindingTaggedValue[] {
    return key.map(toBindingValue);
  }

  private toBindingBounds(
    tableName: string,
    indexName: string | undefined,
    bounds: Bound[] | undefined,
  ): BindingBound[] | undefined {
    if (!bounds) return undefined;
    if (!indexName) {
      throw new Error(`missing index for bounds on ${tableName}`);
    }
    return bounds.map((bound) =>
      bound.kind === "eq"
        ? { kind: "eq", value: toBindingValue(bound.value) }
        : {
            kind: "range",
            lower: bound.lower === undefined ? undefined : toBindingValue(bound.lower),
            lowerInclusive: bound.lowerInclusive,
            upper: bound.upper === undefined ? undefined : toBindingValue(bound.upper),
            upperInclusive: bound.upperInclusive,
          },
    );
  }
}

function fromBindingMutationRecord(record: BindingMutationRecord): MutationRecord {
  if (!record.mutationId) throw new Error("storage mutation record is missing mutationId");
  const commitSeq = record.commitSeq ?? undefined;
  return {
    commitSeq: commitSeq === undefined ? undefined : safeCommitSeq(commitSeq),
    error: record.error ?? undefined,
    mutationId: record.mutationId,
    result: record.result ?? undefined,
    status: record.status,
  };
}

function fromBindingCommitResult(result: BindingCommitResult): CommitResult {
  return {
    changedTables: result.changedTables,
    commitSeq: safeCommitSeq(result.commitSeq),
  };
}

function safeCommitSeq(commitSeq: bigint | number): number {
  if (typeof commitSeq === "bigint") {
    if (commitSeq > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`storage commitSeq exceeds Number.MAX_SAFE_INTEGER: ${commitSeq}`);
    }
    return Number(commitSeq);
  }
  if (!Number.isSafeInteger(commitSeq)) {
    throw new Error(`storage commitSeq is not a safe integer: ${String(commitSeq)}`);
  }
  return commitSeq;
}

/** One parse and one in-place revive per page — never one per document. */
/**
 * Encodes a document body to its JSON string for storage, asserting the splice invariant the page
 * protocol relies on: every stored doc is a JSON object (`{…}`), so the backend can concatenate
 * rows into one `[{…},{…}]` page string. Checking at commit turns a would-be scan-time page
 * corruption into an immediate, localized error.
 */
function encodeDocData(data: Parameters<typeof encode>[0]): string {
  const encoded = encode(data);
  if (encoded.charCodeAt(0) !== 0x7b) {
    throw new Error(`stored document data must be a JSON object, got: ${encoded.slice(0, 32)}`);
  }
  return encoded;
}

function parseDocs(text: string): StoredDoc[] {
  const docs = JSON.parse(text) as StoredDoc[];
  for (const doc of docs) reviveDoc(doc);
  return docs;
}

function parseDoc(text: string): StoredDoc {
  const doc = JSON.parse(text) as StoredDoc;
  reviveDoc(doc);
  return doc;
}

function toBindingColValue(name: string, value: ColValue): BindingColValue {
  const tagged = toBindingValue(value) as BindingColValue;
  tagged.name = name;
  return tagged;
}

/**
 * Tag a value for the order-key encoder, dispatched purely on JS type (index columns carry no
 * affinity): a `number` is a Convex float64, a `bigint` is int64, etc. `undefined` (a missing
 * field) and `null` are distinct. NaN/±Infinity/-0 are valid floats.
 */
function toBindingValue(value: ColValue): BindingTaggedValue {
  if (value === undefined) return { undef: true };
  if (value === null) return {};
  if (typeof value === "string") return { text: value };
  if (typeof value === "boolean") return { bool: value };
  if (typeof value === "bigint") return { int: checkedI64(value).toString() };
  if (typeof value === "number") return { real: value };
  throw new Error(`unsupported index value: ${String(value)}`);
}

function checkedI64(value: bigint): bigint {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (value < min || value > max) throw new Error(`bigint out of i64 range: ${value}`);
  return value;
}
