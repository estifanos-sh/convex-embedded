import type { JSONValue } from "convex/values";
import type { ResultEntry, RuntimeStorageReader } from "../storage/types";
import { fromJson } from "./codec";

/**
 * One entry in a retained result's `resultRows`: the RFC-6901 pointer into the skeleton, the row's
 * table, and its HOSTED id (resolved to a local id through the existing id map at reconstruction).
 *
 * @internal
 */
export interface ResultRow {
  path: string;
  table: string;
  rowId: string;
}

/**
 * Decodes the stored skeleton bytes (Cut 7 §3): canonical Convex-value JSON produced by the S3 apply,
 * decoded through the same value codec used for row fields so Int64/Bytes leaves survive.
 *
 * @internal
 */
export function decodeSkeleton(bytes: Uint8Array): unknown {
  return fromJson(JSON.parse(new TextDecoder().decode(bytes)) as JSONValue);
}

/** Decodes the stored `resultRows` bytes (a canonical JSON array of `{path,table,rowId}`). @internal */
export function decodePaths(bytes: Uint8Array): ResultRow[] {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    const row = entry as Record<string, unknown>;
    return { path: String(row.path), table: String(row.table), rowId: String(row.rowId) };
  });
}

/**
 * Reconstructs a retained result's authored value against local row state (Cut 7 §4.3). Each
 * `resultRow` resolves its hosted id to a local id, then splices at its pointer: a present row (clean
 * or dirty-edited) contributes its current local projection; a locally dirty-deleted row contributes
 * its durably retained last accepted base. An absent, non-dirty-deleted referenced row is a storage
 * invariant fault — the entry can only reference rows that shipped, and stopping a watch deletes its
 * entry with its edges, so no reference can dangle while the entry exists.
 *
 * @internal
 */
export async function reconstruct(
  entry: ResultEntry,
  store: RuntimeStorageReader,
): Promise<unknown> {
  const skeleton = decodeSkeleton(entry.skeleton);
  const rows = decodePaths(entry.paths);
  if (rows.length === 0) return skeleton;
  const localByTable = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (localByTable.has(row.table)) continue;
    const reverse = new Map<string, string>();
    for (const mapping of (await store.id?.page.read(row.table)) ?? []) {
      const convexId =
        mapping.mapping === "mapped" || mapping.mapping === "deleted"
          ? mapping.convexId
          : undefined;
      if (convexId !== undefined) reverse.set(convexId, mapping.localId);
    }
    localByTable.set(row.table, reverse);
  }
  let root = skeleton;
  for (const row of rows) {
    const localId = localByTable.get(row.table)?.get(row.rowId);
    if (localId === undefined) {
      throw new Error(
        `retained result references unmapped row ${row.table}/${row.rowId}: storage invariant`,
      );
    }
    const value = await resolveReferencedRow(store, row.table, localId);
    root = splicePointer(root, row.path, value);
  }
  return root;
}

async function resolveReferencedRow(
  store: RuntimeStorageReader,
  table: string,
  localId: string,
): Promise<unknown> {
  const current = await store.doc.read(table, localId);
  if (current !== undefined) return current;
  const base = await store.doc.base?.read(table, localId);
  if (base !== undefined) return base;
  throw new Error(
    `retained result references absent non-dirty-deleted row ${table}/${localId}: storage invariant`,
  );
}

/**
 * Splices `value` into `root` at an RFC-6901 JSON Pointer [RFC-6901]. Navigates the skeleton it
 * decoded (never a live structure); the empty pointer replaces the whole value.
 *
 * @internal
 */
export function splicePointer(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = Array.isArray(parent)
      ? parent[Number(part)]
      : (parent as Record<string, unknown>)[part];
  }
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) parent[Number(last)] = value;
  else (parent as Record<string, unknown>)[last] = value;
  return root;
}

/**
 * Read-authority accumulator for a local watch evaluation (Cut 7 §4.1/§4.5). Any read that steps
 * outside the watch's own authoritative disclosure sets `foreign`; the read path then cache-serves.
 * Conservative: a full-table scan, a count, a search, a range that returns a non-member row, or a
 * point read that missed all mark foreign. Present authoritative point reads and index ranges over
 * only the watch's own members stay non-foreign so their local dirty edits remain visible.
 *
 * @internal
 */
export interface ReadAuthority {
  foreign: boolean;
  readPoint(present: boolean): void;
  readRange(ids: readonly string[], indexed: boolean): void;
  readCount(): void;
  readSearch(): void;
}

/** Builds a {@link ReadAuthority} scoped to the watch's own authoritative member set. @internal */
export function createReadAuthority(members: ReadonlySet<string>): ReadAuthority {
  const authority: ReadAuthority = {
    foreign: false,
    readPoint(present) {
      if (!present) authority.foreign = true;
    },
    readRange(ids, indexed) {
      if (!indexed || ids.some((id) => !members.has(id))) authority.foreign = true;
    },
    readCount() {
      authority.foreign = true;
    },
    readSearch() {
      authority.foreign = true;
    },
  };
  return authority;
}
