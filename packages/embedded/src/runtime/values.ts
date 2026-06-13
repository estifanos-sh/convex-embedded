import type { ColValue, StoredDoc, TableDef } from "../storage/types";
import { normalizeObject } from "./codec";

/**
 * Materialized document shape used inside the local runtime. Backend documents already arrive in
 * this shape (one page-level `JSON.parse` produces them), so only staged writer documents are
 * materialized in JS.
 *
 * @internal
 */
export type RawDoc = StoredDoc;

/**
 * A staged writer document: the payload still aliases mutation state, so it is materialized
 * (and deep-copied) before it reaches user code.
 *
 * @internal
 */
export interface StagedDoc {
  _id: string;
  _creationTime: number;
  data: Record<string, unknown>;
}

const ID_SEP = "|";

/**
 * Creates a local Convex-style document id.
 *
 * @internal
 */
export function createId(table: string): string {
  const rand = globalThis.crypto.randomUUID().replace(/-/g, "");
  return `${table}${ID_SEP}${rand}`;
}

/**
 * Extracts the table prefix from a local document id.
 *
 * @internal
 */
export function tableFromId(id: string): string {
  const sep = id.indexOf(ID_SEP);
  return sep < 0 ? "" : id.slice(0, sep);
}

/**
 * Combines staged document metadata and payload into a runtime document. Staged payloads alias
 * mutation state and must be deep-copied before they reach user code — see `cloneTree` at the
 * overlay.
 *
 * @internal
 */
export function materialize(staged: StagedDoc): RawDoc {
  return {
    ...staged.data,
    _id: staged._id,
    _creationTime: staged._creationTime,
  };
}

/**
 * Extracts indexed column values from a document payload.
 *
 * @internal
 */
export function extractCols(
  def: TableDef,
  data: Record<string, unknown>,
): Record<string, ColValue> {
  const cols: Record<string, ColValue> = {};
  for (const col of def.columns) {
    cols[col.name] = toColValue(readFieldPath(data, compileFieldPath(col.field ?? col.name)));
  }
  return cols;
}

/**
 * Rejects conflicting Convex system fields before a write is staged. `insert` forbids `_id` and
 * `_creationTime` outright; `patch`/`replace` accept them only when they match the target document
 * (so the read-modify-write round-trip is allowed), mirroring Convex.
 *
 * @internal
 */
export function assertNoSystemFieldConflict(
  method: string,
  value: Record<string, unknown>,
  target?: { id: string; creationTime: number },
): void {
  if ("_id" in value) {
    if (!target) throw new Error(`${method}: document must not contain the system field "_id"`);
    if (value._id !== target.id) {
      throw new Error(
        `${method}: "_id" (${String(value._id)}) does not match the document id ${target.id}`,
      );
    }
  }
  if ("_creationTime" in value) {
    if (!target) {
      throw new Error(`${method}: document must not contain the system field "_creationTime"`);
    }
    if (value._creationTime !== target.creationTime) {
      throw new Error(`${method}: "_creationTime" does not match the stored document`);
    }
  }
}

/**
 * Removes Convex system fields from a runtime document and runs it through the single
 * normalization point (validating deep copy + brand).
 *
 * @internal
 */
export function dataOf(value: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key !== "_id" && key !== "_creationTime") data[key] = v;
  }
  return normalizeObject(data);
}

function toColValue(value: unknown): ColValue {
  // A missing field is `undefined`; `null`, NaN, ±Infinity and -0 are all valid indexed values
  // (they encode to exact order keys). Composite values cannot be indexed.
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new Error(`indexed column value is not supported: ${describeValue(value)}`);
}

const fieldPaths = new Map<string, readonly string[]>();

/**
 * Splits a dotted Convex field path once and caches the segments. Hot paths (sorting,
 * bounds checks, column extraction) read fields per row — they must not re-split per access.
 *
 * @internal
 */
export function compileFieldPath(fieldPath: string): readonly string[] {
  let segments = fieldPaths.get(fieldPath);
  if (!segments) {
    segments = Object.freeze(fieldPath.split("."));
    fieldPaths.set(fieldPath, segments);
  }
  return segments;
}

/**
 * Reads a pre-split Convex field path from a document.
 *
 * @internal
 */
export function readFieldPath(doc: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = doc;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function describeValue(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "undefined") return "undefined";
  return JSON.stringify(value) ?? typeof value;
}
