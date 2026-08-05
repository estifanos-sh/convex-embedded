import { CommitTsPlaceholder, jsonToConvex } from "convex/values";
import type { JSONValue } from "convex/values";

/**
 * The one process-wide placeholder used by the embedded mutation runtime.
 *
 * Convex deliberately keeps the value behind `db.vars`, rather than letting
 * callers construct it. Recovering the singleton through the public JSON
 * codec keeps us on the same package instance as authored Convex code.
 *
 * @internal
 */
export const commitTsPlaceholder = jsonToConvex({
  $commitTs: null,
} as JSONValue) as CommitTsPlaceholder;

const pendingTrees = new WeakSet<object>();
const MAX_INT64 = (1n << 63n) - 1n;

/** True only for the singleton issued by `db.vars.commitTs`. @internal */
export function isPendingCommitTs(value: unknown): value is CommitTsPlaceholder {
  return value === commitTsPlaceholder;
}

/** Records that a normalized container contains the singleton. @internal */
export function markPendingTree<T>(value: T, pending: boolean): T {
  if (pending && typeof value === "object" && value !== null) pendingTrees.add(value);
  return value;
}

/**
 * Constant-time after normalization. Untrusted values have not been branded,
 * so callers must normalize before relying on this predicate.
 *
 * @internal
 */
export function hasPendingCommitTs(value: unknown): boolean {
  return (
    isPendingCommitTs(value) ||
    (typeof value === "object" && value !== null && pendingTrees.has(value))
  );
}

/** The physical index value for an unresolved timestamp. @internal */
export function projectPendingCommitTs(value: unknown): unknown {
  return isPendingCommitTs(value) ? MAX_INT64 : value;
}

/** Rejects a marker in a surface that cannot defer resolution until commit. @internal */
export function assertNoPendingCommitTs(value: unknown, surface: string): void {
  if (!hasPendingCommitTs(value)) return;
  throw new Error(`${surface} cannot contain db.vars.commitTs outside a mutation write.`);
}

/**
 * Resolves only containers known to carry the marker. A literal `MAX_INT64`
 * remains a literal `MAX_INT64`; this is why the marker never becomes a
 * bigint before the storage transaction allocates its timestamp.
 *
 * @internal
 */
export function resolvePendingCommitTs<T>(value: T, timestamp: bigint): T {
  if (!hasPendingCommitTs(value)) return value;
  return resolve(value, timestamp) as T;
}

/** Resolve a payload whose typed ABI flag already proves it contains the marker. @internal */
export function resolveKnownPendingCommitTs<T>(value: T, timestamp: bigint): T {
  return resolveKnown(value, timestamp) as T;
}

function resolve(value: unknown, timestamp: bigint): unknown {
  if (isPendingCommitTs(value)) return timestamp;
  if (!hasPendingCommitTs(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, timestamp));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolve(entry, timestamp);
    return out;
  }
  return value;
}

function resolveKnown(value: unknown, timestamp: bigint): unknown {
  if (isPendingCommitTs(value)) return timestamp;
  if (Array.isArray(value)) return value.map((entry) => resolveKnown(entry, timestamp));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveKnown(entry, timestamp);
    return out;
  }
  return value;
}
