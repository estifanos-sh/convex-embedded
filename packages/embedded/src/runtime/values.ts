import type { Param, StoredDoc, TableDef } from "../storage/types";

export type RawDoc = Record<string, unknown> & { _id: string; _creationTime: number };

const ID_SEP = "|";

// Ids are random + unique; ordering is by the monotonic `_creationTime`, which is appended to every index.
export function makeId(table: string): string {
  const rand = globalThis.crypto.randomUUID().replace(/-/g, "");
  return `${table}${ID_SEP}${rand}`;
}

export function tableFromId(id: string): string {
  const sep = id.indexOf(ID_SEP);
  return sep < 0 ? "" : id.slice(0, sep);
}

export function materialize(stored: StoredDoc): RawDoc {
  return {
    ...(stored.data as Record<string, unknown>),
    _id: stored._id,
    _creationTime: stored._creationTime,
  };
}

export function extractCols(def: TableDef, data: Record<string, unknown>): Record<string, Param> {
  const cols: Record<string, Param> = {};
  for (const col of def.columns) {
    cols[col.name] = (data[col.name] ?? null) as Param;
  }
  return cols;
}

export function dataOf(value: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key !== "_id" && key !== "_creationTime") data[key] = v;
  }
  return data;
}
