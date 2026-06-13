import { compareValues, ConvexError, convexToJson, jsonToConvex } from "convex/values";
import type { JSONValue, Value } from "convex/values";

/**
 * Values already normalized and validated by {@link normalizeCopy}. Downstream stages trust the
 * brand and skip re-normalizing. A mark is only meaningful within the pipeline that produced it
 * (args → validate → handler; result → validate → encode → commit).
 */
const normalized = new WeakSet<object>();

const MAX_FIELD_NAME_LENGTH = 1024;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

/**
 * Encodes a Convex value to JSON text. Values branded by {@link normalizeCopy} skip the
 * normalization pass.
 *
 * @internal
 */
export function encode(value: unknown): string {
  const ready = isNormalized(value) ? value : normalizeCopy(value);
  return JSON.stringify(convexToJson(ready as Value));
}

/**
 * Decodes JSON text into a Convex value.
 *
 * @internal
 */
export function decode(value: string): unknown {
  return fromJson(JSON.parse(value) as JSONValue);
}

/**
 * Converts Convex JSON into a runtime value.
 *
 * @internal
 */
export function fromJson(value: JSONValue): unknown {
  return jsonToConvex(value);
}

/**
 * Serializes a failed-mutation error so a replay can reconstruct it. A {@link ConvexError} keeps
 * its `data` (encoded as a Convex value); any other error keeps its `name` and `message`. The
 * result is a JSON string stored alongside the mutation ledger entry. Never throws.
 *
 * @internal
 */
export function encodeError(error: unknown): string {
  if (error instanceof ConvexError) {
    try {
      return JSON.stringify({
        data: convexToJson(normalizeCopy(error.data) as Value),
        kind: "convex",
      });
    } catch {
      // The data was not a representable Convex value — fall through to the message form.
    }
  }
  if (error instanceof Error) {
    return JSON.stringify({ kind: "error", message: error.message, name: error.name });
  }
  return JSON.stringify({ kind: "error", message: String(error), name: "Error" });
}

/**
 * Reconstructs an error previously serialized by {@link encodeError}. Legacy plain-string payloads
 * (or anything that is not our JSON shape) decode to a plain `Error` carrying that text.
 *
 * @internal
 */
export function decodeError(encoded: string): Error {
  let parsed: { data?: JSONValue; kind?: string; message?: string; name?: string };
  try {
    parsed = JSON.parse(encoded) as typeof parsed;
  } catch {
    return new Error(encoded);
  }
  if (parsed.kind === "convex") {
    return new ConvexError(fromJson(parsed.data ?? null) as string);
  }
  const error = new Error(parsed.message ?? encoded);
  if (parsed.name) error.name = parsed.name;
  return error;
}

/**
 * Whether a value was produced (and branded) by {@link normalizeCopy}. Primitives need no
 * normalization so they always count as normalized, except bigints, which stay unbranded so
 * range validation still runs on them.
 *
 * @internal
 */
export function isNormalized(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return typeof value !== "bigint";
  return normalized.has(value);
}

/**
 * The single normalization point of the runtime: one validating, normalizing structural
 * deep-copy. In one walk it (a) copies into fresh objects/arrays/buffers so caller-held
 * references cannot alias runtime state, (b) normalizes (strips `undefined` object fields,
 * converts views to detached `ArrayBuffer`s, maps top-level `undefined` to `null`), and
 * (c) enforces the Convex value constraints `convexToJson` would (supported types only, i64
 * range, field-name rules). The result is branded so downstream stages run zero extra passes.
 *
 * @internal
 */
export function normalizeCopy(value: unknown): unknown {
  const out = normalizeCopyInner(value, true, "value");
  return markNormalized(out);
}

/**
 * Brands a value as normalized. Only for values structurally guaranteed to satisfy
 * {@link normalizeCopy}'s invariants (its own results, or deep copies of them).
 *
 * @internal
 */
export function markNormalized<T>(value: T): T {
  if (typeof value === "object" && value !== null) normalized.add(value);
  return value;
}

function normalizeCopyInner(value: unknown, topLevel: boolean, path: string): unknown {
  if (value === undefined) return topLevel ? null : undefined;
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
      return value;
    case "bigint":
      if (value < MIN_INT64 || value > MAX_INT64) {
        throw new Error(`${path}: BigInt ${value} does not fit into a 64-bit signed integer.`);
      }
      return value;
    case "object":
      break;
    default:
      throw new Error(`${path} is not a valid Convex value: unexpected ${typeof value}`);
  }
  // Byte values cross async storage/runtime boundaries, so detach from caller-owned buffers.
  if (value instanceof ArrayBuffer) return markNormalized(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return markNormalized(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer,
    );
  }
  if (Array.isArray(value)) {
    return markNormalized(
      value.map((entry, index) => {
        if (entry === undefined) throw new Error(`undefined array element at ${path}[${index}]`);
        return normalizeCopyInner(entry, false, `${path}[${index}]`);
      }),
    );
  }
  if (!isSimpleObject(value)) throw new Error(`${path} must be a plain Convex object`);

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    assertFieldName(key, path);
    out[key] = normalizeCopyInner(v, false, `${path}.${key}`);
  }
  return markNormalized(out);
}

/**
 * Walks a value asserting it satisfies the Convex value constraints, allocating nothing.
 * Branded values short-circuit. Replaces the old encode-and-discard `assertValue`.
 *
 * @internal
 */
export function assertValueWalk(value: unknown, path: string): void {
  if (isNormalized(value)) return;
  assertValueInner(value, true, path);
}

function assertValueInner(value: unknown, topLevel: boolean, path: string): void {
  if (value === undefined) {
    if (!topLevel) throw new Error(`${path} is undefined, which is not a valid Convex value`);
    return;
  }
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
      return;
    case "bigint":
      if (value < MIN_INT64 || value > MAX_INT64) {
        throw new Error(`${path}: BigInt ${value} does not fit into a 64-bit signed integer.`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(`${path} is not a valid Convex value: unexpected ${typeof value}`);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (entry === undefined) throw new Error(`undefined array element at ${path}[${index}]`);
      assertValueInner(entry, false, `${path}[${index}]`);
    });
    return;
  }
  if (!isSimpleObject(value)) throw new Error(`${path} must be a plain Convex object`);
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    assertFieldName(key, path);
    assertValueInner(v, false, `${path}.${key}`);
  }
}

function assertFieldName(key: string, path: string): void {
  if (key.length > MAX_FIELD_NAME_LENGTH) {
    throw new Error(
      `${path}: field name ${key} exceeds maximum field name length ${MAX_FIELD_NAME_LENGTH}.`,
    );
  }
  if (key.startsWith("$")) {
    throw new Error(`${path}: field name ${key} starts with a '$', which is reserved.`);
  }
  for (let i = 0; i < key.length; i += 1) {
    const charCode = key.charCodeAt(i);
    if (charCode < 32 || charCode >= 127) {
      throw new Error(
        `${path}: field name ${key} has invalid character '${key[i]}': field names can only contain non-control ASCII characters`,
      );
    }
  }
}

/**
 * Revives one backend document in place after the page-level `JSON.parse`: every single-key
 * `$…` object is a Convex special form (`$integer`, `$bytes`, `$float` — user field names can
 * never start with `$`), and conversion of those leaves is delegated to `jsonToConvex`.
 * Everything else mutates in place: no copy, no per-document parse. Runs eagerly per page —
 * guards and predicates compare Convex values, so lazy revival would be a correctness hazard.
 *
 * @internal
 */
export function reviveDoc(doc: Record<string, unknown>): void {
  for (const key of Object.keys(doc)) {
    doc[key] = reviveValue(doc[key]);
  }
}

function reviveValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = reviveValue(value[i]);
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    return fromJson(record as JSONValue);
  }
  for (const key of keys) {
    record[key] = reviveValue(record[key]);
  }
  return record;
}

/**
 * Plain structural deep copy of an already-normalized tree (no validation, no stripping).
 * Used when handing staged documents to user code so mutation cannot reach staged state.
 *
 * @internal
 */
export function cloneTree<T>(value: T): T {
  return markNormalized(cloneTreeInner(value)) as T;
}

function cloneTreeInner(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return markNormalized(value.slice(0));
  if (Array.isArray(value)) return markNormalized(value.map(cloneTreeInner));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = cloneTreeInner(v);
  return markNormalized(out);
}

/**
 * Normalizes, validates, and copies a Convex object value through {@link normalizeCopy}.
 *
 * @internal
 */
export function normalizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const out = normalizeCopy(value);
  if (!isSimpleObject(out)) throw new Error("expected a Convex object");
  return out;
}

/**
 * Compares two Convex values for equality.
 *
 * @internal
 */
export function equals(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0;
}

/**
 * Orders two Convex values using Convex comparison semantics.
 *
 * @internal
 */
export function compare(a: unknown, b: unknown): number {
  return compareValues(a as Value | undefined, b as Value | undefined);
}

/**
 * Matches Convex's `isSimpleObject`: a plain object with a null prototype, `Object.prototype`, or
 * (for cross-realm values, e.g. another Node `vm` context) a prototype whose constructor is named
 * `"Object"`. Null-safe, and excludes arrays, `ArrayBuffer`s, and typed arrays — those are distinct
 * Convex value kinds with their own handling.
 *
 * @internal
 */
export function isSimpleObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return (
    prototype === null || prototype === Object.prototype || prototype.constructor?.name === "Object"
  );
}
