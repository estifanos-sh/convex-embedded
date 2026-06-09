import type {
  Affinity,
  Bound,
  ColValue,
  CountSpec,
  EmbeddedStoreBackend,
  ScanSpec,
  StoreSchema,
  StoredDoc,
  TableDef,
  WriteBatch,
} from "../storage/types";
import { decode, encode } from "../runtime/codec";

interface NativeTaggedValue {
  text?: string;
  real?: number;
  int?: number | bigint;
  bool?: boolean;
}

interface NativeColValue extends NativeTaggedValue {
  name: string;
}

interface NativeBound {
  kind: "eq" | "range";
  value?: NativeTaggedValue;
  lower?: NativeTaggedValue;
  lowerInclusive?: boolean;
  upper?: NativeTaggedValue;
  upperInclusive?: boolean;
}

interface NativeScanSpec {
  table: string;
  index?: string;
  bounds?: NativeBound[];
  order: "asc" | "desc";
  limit?: number;
}

interface NativeCountSpec {
  table: string;
  index?: string;
  bounds?: NativeBound[];
}

interface NativeUpsert {
  table: string;
  id: string;
  data: string;
  cols: NativeColValue[];
  creationTime: number;
}

interface NativeWriteBatch {
  upserts: NativeUpsert[];
  deletes: { table: string; id: string }[];
}

interface NativeDoc {
  _id?: string;
  id?: string;
  _creationTime: number;
  data: string;
}

interface NativeStoreBinding {
  setup(schema: StoreSchema): Promise<void>;
  nextCreationTime(): number;
  commit(batch: NativeWriteBatch): Promise<void>;
  get(table: string, id: string): Promise<NativeDoc | undefined | null>;
  scan(spec: NativeScanSpec): Promise<NativeDoc[] | null>;
  count(spec: NativeCountSpec): Promise<number | bigint | null>;
  clear(): Promise<void>;
  close(): Promise<void> | void;
}

export interface NativeStoreOptions {
  identityKey?: string;
}

export class NativeEmbeddedStore implements EmbeddedStoreBackend {
  private schema = new Map<string, TableDef>();

  private constructor(private readonly inner: NativeStoreBinding) {}

  static wrap(inner: unknown): NativeEmbeddedStore {
    return new NativeEmbeddedStore(inner as NativeStoreBinding);
  }

  static async openWith(
    Store: { open(path: string, identityKey?: string): Promise<unknown> },
    path: string,
    options: NativeStoreOptions = {},
  ): Promise<NativeEmbeddedStore> {
    return new NativeEmbeddedStore(
      (await Store.open(path, options.identityKey)) as NativeStoreBinding,
    );
  }

  static async open(
    _path: string,
    _options: NativeStoreOptions = {},
  ): Promise<NativeEmbeddedStore> {
    throw new Error("NativeEmbeddedStore.open is not wired to a native artifact yet");
  }

  async setup(schema: StoreSchema): Promise<void> {
    await this.inner.setup(schema);
    this.schema = new Map(schema.tables.map((table) => [table.name, table]));
  }

  nextCreationTime(): number {
    return this.inner.nextCreationTime();
  }

  async get(table: string, id: string): Promise<StoredDoc | undefined> {
    const doc = await this.inner.get(table, id);
    return doc ? fromNativeDoc(doc) : undefined;
  }

  async scan(spec: ScanSpec): Promise<StoredDoc[] | null> {
    if (hasNonPushableBound(spec.bounds)) return null;
    const docs = await this.inner.scan(this.toNativeScanSpec(spec));
    return docs?.map(fromNativeDoc) ?? null;
  }

  async count(spec: CountSpec): Promise<number | null> {
    if (hasNonPushableBound(spec.bounds)) return null;
    const n = await this.inner.count(this.toNativeCountSpec(spec));
    return n === null ? null : Number(n);
  }

  async commit(batch: WriteBatch): Promise<void> {
    await this.inner.commit({
      upserts: batch.upserts.map((upsert) => ({
        table: upsert.table,
        id: upsert.id,
        data: encode(upsert.data),
        cols: Object.entries(upsert.cols).map(([name, value]) => ({
          name,
          ...toNativeValue(value, this.columnAffinity(upsert.table, name)),
        })),
        creationTime: upsert.creationTime,
      })),
      deletes: batch.deletes,
    });
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }

  close(): Promise<void> {
    return Promise.resolve(this.inner.close());
  }

  private toNativeScanSpec(spec: ScanSpec): NativeScanSpec {
    return {
      ...spec,
      bounds: this.toNativeBounds(spec.table, spec.index, spec.bounds),
    };
  }

  private toNativeCountSpec(spec: CountSpec): NativeCountSpec {
    return {
      ...spec,
      bounds: this.toNativeBounds(spec.table, spec.index, spec.bounds),
    };
  }

  private toNativeBounds(
    tableName: string,
    indexName: string | undefined,
    bounds: Bound[] | undefined,
  ): NativeBound[] | undefined {
    if (!bounds) return undefined;
    const affinities = this.boundAffinities(tableName, indexName);
    return bounds.map((bound, i) => {
      const affinity = affinities[i] ?? "TEXT";
      return bound.kind === "eq"
        ? { kind: "eq", value: toNativeValue(bound.value, affinity) }
        : {
            kind: "range",
            lower: bound.lower === undefined ? undefined : toNativeValue(bound.lower, affinity),
            lowerInclusive: bound.lowerInclusive,
            upper: bound.upper === undefined ? undefined : toNativeValue(bound.upper, affinity),
            upperInclusive: bound.upperInclusive,
          };
    });
  }

  private boundAffinities(tableName: string, indexName: string | undefined): Affinity[] {
    const table = this.schema.get(tableName);
    if (!table || !indexName) return ["TEXT"];
    const index = table.indexes.find((candidate) => candidate.name === indexName);
    return index?.fields.map((field) => this.columnAffinity(tableName, field)) ?? ["TEXT"];
  }

  private columnAffinity(tableName: string, columnName: string): Affinity {
    const table = this.schema.get(tableName);
    return table?.columns.find((column) => column.name === columnName)?.affinity ?? "TEXT";
  }
}

function fromNativeDoc(doc: NativeDoc): StoredDoc {
  const id = doc._id ?? doc.id;
  if (!id) throw new Error("native document is missing _id");
  const data = decode(doc.data);
  if (!isRecord(data)) throw new Error("native document data must be an object");
  return { _id: id, _creationTime: doc._creationTime, data };
}

function toNativeValue(value: ColValue, affinity: Affinity): NativeTaggedValue {
  if (value === undefined) return {};
  if (value === null) return {};
  if (typeof value === "string") {
    if (affinity !== "TEXT") throw new Error(`expected ${affinity} column value, got string`);
    return { text: value };
  }
  if (typeof value === "boolean") return { bool: value };
  if (typeof value === "bigint") return { int: checkedI64(value) };
  if (!Number.isFinite(value)) throw new Error(`invalid numeric column value: ${String(value)}`);
  if (affinity === "INTEGER") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`integer column value is not a safe integer: ${String(value)}`);
    }
    return { int: BigInt(value) };
  }
  return { real: value };
}

function hasNonPushableBound(bounds: Bound[] | undefined): boolean {
  return (
    bounds?.some((bound) =>
      bound.kind === "eq"
        ? bound.value === undefined || bound.value === null
        : bound.lower === null || bound.upper === null,
    ) ?? false
  );
}

function checkedI64(value: bigint): bigint {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (value < min || value > max) throw new Error(`bigint out of i64 range: ${value}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
