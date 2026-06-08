export type Param = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
export type Row = Record<string, unknown>;

export type IdentityKey = string;
export type Affinity = "TEXT" | "REAL" | "INTEGER";

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
  data: unknown;
}

export interface UpsertIn {
  table: string;
  id: string;
  data: unknown;
  cols: Record<string, Param>;
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
  | { kind: "eq"; value: Param }
  | {
      kind: "range";
      lower?: Param;
      lowerInclusive?: boolean;
      upper?: Param;
      upperInclusive?: boolean;
    };

export interface SeekKey {
  values: Param[];
}

export interface ScanSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
  order: "asc" | "desc";
  limit?: number;
  seek?: SeekKey;
}

export interface CountSpec {
  table: string;
  index?: string;
  bounds?: Bound[];
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
