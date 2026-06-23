/**
 * Runtime resolution of declared `v.id("_storage")` field paths against hosted rows. The schema
 * object emits path strings; this pure module compiles them into segment matchers and reads the
 * hosted storage ids a row references, so the wrapper (live-row leg) and the component (rev-node
 * leg) share one extraction vocabulary with no `typescript` dependency.
 *
 * @packageDocumentation
 */

type StorageIdPathSegment =
  | { kind: "array" }
  | { kind: "field"; name: string }
  | { kind: "record" };

/** A compiled per-table set of storage-id paths, ready for {@link readStorageIds}. */
export type CompiledStorageIdPaths = StorageIdPathSegment[][];

/** The dereferenced/newly-referenced multisets between a prior and a new row (§3). */
export interface StorageIdDiff {
  dereferenced: string[];
  newlyReferenced: string[];
}

/** Compile path strings (`image`, `attachments[]`, `files{}`, `gallery[].assets{}`) into matchers. */
export function compileStorageIdPaths(paths: readonly string[]): CompiledStorageIdPaths {
  return paths.map((path) => compilePath(path));
}

function compilePath(path: string): StorageIdPathSegment[] {
  const segments: StorageIdPathSegment[] = [];
  let field = "";
  const pushField = () => {
    if (field.length === 0) return;
    segments.push({ kind: "field", name: field });
    field = "";
  };
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === "\\") {
      index += 1;
      if (index < path.length) field += path[index];
      continue;
    }
    if (char === ".") {
      pushField();
      continue;
    }
    if (char === "[" && path[index + 1] === "]") {
      pushField();
      segments.push({ kind: "array" });
      index += 1;
      continue;
    }
    if (char === "{" && path[index + 1] === "}") {
      pushField();
      segments.push({ kind: "record" });
      index += 1;
      continue;
    }
    field += char;
  }
  pushField();
  return segments;
}

/** Read every hosted storage id a row references at the compiled paths, with multiplicity. */
export function readStorageIds(
  row: Record<string, unknown> | null,
  compiled: CompiledStorageIdPaths,
): string[] {
  if (row === null || compiled.length === 0) return [];
  const ids: string[] = [];
  for (const path of compiled) walkStorageIdPath(row, path, 0, ids);
  return ids;
}

function walkStorageIdPath(
  value: unknown,
  path: StorageIdPathSegment[],
  index: number,
  out: string[],
): void {
  if (index === path.length) {
    if (typeof value === "string") out.push(value);
    return;
  }
  const segment = path[index];
  if (segment.kind === "array") {
    if (!Array.isArray(value)) return;
    for (const element of value) walkStorageIdPath(element, path, index + 1, out);
    return;
  }
  if (segment.kind === "record") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    for (const element of Object.values(value)) walkStorageIdPath(element, path, index + 1, out);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  walkStorageIdPath((value as Record<string, unknown>)[segment.name], path, index + 1, out);
}

/** Multiset difference: ids in `before` not in `after` (dereferenced) and the reverse (referenced). */
export function diffStorageIds(before: readonly string[], after: readonly string[]): StorageIdDiff {
  return {
    dereferenced: multisetSubtract(before, after),
    newlyReferenced: multisetSubtract(after, before),
  };
}

function multisetSubtract(left: readonly string[], right: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of right) counts.set(id, (counts.get(id) ?? 0) + 1);
  const remainder: string[] = [];
  for (const id of left) {
    const available = counts.get(id) ?? 0;
    if (available > 0) counts.set(id, available - 1);
    else remainder.push(id);
  }
  return remainder;
}
