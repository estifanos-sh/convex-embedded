export type Param = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
export type Row = Record<string, unknown>;

export type IdentityKey = string;
export type Affinity = "TEXT" | "REAL" | "INTEGER";
export type ColValue = string | number | bigint | boolean | null | undefined;
export type StoredDocData = Record<string, unknown>;

export interface ColumnDef {
  name: string;
  affinity: Affinity;
}

export interface IndexDef {
  name: string;
  fields: string[];
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
}

export interface StoreSchema {
  tables: TableDef[];
}

export interface StoredDoc {
  _id: string;
  _creationTime: number;
  data: StoredDocData;
}

export interface UpsertIn {
  table: string;
  id: string;
  data: StoredDocData;
  cols: Record<string, ColValue>;
  creationTime: number;
}

export interface DeleteIn {
  table: string;
  id: string;
}

export interface WriteBatch {
  upserts: UpsertIn[];
  deletes: DeleteIn[];
}

export type Bound =
  | { kind: "eq"; value: ColValue }
  | {
      kind: "range";
      lower?: ColValue;
      lowerInclusive?: boolean;
      upper?: ColValue;
      upperInclusive?: boolean;
    };

export interface ScanSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
  order: "asc" | "desc";
  limit?: number;
}

export interface CountSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
}

export interface RuntimeStorage {
  get(table: string, id: string): Promise<StoredDoc | undefined>;
  scan(spec: ScanSpec): Promise<StoredDoc[] | null>;
  count(spec: CountSpec): Promise<number | null>;
  nextCreationTime(): number;
  commit(batch: WriteBatch): Promise<void>;
}

export type RuntimeStorageReader = Pick<RuntimeStorage, "get" | "scan" | "count">;
export type RuntimeStorageWriter = RuntimeStorage;

export interface EmbeddedStoreBackend extends RuntimeStorage {
  setup(schema: StoreSchema): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export type BoundParam = string | number | bigint | boolean | null | Uint8Array;

export interface Statement {
  run(...params: BoundParam[]): Promise<unknown>;
  all(...params: BoundParam[]): Promise<unknown[]>;
}

export interface Connection {
  prepare(sql: string): Promise<Statement>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
