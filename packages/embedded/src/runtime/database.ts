import type { GenericDataModel, TableNamesInDataModel, WithoutSystemFields } from "convex/server";
import type {
  ColEntries,
  CrdtOp,
  CrdtRestore,
  FileSurface,
  DeleteIn,
  IdMapping,
  OneDocWriteCommit,
  RuntimeStorageReader,
  RuntimeStorageWriter,
  StoreSchema,
  TableDef,
  DocWrite,
  WriteBatch,
} from "../storage/types";
import { hashDocument, hashValue } from "../hash";
import { cloneTree, equals } from "./codec";
import {
  assertFiniteDelta,
  assertIntentField,
  assertTextBase,
  hasUnpairedSurrogate,
  isHighSurrogate,
  isLowSurrogate,
  validateCountAdd,
  validateSetField,
  validateTextSplice,
} from "../crdt/intent";
import type { Doc, Id } from "./model";
import { type Query, QueryBuilder, type QueryOverlay, type ReadTracker } from "./query";
import { validateJson } from "./validate";
import {
  assertNoSystemFieldConflict,
  createId,
  dataOf,
  extractColEntries,
  isLocalIdForTable,
  isLocalIdShape,
  materialize,
  type RawDoc,
  type StagedDoc,
  tableFromId,
} from "./doc";
import { assertNoPendingCommitTs, commitTsPlaceholder, hasPendingCommitTs } from "./pending";

/**
 * Runtime lookup map for storage table definitions.
 *
 * @internal
 */
export type Schema = Map<string, TableDef>;

/**
 * Converts a storage schema array into a runtime lookup map.
 *
 * @internal
 */
export function toSchema(schema: StoreSchema): Schema {
  return new Map(schema.tables.map((t) => [t.name, t]));
}

/**
 * Local implementation of Convex's database reader surface.
 *
 * @internal
 */
export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends TableNamesInDataModel<DM>>(table: T, id: Id<T>): Promise<Doc<DM, T> | null>;
  get<T extends TableNamesInDataModel<DM>>(id: Id<T>): Promise<Doc<DM, T> | null>;
  normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null;
  query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T>;
  system: DatabaseReader<DM>;
  table<T extends TableNamesInDataModel<DM>>(
    table: T,
  ): {
    get(id: Id<T>): Promise<Doc<DM, T> | null>;
    query(): Query<DM, T>;
  };
}

/**
 * Local implementation of Convex's database writer surface.
 *
 * @internal
 */
export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  /** Values assigned atomically by the durable transaction. */
  vars: { readonly commitTs: import("convex/values").CommitTsPlaceholder };
  count: {
    add<T extends TableNamesInDataModel<DM>>(
      table: T,
      id: Id<T>,
      field: string,
      delta: number,
    ): Promise<void>;
  };
  insert<T extends TableNamesInDataModel<DM>>(
    table: T,
    value: WithoutSystemFields<Doc<DM, T>>,
  ): Promise<Id<T>>;
  patch<T extends TableNamesInDataModel<DM>>(
    id: Id<T>,
    partial: Partial<WithoutSystemFields<Doc<DM, T>>>,
  ): Promise<void>;
  patch<T extends TableNamesInDataModel<DM>>(
    table: T,
    id: Id<T>,
    partial: Partial<WithoutSystemFields<Doc<DM, T>>>,
  ): Promise<void>;
  replace<T extends TableNamesInDataModel<DM>>(
    id: Id<T>,
    value: WithoutSystemFields<Doc<DM, T>>,
  ): Promise<void>;
  replace<T extends TableNamesInDataModel<DM>>(
    table: T,
    id: Id<T>,
    value: WithoutSystemFields<Doc<DM, T>>,
  ): Promise<void>;
  set: {
    add<T extends TableNamesInDataModel<DM>>(
      table: T,
      id: Id<T>,
      field: string,
      value: unknown,
    ): Promise<void>;
    delete<T extends TableNamesInDataModel<DM>>(
      table: T,
      id: Id<T>,
      field: string,
      value: unknown,
    ): Promise<void>;
  };
  text: {
    splice<T extends TableNamesInDataModel<DM>>(
      table: T,
      id: Id<T>,
      field: string,
      change: { delete: number; index: number; insert: string; base?: string },
    ): Promise<void>;
  };
  delete(id: Id<TableNamesInDataModel<DM>>): Promise<void>;
  delete<T extends TableNamesInDataModel<DM>>(table: T, id: Id<T>): Promise<void>;
  table<T extends TableNamesInDataModel<DM>>(
    table: T,
  ): {
    delete(id: Id<T>): Promise<void>;
    get(id: Id<T>): Promise<Doc<DM, T> | null>;
    insert(value: WithoutSystemFields<Doc<DM, T>>): Promise<Id<T>>;
    patch(id: Id<T>, partial: Partial<WithoutSystemFields<Doc<DM, T>>>): Promise<void>;
    query(): Query<DM, T>;
    replace(id: Id<T>, value: WithoutSystemFields<Doc<DM, T>>): Promise<void>;
  };
}

function tableDef(schema: Schema, table: string): TableDef {
  const def = schema.get(table);
  if (!def) throw new Error(`unknown table: ${table}`);
  return def;
}

function assertViewTable(def: TableDef, view: "replicated" | "device"): void {
  if (view === "replicated" && def.placement !== "replicated") {
    throw new Error(`Replicated functions cannot access device table ${def.name}.`);
  }
}

function assertLocalFieldPatch(def: TableDef, partial: Record<string, unknown>): void {
  const local = new Map((def.localFields ?? []).map((field) => [field.field, field]));
  const forbidden = Object.keys(partial).find((field) => !local.has(field));
  if (forbidden !== undefined) {
    throw new Error(`Local functions cannot write replicated field ${def.name}.${forbidden}.`);
  }
  for (const [field, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    validateJson(value, local.get(field)!.validator, `${def.name}.${field}`);
  }
}

function assertNoLocalFields(def: TableDef, data: Record<string, unknown>): void {
  if (def.placement !== "replicated") return;
  const forbidden = (def.localFields ?? []).find(({ field }) => Object.hasOwn(data, field));
  if (forbidden !== undefined) {
    throw new Error(
      `Replicated document write contains device-only field ${def.name}.${forbidden.field}.`,
    );
  }
}

function colsEqual(
  left: readonly [string, unknown][],
  right: readonly [string, unknown][],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    if (l[0] !== r[0] || !equals(l[1], r[1])) return false;
  }
  return true;
}

function explicitCrdtField(
  def: TableDef,
  field: string,
): NonNullable<TableDef["crdtFields"]>[number] | undefined {
  return def.crdtFields?.find((candidate) => candidate.field === field);
}

function assertCrdtField(def: TableDef, field: string, kind: "count" | "set" | "text"): void {
  assertIntentField(def.name, field, kind, explicitCrdtField(def, field)?.kind);
}

function assertNoExplicitCrdtWrite(
  def: TableDef,
  operation: "patch" | "replace",
  value: Record<string, unknown>,
): void {
  const fields = def.crdtFields ?? [];
  if (!fields.length) return;
  if (operation === "replace") {
    throw new Error(
      `replace cannot write embedded CRDT fields on ${def.name}; use ctx.db.count/set/text intent APIs`,
    );
  }
  const patched = new Set(Object.keys(value));
  const blocked = fields.find((field) => patched.has(field.field.split(".")[0]!));
  if (blocked) {
    throw new Error(
      `patch cannot write embedded ${blocked.kind} field ${def.name}.${blocked.field}; use ctx.db.${blocked.kind} intent APIs`,
    );
  }
}

function patchTouchesIndexedColumn(def: TableDef, partial: Record<string, unknown>): boolean {
  if (def.columns.length === 0) return false;
  const patched = new Set(Object.keys(partial));
  return def.columns.some((column) => patched.has((column.field ?? column.name).split(".")[0]!));
}

async function crdtReadWitnesses(
  store: RuntimeStorageReader,
  def: TableDef,
  document: Record<string, unknown> | undefined,
) {
  if (document === undefined) return [];
  return await Promise.all(
    (def.crdtFields ?? []).map(async ({ field }) => ({
      field,
      epoch: 0,
      headSeq: (await store.doc.crdt.read(def.name, String(document._id), field)) ?? 0,
      projectionHash: await hashValue(valueAtPath(document, field) ?? null),
    })),
  );
}

/**
 * Creates a database reader bound to runtime storage.
 *
 * @internal
 */
export function createReader<DM extends GenericDataModel>(
  store: RuntimeStorageReader & Partial<{ file: FileSurface }>,
  schema: Schema,
  tracker?: ReadTracker,
  view: "replicated" | "device" = "replicated",
): DatabaseReader<DM> {
  const reader: DatabaseReader<DM> = {
    async get<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      maybeId?: Id<T>,
    ): Promise<Doc<DM, T> | null> {
      const { table, id } = getArgs(tableOrId as string, maybeId as string | undefined);
      if (table === "" && store.remote !== undefined && !isLocalIdShape(id)) {
        tracker?.authority?.readPoint(false);
        return null;
      }
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      tracker?.table(table);
      const readPoint = async (localId: string): Promise<Doc<DM, T> | null> => {
        tracker?.doc?.(localId);
        const stored = await store.doc.read(table, localId);
        tracker?.authority?.readPoint(stored !== undefined && stored !== null, localId);
        const version = stored ? ((await store.doc.version.read(table, localId)) ?? 0) : 0;
        tracker?.point?.({
          table,
          id: localId,
          version,
          crdt: await crdtReadWitnesses(store, def, stored),
          contentHash: await hashDocument(
            stored ?? null,
            (def.crdtFields ?? []).map((field) => field.field),
          ),
        });
        if (!stored) return null;
        const fields =
          view === "device" && def.placement === "replicated"
            ? await store.doc.device?.read(table, localId)
            : undefined;
        return { ...stored, ...fields } as unknown as Doc<DM, T>;
      };
      if (isLocalIdForTable(table, id)) return readPoint(id);
      if (isLocalIdShape(id)) {
        throw new Error(`get: id does not belong to table ${table}`);
      }
      if (store.remote !== undefined) {
        const localId = await hostedToLocal(store, table, id);
        if (localId !== undefined) return readPoint(localId);
      }
      tracker?.authority?.readPoint(false);
      return null;
    },
    normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null {
      return isLocalIdForTable(table, id) ? (id as Id<T>) : null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      return new QueryBuilder<DM, T>(store, def, undefined, tracker, {}, view);
    },
    get system(): DatabaseReader<DM> {
      return systemReader<DM>(store);
    },
    table<T extends TableNamesInDataModel<DM>>(table: T) {
      assertViewTable(tableDef(schema, table), view);
      return {
        get: (id: Id<T>) => reader.get(table, id),
        query: () => reader.query(table),
      };
    },
  } satisfies DatabaseReader<DM>;
  return reader;
}

/**
 * Creates a staged database writer and exposes the resulting write batch.
 *
 * @internal
 */
export function createWriter<DM extends GenericDataModel>(
  store: RuntimeStorageWriter & Partial<{ file: FileSurface }>,
  schema: Schema,
  tracker?: ReadTracker,
  view: "replicated" | "device" = "replicated",
): {
  db: DatabaseWriter<DM>;
  crdtRestore(restore: CrdtRestore): void;
  revisionRestore(expectation: {
    table: string;
    rowId: string;
    deleted: boolean;
    value?: Record<string, unknown>;
  }): void;
  restoreDocument(
    table: string,
    id: string,
    value: Record<string, unknown>,
    creationTime: number,
    existingMapping?: IdMapping,
  ): void;
  restore(snapshot: WriterSnapshot): void;
  snapshot(): WriterSnapshot;
  oneDocWrite: () => OneDocWriteCommit | undefined;
  toBatch: () => WriteBatch;
} {
  const docWritesByTable = new Map<
    string,
    Map<string, { crdtOnly: boolean; dataOnly: boolean; input: DocWrite; doc: StagedDoc }>
  >();
  const deletesByTable = new Map<string, Set<string>>();
  const crdtOps: CrdtOp[] = [];
  const crdtRestores: CrdtRestore[] = [];
  const freshIds: DeleteIn[] = [];
  const idMappings: IdMapping[] = [];
  const localFieldWrites = new Map<
    string,
    {
      table: string;
      id: string;
      field: string;
      value: unknown;
      pendingCommitTs?: true;
    }
  >();
  const localFieldDeletes = new Map<string, { table: string; id: string; field: string }>();
  const deviceViewsByTable = new Map<string, Map<string, RawDoc>>();
  const revisionRestores = new Map<
    string,
    { table: string; rowId: string; deleted: boolean; value?: Record<string, unknown> }
  >();
  // Updated at each staging transition so the ordinary commit path never rescans payload trees.
  let pendingCommitTsCount = 0;

  const tableUpserts = (
    table: string,
  ): Map<string, { crdtOnly: boolean; dataOnly: boolean; input: DocWrite; doc: StagedDoc }> => {
    let map = docWritesByTable.get(table);
    if (!map) {
      map = new Map();
      docWritesByTable.set(table, map);
    }
    return map;
  };

  const tableDeletes = (table: string): Set<string> => {
    let set = deletesByTable.get(table);
    if (!set) {
      set = new Set();
      deletesByTable.set(table, set);
    }
    return set;
  };

  const stage = (
    def: TableDef,
    id: string,
    data: Record<string, unknown>,
    creationTime: number,
    options: { cols?: ColEntries; crdtOnly?: boolean; dataOnly?: boolean } = {},
  ): void => {
    assertNoLocalFields(def, data);
    if (def.document) validateJson(data, def.document, def.name);
    deletesByTable.get(def.name)?.delete(id);
    const docWrites = tableUpserts(def.name);
    const previous = docWrites.get(id);
    const pendingCommitTs = hasPendingCommitTs(data);
    if (previous?.input.pendingCommitTs === true) pendingCommitTsCount -= 1;
    if (pendingCommitTs) pendingCommitTsCount += 1;
    docWrites.set(id, {
      crdtOnly: options.crdtOnly === true && previous?.crdtOnly !== false,
      dataOnly: options.dataOnly === true,
      input: {
        table: def.name,
        id,
        data,
        cols: options.cols ?? (options.dataOnly === true ? [] : extractColEntries(def, data)),
        creationTime,
        ...(pendingCommitTs ? { pendingCommitTs: true } : {}),
      },
      doc: { _id: id, _creationTime: creationTime, data },
    });
  };

  const read = async (id: string): Promise<RawDoc | null> => {
    const table = tableFromId(id);
    const def = tableDef(schema, table);
    assertViewTable(def, view);
    if (deletesByTable.get(table)?.has(id)) return null;
    const deviceView = deviceViewsByTable.get(table)?.get(id);
    if (deviceView) return cloneTree(deviceView);
    const staged = docWritesByTable.get(table)?.get(id);
    if (staged) return cloneTree(materialize(staged.doc));
    tracker?.doc?.(id);
    const stored = await store.doc.read(table, id);
    const version = stored ? ((await store.doc.version.read(table, id)) ?? 0) : 0;
    tracker?.point?.({
      table,
      id,
      version,
      crdt: await crdtReadWitnesses(store, def, stored),
      contentHash: await hashDocument(
        stored ?? null,
        (def.crdtFields ?? []).map((field) => field.field),
      ),
    });
    if (!stored) return null;
    const fields =
      view === "device" && def.placement === "replicated"
        ? await store.doc.device?.read(table, id)
        : undefined;
    return { ...stored, ...fields };
  };

  const overlayFor = (table: string): QueryOverlay => ({
    staged: [
      ...[...(docWritesByTable.get(table)?.values() ?? [])].map((e) =>
        cloneTree(materialize(e.doc)),
      ),
      ...[...(deviceViewsByTable.get(table)?.values() ?? [])].map((doc) => cloneTree(doc)),
    ],
    deleted: deletesByTable.get(table) ?? EMPTY_DELETES,
  });

  const db: DatabaseWriter<DM> = {
    vars: { commitTs: commitTsPlaceholder },
    count: {
      async add(
        table: TableNamesInDataModel<DM>,
        id: Id<TableNamesInDataModel<DM>>,
        field: string,
        delta: number,
      ): Promise<void> {
        if (view === "device")
          throw new Error("Local functions cannot write replicated CRDT fields.");
        if (tableFromId(id) !== table) throw new Error(`count.add: id is not in ${table}`);
        const def = tableDef(schema, table);
        assertCrdtField(def, field, "count");
        assertFiniteDelta(table, field, delta);
        const current = await read(id);
        const decision = validateCountAdd(table, id, field, current, delta);
        if (!decision.consume) return;
        stage(
          def,
          id,
          dataOf(withValueAtPath(current!, field, decision.next)),
          current!._creationTime,
          {
            crdtOnly: true,
          },
        );
        crdtOps.push({ table, id, field, kind: "count.add", delta });
      },
    },
    async get<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      maybeId?: Id<T>,
    ): Promise<Doc<DM, T> | null> {
      const { table, id: parsedId } = getArgs(tableOrId as string, maybeId as string | undefined);
      if (isLocalIdForTable(table, parsedId)) {
        return (await read(parsedId)) as unknown as Doc<DM, T> | null;
      }
      if (isLocalIdShape(parsedId)) {
        throw new Error(`get: id does not belong to table ${table}`);
      }
      return null;
    },
    normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null {
      return isLocalIdForTable(table, id) ? (id as Id<T>) : null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      return new QueryBuilder<DM, T>(store, def, () => overlayFor(table), tracker, {}, view);
    },
    get system(): DatabaseReader<DM> {
      return systemReader<DM>(store);
    },
    table<T extends TableNamesInDataModel<DM>>(table: T) {
      assertViewTable(tableDef(schema, table), view);
      return {
        delete: (id: Id<T>) => db.delete(table, id),
        get: (id: Id<T>) => db.get(table, id),
        insert: (value: WithoutSystemFields<Doc<DM, T>>) => db.insert(table, value),
        patch: (id: Id<T>, partial: Partial<WithoutSystemFields<Doc<DM, T>>>) =>
          db.patch(table, id, partial),
        query: () => db.query(table),
        replace: (id: Id<T>, value: WithoutSystemFields<Doc<DM, T>>) =>
          db.replace(table, id, value),
      };
    },
    insert<T extends TableNamesInDataModel<DM>>(
      table: T,
      value: WithoutSystemFields<Doc<DM, T>>,
    ): Promise<Id<T>> {
      const id = createId(table);
      assertNoSystemFieldConflict("insert", value as Record<string, unknown>);
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      if (view === "device" && def.placement !== "device") {
        throw new Error(`Local functions cannot insert replicated table ${String(table)}.`);
      }
      assertCrdtInitialValues(def, value as Record<string, unknown>);
      const creationTime = store.clock.read();
      if (view === "replicated") {
        freshIds.push({ table, id });
        idMappings.push({
          table,
          localId: id,
          mapping: "local",
          createdTime: creationTime,
          updatedTime: creationTime,
        });
      }
      stage(def, id, dataOf(value as Record<string, unknown>), creationTime);
      return Promise.resolve(id as Id<T>);
    },
    async patch<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      idOrPartial: Id<T> | Partial<WithoutSystemFields<Doc<DM, T>>>,
      maybePartial?: Partial<WithoutSystemFields<Doc<DM, T>>>,
    ): Promise<void> {
      const { table, id } = writeArgs(tableOrId as string, idOrPartial, maybePartial);
      if (tableFromId(id) !== table) throw new Error(`patch: id does not belong to table ${table}`);
      const current = await read(id);
      if (!current) throw new Error(`patch: document not found: ${id}`);
      const partial = (maybePartial ?? idOrPartial) as Record<string, unknown>;
      assertNoSystemFieldConflict("patch", partial, { creationTime: current._creationTime, id });
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      if (view === "device" && def.placement === "replicated") {
        assertLocalFieldPatch(def, partial);
        const local = new Set((def.localFields ?? []).map(({ field }) => field));
        for (const [field, value] of Object.entries(partial)) {
          if (!local.has(field)) continue;
          const key = `${table}\u0000${id}\u0000${field}`;
          if (value === undefined) {
            if (localFieldWrites.get(key)?.pendingCommitTs === true) pendingCommitTsCount -= 1;
            localFieldWrites.delete(key);
            localFieldDeletes.set(key, { table, id, field });
          } else {
            localFieldDeletes.delete(key);
            const pendingCommitTs = hasPendingCommitTs(value);
            if (localFieldWrites.get(key)?.pendingCommitTs === true) pendingCommitTsCount -= 1;
            if (pendingCommitTs) pendingCommitTsCount += 1;
            localFieldWrites.set(key, {
              table,
              id,
              field,
              value: cloneTree(value),
              ...(pendingCommitTs ? { pendingCommitTs: true } : {}),
            });
          }
        }
        const next = { ...current, ...partial };
        for (const [field, value] of Object.entries(partial)) {
          if (value === undefined) delete next[field];
        }
        let views = deviceViewsByTable.get(table);
        if (!views) deviceViewsByTable.set(table, (views = new Map()));
        views.set(id, next);
        return;
      }
      assertNoExplicitCrdtWrite(def, "patch", partial);
      const merged = { ...current, ...partial };
      const mergedData = dataOf(merged);
      const previous = docWritesByTable.get(table)?.get(id);
      if (!patchTouchesIndexedColumn(def, partial)) {
        const fresh = freshIds.some((row) => row.table === table && row.id === id);
        const previousCols =
          previous && !previous.dataOnly && Array.isArray(previous.input.cols)
            ? previous.input.cols
            : undefined;
        stage(def, id, mergedData, current._creationTime, {
          cols: previousCols,
          dataOnly: view === "replicated" && !fresh && !previousCols,
        });
        return;
      }
      const mergedCols = extractColEntries(def, mergedData);
      stage(def, id, mergedData, current._creationTime, {
        cols: mergedCols,
        dataOnly: colsEqual(extractColEntries(def, current), mergedCols),
      });
    },
    async replace<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      idOrValue: Id<T> | WithoutSystemFields<Doc<DM, T>>,
      maybeValue?: WithoutSystemFields<Doc<DM, T>>,
    ): Promise<void> {
      const { table, id } = writeArgs(tableOrId as string, idOrValue, maybeValue);
      if (tableFromId(id) !== table)
        throw new Error(`replace: id does not belong to table ${table}`);
      const current = await read(id);
      if (!current) throw new Error(`replace: document not found: ${id}`);
      const value = (maybeValue ?? idOrValue) as Record<string, unknown>;
      assertNoSystemFieldConflict("replace", value, { creationTime: current._creationTime, id });
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      if (view === "device" && def.placement === "replicated") {
        throw new Error(`Local functions cannot replace replicated table ${table}.`);
      }
      const restore = revisionRestores.get(`${table}\u0000${id}`);
      const allowedRestore =
        restore !== undefined &&
        !restore.deleted &&
        equals(dataOf(value), restore.value as Record<string, unknown>);
      if (!allowedRestore) assertNoExplicitCrdtWrite(def, "replace", value);
      stage(def, id, dataOf(value), current._creationTime);
      if (allowedRestore) revisionRestores.delete(`${table}\u0000${id}`);
    },
    set: {
      async add(
        table: TableNamesInDataModel<DM>,
        id: Id<TableNamesInDataModel<DM>>,
        field: string,
        value: unknown,
      ): Promise<void> {
        if (view === "device")
          throw new Error("Local functions cannot write replicated CRDT fields.");
        if (tableFromId(id) !== table) throw new Error(`set.add: id is not in ${table}`);
        const def = tableDef(schema, table);
        assertCrdtField(def, field, "set");
        assertNoPendingCommitTs(value, "CRDT set values");
        const current = await read(id);
        const next = [...validateSetField("set.add", table, id, field, current)];
        if (!next.some((member) => equals(member, value))) next.push(cloneTree(value));
        stage(def, id, dataOf(withValueAtPath(current!, field, next)), current!._creationTime, {
          crdtOnly: true,
        });
        crdtOps.push({ table, id, field, kind: "set.add", value: cloneTree(value) });
      },
      async delete(
        table: TableNamesInDataModel<DM>,
        id: Id<TableNamesInDataModel<DM>>,
        field: string,
        value: unknown,
      ): Promise<void> {
        if (view === "device")
          throw new Error("Local functions cannot write replicated CRDT fields.");
        if (tableFromId(id) !== table) throw new Error(`set.delete: id is not in ${table}`);
        const def = tableDef(schema, table);
        assertCrdtField(def, field, "set");
        assertNoPendingCommitTs(value, "CRDT set values");
        const current = await read(id);
        const next = validateSetField("set.delete", table, id, field, current).filter(
          (member) => !equals(member, value),
        );
        stage(def, id, dataOf(withValueAtPath(current!, field, next)), current!._creationTime, {
          crdtOnly: true,
        });
        crdtOps.push({ table, id, field, kind: "set.delete", value: cloneTree(value) });
      },
    },
    text: {
      async splice(
        table: TableNamesInDataModel<DM>,
        id: Id<TableNamesInDataModel<DM>>,
        field: string,
        change: { delete: number; index: number; insert: string; base?: string },
      ): Promise<void> {
        if (view === "device")
          throw new Error("Local functions cannot write replicated CRDT fields.");
        if (tableFromId(id) !== table) throw new Error(`text.splice: id is not in ${table}`);
        const def = tableDef(schema, table);
        assertCrdtField(def, field, "text");
        const current = await read(id);
        const source = validateTextSplice(table, id, field, current, change);
        await assertTextBase(table, field, source, change.base);
        const end = change.index + change.delete;
        const next = source.slice(0, change.index) + change.insert + source.slice(end);
        stage(def, id, dataOf(withValueAtPath(current!, field, next)), current!._creationTime, {
          crdtOnly: true,
        });
        crdtOps.push({
          table,
          id,
          field,
          kind: "text.splice",
          index: codePointLength(source.slice(0, change.index)),
          delete: codePointLength(source.slice(change.index, end)),
          insert: change.insert,
        });
      },
    },
    async delete(
      tableOrId: TableNamesInDataModel<DM> | Id<TableNamesInDataModel<DM>>,
      maybeId?: Id<TableNamesInDataModel<DM>>,
    ): Promise<void> {
      const { table, id } = getArgs(tableOrId as string, maybeId as string | undefined);
      const def = tableDef(schema, table);
      assertViewTable(def, view);
      if (view === "device" && def.placement === "replicated") {
        throw new Error(`Local functions cannot delete replicated table ${table}.`);
      }
      if (tableFromId(id) !== table)
        throw new Error(`delete: id does not belong to table ${table}`);
      const current = await read(id);
      if (!current) throw new Error(`delete: document not found: ${id}`);
      const existingMapping = view === "replicated" ? await store.id.read(table, id) : undefined;
      const convexId =
        existingMapping?.mapping === "mapped" || existingMapping?.mapping === "deleted"
          ? existingMapping.convexId
          : undefined;
      const restore = revisionRestores.get(`${table}\u0000${id}`);
      const deletedWrite = docWritesByTable.get(table)?.get(id);
      if (deletedWrite?.input.pendingCommitTs === true) pendingCommitTsCount -= 1;
      docWritesByTable.get(table)?.delete(id);
      tableDeletes(table).add(id);
      for (let index = crdtOps.length - 1; index >= 0; index -= 1) {
        const op = crdtOps[index]!;
        if (op.table === table && op.id === id) crdtOps.splice(index, 1);
      }
      if (view === "replicated") {
        idMappings.push({
          table,
          localId: id,
          ...(convexId === undefined ? {} : { convexId }),
          mapping: "deleted",
          createdTime: existingMapping?.createdTime ?? current._creationTime,
          updatedTime: store.clock.read(),
        });
      }
      if (restore?.deleted) revisionRestores.delete(`${table}\u0000${id}`);
    },
  };

  const restoreDocument = (
    table: string,
    id: string,
    value: Record<string, unknown>,
    creationTime: number,
    existingMapping?: IdMapping,
  ): void => {
    const def = tableDef(schema, table);
    if (tableFromId(id) !== table) throw new Error(`restore: id does not belong to table ${table}`);
    assertNoSystemFieldConflict("restore", value, { creationTime, id });
    stage(def, id, dataOf(value), creationTime);
    const updatedTime = store.clock.read();
    const convexId = existingMapping?.mapping === "mapped" ? existingMapping.convexId : undefined;
    idMappings.push({
      table,
      localId: id,
      ...(convexId === undefined
        ? { mapping: "local" as const }
        : { mapping: "mapped" as const, convexId }),
      createdTime: existingMapping?.createdTime ?? Math.trunc(creationTime),
      updatedTime,
    });
  };

  const toBatch = (): WriteBatch => {
    const docWrites: DocWrite[] = [];
    const crdtOnlyIds: DeleteIn[] = [];
    const dataOnlyIds: DeleteIn[] = [];
    for (const map of docWritesByTable.values()) {
      for (const entry of map.values()) {
        docWrites.push(entry.input);
        if (entry.crdtOnly) {
          crdtOnlyIds.push({ table: entry.input.table, id: entry.input.id });
        }
        if (entry.dataOnly) {
          dataOnlyIds.push({ table: entry.input.table, id: entry.input.id });
        }
      }
    }
    const deletes: DeleteIn[] = [];
    for (const [table, ids] of deletesByTable) {
      for (const id of ids) deletes.push({ table, id });
    }
    return {
      crdtOps: [...crdtOps],
      crdtOnlyIds,
      crdtRestores: [...crdtRestores],
      dataOnlyIds,
      deletes,
      freshIds: [...freshIds],
      idMappings: [...idMappings],
      localFieldDeletes: [...localFieldDeletes.values()],
      localFieldWrites: [...localFieldWrites.values()],
      docWrites,
      ...(pendingCommitTsCount > 0 ? { pendingCommitTs: true } : {}),
    };
  };

  const oneDocWrite = (): OneDocWriteCommit | undefined => {
    if (
      crdtOps.length > 0 ||
      crdtRestores.length > 0 ||
      idMappings.length > 0 ||
      localFieldWrites.size > 0 ||
      localFieldDeletes.size > 0 ||
      deletesByTable.size > 0
    ) {
      return undefined;
    }
    if (docWritesByTable.size !== 1) return undefined;
    const entries = [...docWritesByTable.values()][0];
    if (!entries || entries.size !== 1) return undefined;
    const entry = [...entries.values()][0];
    if (!entry) return undefined;
    // The encoded shortcut has no typed pending-column representation. Preserve it for the
    // common path, but route commit timestamps through the generic transaction allocator.
    if (entry.input.pendingCommitTs === true) return undefined;
    const fresh =
      freshIds.length === 0
        ? false
        : freshIds.length === 1 &&
            freshIds[0]?.table === entry.input.table &&
            freshIds[0].id === entry.input.id
          ? true
          : undefined;
    if (fresh === undefined) return undefined;
    return {
      dataOnly: entry.dataOnly,
      fresh,
      docWrite: entry.input,
    };
  };

  const snapshot = (): WriterSnapshot => ({
    deletes: new Map([...deletesByTable].map(([table, ids]) => [table, new Set(ids)])),
    freshIds: [...freshIds],
    crdtOps: [...crdtOps],
    crdtRestores: [...crdtRestores],
    idMappings: [...idMappings],
    localFieldDeletes: new Map(localFieldDeletes),
    localFieldWrites: new Map(localFieldWrites),
    deviceViews: new Map([...deviceViewsByTable].map(([table, docs]) => [table, new Map(docs)])),
    revisionRestores: new Map(revisionRestores),
    docWrites: new Map([...docWritesByTable].map(([table, map]) => [table, new Map(map)])),
    pendingCommitTsCount,
  });

  const restore = (snapshot: WriterSnapshot): void => {
    docWritesByTable.clear();
    for (const [table, map] of snapshot.docWrites) docWritesByTable.set(table, new Map(map));
    deletesByTable.clear();
    for (const [table, ids] of snapshot.deletes) deletesByTable.set(table, new Set(ids));
    freshIds.length = 0;
    freshIds.push(...snapshot.freshIds);
    crdtOps.length = 0;
    crdtOps.push(...snapshot.crdtOps);
    crdtRestores.length = 0;
    crdtRestores.push(...snapshot.crdtRestores);
    idMappings.length = 0;
    idMappings.push(...snapshot.idMappings);
    localFieldWrites.clear();
    for (const [key, value] of snapshot.localFieldWrites) localFieldWrites.set(key, value);
    localFieldDeletes.clear();
    for (const [key, value] of snapshot.localFieldDeletes) localFieldDeletes.set(key, value);
    deviceViewsByTable.clear();
    for (const [table, docs] of snapshot.deviceViews) {
      deviceViewsByTable.set(table, new Map(docs));
    }
    revisionRestores.clear();
    for (const [key, expectation] of snapshot.revisionRestores) {
      revisionRestores.set(key, expectation);
    }
    pendingCommitTsCount = snapshot.pendingCommitTsCount;
  };

  const revisionRestore = (expectation: {
    table: string;
    rowId: string;
    deleted: boolean;
    value?: Record<string, unknown>;
  }): void => {
    revisionRestores.set(`${expectation.table}\u0000${expectation.rowId}`, expectation);
  };

  return {
    db,
    crdtRestore: (crdtRestore) => crdtRestores.push(crdtRestore),
    revisionRestore,
    restoreDocument,
    restore,
    snapshot,
    oneDocWrite,
    toBatch,
  };
}

const EMPTY_DELETES: ReadonlySet<string> = new Set();

/** Count Unicode scalars in a boundary-aligned substring, the position unit the Loro boundary expects. */
function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1))) i += 1;
    count += 1;
  }
  return count;
}

function assertCrdtInitialValues(def: TableDef, value: Record<string, unknown>): void {
  for (const meta of def.crdtFields ?? []) {
    const initial = valueAtPath(value, meta.field);
    if (initial === undefined) continue;
    if (meta.kind === "count" && (typeof initial !== "number" || !Number.isFinite(initial))) {
      throw new Error(`insert: ${def.name}.${meta.field} initial count must be a finite number`);
    }
    if (meta.kind === "text" && typeof initial === "string" && hasUnpairedSurrogate(initial)) {
      throw new Error(
        `insert: ${def.name}.${meta.field} initial text is not valid Unicode (contains an unpaired surrogate)`,
      );
    }
  }
}

function valueAtPath(value: Record<string, unknown>, field: string): unknown {
  let cursor: unknown = value;
  for (const segment of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function withValueAtPath(
  value: Record<string, unknown>,
  field: string,
  next: unknown,
): Record<string, unknown> {
  const segments = field.split(".");
  const root = cloneTree(value) as Record<string, unknown>;
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment];
    const object = typeof child === "object" && child !== null ? child : {};
    cursor[segment] = cloneTree(object) as Record<string, unknown>;
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = cloneTree(next);
  return root;
}

export interface WriterSnapshot {
  crdtOps: CrdtOp[];
  crdtRestores: CrdtRestore[];
  deletes: Map<string, Set<string>>;
  freshIds: DeleteIn[];
  idMappings: IdMapping[];
  localFieldDeletes: Map<string, { table: string; id: string; field: string }>;
  localFieldWrites: Map<
    string,
    {
      table: string;
      id: string;
      field: string;
      value: unknown;
      pendingCommitTs?: true;
    }
  >;
  pendingCommitTsCount: number;
  deviceViews: Map<string, Map<string, RawDoc>>;
  revisionRestores: Map<
    string,
    { table: string; rowId: string; deleted: boolean; value?: Record<string, unknown> }
  >;
  docWrites: Map<
    string,
    Map<string, { crdtOnly: boolean; dataOnly: boolean; input: DocWrite; doc: StagedDoc }>
  >;
}

function getArgs(tableOrId: string, maybeId?: string): { table: string; id: string } {
  if (maybeId !== undefined) return { table: tableOrId, id: maybeId };
  return { table: tableFromId(tableOrId), id: tableOrId };
}

function writeArgs(
  tableOrId: string,
  idOrValue: unknown,
  maybeValue: unknown,
): { table: string; id: string } {
  if (maybeValue !== undefined) return { table: tableOrId, id: idOrValue as string };
  return { table: tableFromId(tableOrId), id: tableOrId };
}

function systemReader<DM extends GenericDataModel>(
  store: RuntimeStorageReader & Partial<{ file: FileSurface }>,
): DatabaseReader<DM> {
  return {
    async get<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      maybeId?: Id<T>,
    ): Promise<Doc<DM, T> | null> {
      const { table, id } = getArgs(tableOrId as string, maybeId as string | undefined);
      if (table !== "_storage") {
        throw new Error(`Convex embedded runtime does not support system table ${table}.`);
      }
      if (!store.file) {
        throw new Error("Convex embedded runtime storage backend does not support file metadata.");
      }
      const metadata = await store.file.read(id);
      if (!metadata) return null;
      return {
        _id: metadata.storageId,
        _creationTime: metadata.createdTime,
        contentType: metadata.contentType,
        sha256: metadata.sha256,
        size: metadata.size,
      } as unknown as Doc<DM, T>;
    },
    normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null {
      return table === "_storage" && isLocalIdForTable(table, id) ? (id as Id<T>) : null;
    },
    query: () => {
      throw new Error("Convex embedded runtime does not support system tables yet.");
    },
    get system(): DatabaseReader<DM> {
      return this;
    },
    table<T extends TableNamesInDataModel<DM>>(table: T) {
      if (table !== ("_storage" as T)) {
        throw new Error(`Convex embedded runtime does not support system table ${String(table)}.`);
      }
      return {
        get: (id: Id<T>) => this.get(table, id),
        query: () => this.query(table),
      };
    },
  };
}

/**
 * Resolves a hosted Convex id to its local id for `table`, honoring both mapped and deleted
 * mappings, or `undefined` when the row was never disclosed locally.
 *
 * @internal
 */
export async function hostedToLocal(
  store: RuntimeStorageReader,
  table: string,
  hostedId: string,
): Promise<string | undefined> {
  for (const mapping of (await store.id?.page.read(table)) ?? []) {
    const convexId =
      mapping.mapping === "mapped" || mapping.mapping === "deleted" ? mapping.convexId : undefined;
    if (convexId === hostedId) return mapping.localId;
  }
  return undefined;
}
