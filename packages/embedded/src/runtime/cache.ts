import type { JSONValue } from "convex/values";
import type { ResultEntry, RuntimeStorageReader } from "../storage/types";
import { hashDocument } from "../hash";
import { pointerPart } from "../id/path";
import { fromJson } from "./codec";
import { tableFromId } from "./doc";

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
 * Read-authority accumulator for a local watch evaluation (Cut 7 §4.1/§4.5). It records the raw read
 * signals; the watch's disclosure — the rows the retained entry captured — decides authority after
 * the compute (a disclosure derived from an answer can never validate that answer). `foreign` is the
 * unconditional part: a full-table scan, an unindexed range, a count, or a point read that missed with
 * no resolvable id. A point read that missed a known local id records that id in {@link misses}; the
 * read path clears it only when the disclosure names that id as a locally dirty-deleted member (so a
 * dirty-deleted row keeps answering `null` locally instead of being resurrected by a cache-serve).
 *
 * @internal
 */
export interface ReadAuthority {
  foreign: boolean;
  readonly misses: ReadonlySet<string>;
  readPoint(present: boolean, id?: string): void;
  readRange(indexed: boolean): void;
  readCount(): void;
}

/** Builds a fresh {@link ReadAuthority} for one watch evaluation. @internal */
export function createReadAuthority(): ReadAuthority {
  const misses = new Set<string>();
  const authority: ReadAuthority = {
    foreign: false,
    misses,
    readPoint(present, id) {
      if (present) return;
      if (id === undefined) authority.foreign = true;
      else misses.add(id);
    },
    readRange(indexed) {
      if (!indexed) authority.foreign = true;
    },
    readCount() {
      authority.foreign = true;
    },
  };
  return authority;
}

/**
 * A retained entry's disclosure as local state (Cut 7 §4.2): the members it captured resolved to
 * local ids, the subset that resolve to a locally dirty-deleted row, a count of members with no local
 * twin (a device that cannot reproduce them), and clause C — whether every `_id`-bearing object in
 * the decoded skeleton is covered by a member path (an uncovered one is a server projection this
 * device cannot reconstruct).
 *
 * @internal
 */
export interface Disclosure {
  members: Set<string>;
  deletedMembers: Set<string>;
  unmapped: number;
  covered: boolean;
}

/** Reads an entry's {@link Disclosure} against local id state. @internal */
export async function readDisclosure(
  entry: ResultEntry,
  store: RuntimeStorageReader,
): Promise<Disclosure> {
  const rows = decodePaths(entry.paths);
  const members = new Set<string>();
  const deletedMembers = new Set<string>();
  let unmapped = 0;
  const localByTable = new Map<string, Map<string, { localId: string; deleted: boolean }>>();
  for (const row of rows) {
    if (!localByTable.has(row.table)) {
      const reverse = new Map<string, { localId: string; deleted: boolean }>();
      for (const mapping of (await store.id?.page.read(row.table)) ?? []) {
        const convexId =
          mapping.mapping === "mapped" || mapping.mapping === "deleted"
            ? mapping.convexId
            : undefined;
        if (convexId !== undefined) {
          reverse.set(convexId, {
            localId: mapping.localId,
            deleted: mapping.mapping === "deleted",
          });
        }
      }
      localByTable.set(row.table, reverse);
    }
    const local = localByTable.get(row.table)?.get(row.rowId);
    if (local === undefined) {
      unmapped += 1;
      continue;
    }
    members.add(local.localId);
    if (local.deleted) deletedMembers.add(local.localId);
  }
  return { members, deletedMembers, unmapped, covered: coversSkeleton(entry, rows) };
}

/**
 * CRDT field names per table, omitted from the optimism compare. A clean row's retained base and
 * materialized doc can disagree byte-for-byte on a CRDT field: the server never materializes one, so
 * the base's copy is patched in — and dropped again on a projection re-pull — independently of the
 * doc's (`crates/storage/src/store/mod.rs`). Comparing them would read a clean row as false optimism.
 *
 * @internal
 */
export type CrdtFieldsByTable = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Clause B (Cut 7 §4.5): does the watch's local output agree with its disclosure, both as local ids?
 * The two directions share one predicate. Completeness — every disclosed member appears in the output,
 * or is an optimistic row whose pending local edit moved it out of range (a dirty delete or a dirty
 * field edit); an unmapped member can never appear, so any breaks agreement. Soundness — every output
 * id is a disclosed member, a local-only row (no hosted mapping), or a row with a pending local edit; a
 * clean mapped row the server did not disclose means the entry is stale and the watch must defer.
 *
 * @internal
 */
export async function outputAgrees(
  disclosure: Disclosure,
  outputIds: ReadonlySet<string>,
  store: RuntimeStorageReader,
  crdtFields: CrdtFieldsByTable,
): Promise<boolean> {
  if (disclosure.unmapped > 0) return false;
  for (const member of disclosure.members) {
    if (
      !outputIds.has(member) &&
      !(await isOptimisticRow(store, tableFromId(member), member, crdtFields))
    ) {
      return false;
    }
  }
  for (const id of outputIds) {
    if (disclosure.members.has(id)) continue;
    if (!(await isOptimisticRow(store, tableFromId(id), id, crdtFields))) return false;
  }
  return true;
}

/**
 * Clause C variant for an uncovered projection (Cut 7 §4.5): the entry carries a server projection
 * this device cannot reconstruct, so the local compute may stand in for it only when it holds optimism
 * the entry would erase — a local-only or dirty-edited output row, or a disclosed member the device
 * dirty-deleted (dropped from the projection). A fully-clean projection holds none and yields to the
 * entry, so a server change to an unprojected field still re-discloses (no server-update loss). The
 * pure-projection dirty-delete case (paths=∅ ⇒ no disclosed members) is unreachable here and defers,
 * exactly as it did before this clause: a member-free projection has no dirty-deleted member to find.
 *
 * @internal
 */
export async function hasLocalOptimism(
  disclosure: Disclosure,
  outputIds: ReadonlySet<string>,
  store: RuntimeStorageReader,
  crdtFields: CrdtFieldsByTable,
): Promise<boolean> {
  if (disclosure.deletedMembers.size > 0) return true;
  for (const id of outputIds) {
    if (await isOptimisticRow(store, tableFromId(id), id, crdtFields)) return true;
  }
  return false;
}

/**
 * Does a mapped output/member row carry a pending local edit the server has not re-disclosed? A row
 * with no hosted mapping (a local-only create) or no retained base is optimistic outright. Otherwise
 * the current materialized doc is compared to its last accepted base over app-plain fields only:
 * {@link hashDocument} drops `_id`/`_creationTime` — the base carries the HOSTED id, the doc its local
 * twin (`crates/remote/src/codec.rs`) — and {@link CrdtFieldsByTable} omits the table's CRDT fields,
 * whose base and doc bytes can diverge for a clean row. Without the strip, every clean mapped row reads
 * as optimistic and the watch serves stale local state forever instead of the newer server entry.
 */
async function isOptimisticRow(
  store: RuntimeStorageReader,
  table: string,
  id: string,
  crdtFields: CrdtFieldsByTable,
): Promise<boolean> {
  const mapping = await store.id?.read(table, id);
  if (mapping === undefined || mapping.mapping === "local") return true;
  const base = await store.doc.base?.read(table, id);
  if (base === undefined) return true;
  const current = await store.doc.read(table, id);
  const omitted = crdtFields.get(table) ?? [];
  return (await hashDocument(current ?? null, omitted)) !== (await hashDocument(base, omitted));
}

function coversSkeleton(entry: ResultEntry, rows: ResultRow[]): boolean {
  const covered = new Set(rows.map((row) => row.path));
  return !uncoveredId(decodeSkeleton(entry.skeleton), "", covered);
}

function uncoveredId(value: unknown, pointer: string, covered: ReadonlySet<string>): boolean {
  if (value === null || typeof value !== "object" || value instanceof ArrayBuffer) return false;
  if (Array.isArray(value)) {
    return value.some((child, index) => uncoveredId(child, `${pointer}/${index}`, covered));
  }
  const record = value as Record<string, unknown>;
  if (typeof record._id === "string") return !covered.has(pointer);
  return Object.entries(record).some(([key, child]) =>
    uncoveredId(child, `${pointer}/${pointerPart(key)}`, covered),
  );
}
