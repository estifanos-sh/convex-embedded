import type { ColValue, StoredDoc, TableDef } from "../storage/types";
import { normalizeObject } from "./codec";

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

export function extractCols(
  def: TableDef,
  data: Record<string, unknown>,
): Record<string, ColValue> {
  const cols: Record<string, ColValue> = {};
  for (const col of def.columns) {
    cols[col.name] = toColValue(data[col.name]);
  }
  return cols;
}

export function dataOf(value: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key !== "_id" && key !== "_creationTime") data[key] = v;
  }
  return normalizeObject(data);
}

function toColValue(value: unknown): ColValue {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "bigint" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`indexed column value is not supported: ${describeValue(value)}`);
}

function describeValue(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "undefined") return "undefined";
  return JSON.stringify(value) ?? typeof value;
}
