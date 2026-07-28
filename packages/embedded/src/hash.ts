import { convexToJson } from "convex/values";

export async function hashValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bytesHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashDocument(
  value: unknown,
  omittedFields: Iterable<string> = [],
): Promise<string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return hashValue(value);
  const {
    _id: _localOrHostedId,
    _creationTime: _localOrHostedCreationTime,
    ...rest
  } = value as Record<string, unknown>;
  const stable = structuredClone(rest);
  for (const field of omittedFields) deletePath(stable, field.split("."));
  return hashValue(stable);
}

function deletePath(value: Record<string, unknown>, path: string[]): void {
  const [head, ...tail] = path;
  if (head === undefined) return;
  if (tail.length === 0) {
    delete value[head];
    return;
  }
  const child = value[head];
  if (child !== null && typeof child === "object" && !Array.isArray(child)) {
    deletePath(child as Record<string, unknown>, tail);
  }
}

/**
 * Retained-result cache key inputs (Cut 7 §1). `argsKey` MUST reuse the same `canonicalJson(args)`
 * that forms the watch's subscription identity so watch and cache identity cannot drift.
 */
export interface ResultKey {
  functionPath: string;
  argsKey: string;
  identity: string;
  schemaHash: string;
  moduleGraphHash: string;
}

/** TS-authoritative retained-result storage key (Cut 7 §1/§14), threaded verbatim to the Rust apply. */
export async function resultCacheKey(key: ResultKey): Promise<string> {
  return hashValue({
    functionPath: key.functionPath,
    argsKey: key.argsKey,
    identity: key.identity,
    schemaHash: key.schemaHash,
    moduleGraphHash: key.moduleGraphHash,
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(convexToJson(value as never)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
