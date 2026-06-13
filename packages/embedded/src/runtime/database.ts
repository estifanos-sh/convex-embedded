import type { GenericDataModel, TableNamesInDataModel, WithoutSystemFields } from "convex/server";
import type {
  RuntimeStorageReader,
  RuntimeStorageWriter,
  StoreSchema,
  TableDef,
  UpsertIn,
  WriteBatch,
} from "../storage/types";
import { cloneTree } from "./codec";
import type { Doc, Id } from "./model";
import { type Query, QueryBuilder, type QueryOverlay, type ReadTracker } from "./query";
import { validateJson } from "./validate";
import {
  assertNoSystemFieldConflict,
  createId,
  dataOf,
  extractCols,
  materialize,
  type RawDoc,
  type StagedDoc,
  tableFromId,
} from "./values";

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

/**
 * Creates a database reader bound to runtime storage.
 *
 * @internal
 */
export function createReader<DM extends GenericDataModel>(
  store: RuntimeStorageReader,
  schema: Schema,
  tracker?: ReadTracker,
): DatabaseReader<DM> {
  const reader: DatabaseReader<DM> = {
    async get<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      maybeId?: Id<T>,
    ): Promise<Doc<DM, T> | null> {
      const { table, id } = getArgs(tableOrId as string, maybeId as string | undefined);
      tableDef(schema, table);
      ensureIdBelongsToTable("get", table, id);
      tracker?.table(table);
      const stored = await store.doc.read(table, id);
      return stored ? (stored as unknown as Doc<DM, T>) : null;
    },
    normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null {
      return isLocalIdForTable(table, id) ? (id as Id<T>) : null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      return new QueryBuilder<DM, T>(store, tableDef(schema, table), undefined, tracker);
    },
    get system(): DatabaseReader<DM> {
      return unsupportedSystemReader<DM>();
    },
    table<T extends TableNamesInDataModel<DM>>(table: T) {
      tableDef(schema, table);
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
  store: RuntimeStorageWriter,
  schema: Schema,
  tracker?: ReadTracker,
): {
  db: DatabaseWriter<DM>;
  restore(snapshot: WriterSnapshot): void;
  snapshot(): WriterSnapshot;
  toBatch: () => WriteBatch;
} {
  const upsertsByTable = new Map<string, Map<string, { input: UpsertIn; doc: StagedDoc }>>();
  const deletesByTable = new Map<string, Set<string>>();

  const tableUpserts = (table: string): Map<string, { input: UpsertIn; doc: StagedDoc }> => {
    let map = upsertsByTable.get(table);
    if (!map) {
      map = new Map();
      upsertsByTable.set(table, map);
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
  ): void => {
    if (def.document) validateJson(data, def.document, def.name);
    deletesByTable.get(def.name)?.delete(id);
    tableUpserts(def.name).set(id, {
      input: { table: def.name, id, data, cols: extractCols(def, data), creationTime },
      doc: { _id: id, _creationTime: creationTime, data },
    });
  };

  const read = async (id: string): Promise<RawDoc | null> => {
    const table = tableFromId(id);
    if (deletesByTable.get(table)?.has(id)) return null;
    const staged = upsertsByTable.get(table)?.get(id);
    if (staged) return cloneTree(materialize(staged.doc));
    const stored = await store.doc.read(table, id);
    return stored ?? null;
  };

  const overlayFor = (table: string): QueryOverlay => ({
    staged: [...(upsertsByTable.get(table)?.values() ?? [])].map((e) =>
      cloneTree(materialize(e.doc)),
    ),
    deleted: deletesByTable.get(table) ?? EMPTY_DELETES,
  });

  const db: DatabaseWriter<DM> = {
    async get<T extends TableNamesInDataModel<DM>>(
      tableOrId: T | Id<T>,
      maybeId?: Id<T>,
    ): Promise<Doc<DM, T> | null> {
      const { table, id: parsedId } = getArgs(tableOrId as string, maybeId as string | undefined);
      ensureIdBelongsToTable("get", table, parsedId);
      return (await read(parsedId)) as unknown as Doc<DM, T> | null;
    },
    normalizeId<T extends TableNamesInDataModel<DM>>(table: T, id: string): Id<T> | null {
      return isLocalIdForTable(table, id) ? (id as Id<T>) : null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      return new QueryBuilder<DM, T>(
        store,
        tableDef(schema, table),
        () => overlayFor(table),
        tracker,
      );
    },
    get system(): DatabaseReader<DM> {
      return unsupportedSystemReader<DM>();
    },
    table<T extends TableNamesInDataModel<DM>>(table: T) {
      tableDef(schema, table);
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
    async insert<T extends TableNamesInDataModel<DM>>(
      table: T,
      value: WithoutSystemFields<Doc<DM, T>>,
    ): Promise<Id<T>> {
      const id = createId(table);
      assertNoSystemFieldConflict("insert", value as Record<string, unknown>);
      stage(
        tableDef(schema, table),
        id,
        dataOf(value as Record<string, unknown>),
        store.clock.next(),
      );
      return id as Id<T>;
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
      const merged = { ...current, ...partial };
      stage(tableDef(schema, table), id, dataOf(merged), current._creationTime);
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
      stage(tableDef(schema, table), id, dataOf(value), current._creationTime);
    },
    async delete(
      tableOrId: TableNamesInDataModel<DM> | Id<TableNamesInDataModel<DM>>,
      maybeId?: Id<TableNamesInDataModel<DM>>,
    ): Promise<void> {
      const { table, id } = getArgs(tableOrId as string, maybeId as string | undefined);
      tableDef(schema, table);
      if (tableFromId(id) !== table)
        throw new Error(`delete: id does not belong to table ${table}`);
      const current = await read(id);
      if (!current) throw new Error(`delete: document not found: ${id}`);
      upsertsByTable.get(table)?.delete(id);
      tableDeletes(table).add(id);
    },
  };

  const toBatch = (): WriteBatch => ({
    upserts: [...upsertsByTable.values()].flatMap((map) => [...map.values()].map((e) => e.input)),
    deletes: [...deletesByTable.entries()].flatMap(([table, ids]) =>
      [...ids].map((id) => ({ table, id })),
    ),
  });

  const snapshot = (): WriterSnapshot => ({
    deletes: new Map([...deletesByTable].map(([table, ids]) => [table, new Set(ids)])),
    upserts: new Map([...upsertsByTable].map(([table, map]) => [table, new Map(map)])),
  });

  const restore = (snapshot: WriterSnapshot): void => {
    upsertsByTable.clear();
    for (const [table, map] of snapshot.upserts) upsertsByTable.set(table, new Map(map));
    deletesByTable.clear();
    for (const [table, ids] of snapshot.deletes) deletesByTable.set(table, new Set(ids));
  };

  return { db, restore, snapshot, toBatch };
}

const EMPTY_DELETES: ReadonlySet<string> = new Set();

export interface WriterSnapshot {
  deletes: Map<string, Set<string>>;
  upserts: Map<string, Map<string, { input: UpsertIn; doc: StagedDoc }>>;
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

function unsupportedSystemReader<DM extends GenericDataModel>(): DatabaseReader<DM> {
  const fail = () => {
    throw new Error("Convex embedded runtime does not support system tables yet.");
  };
  return {
    get: fail,
    normalizeId: fail,
    query: fail,
    system: undefined as never,
    table: fail,
  };
}

function ensureIdBelongsToTable(method: string, table: string, id: string): void {
  if (!isLocalIdForTable(table, id)) {
    throw new Error(`${method}: id does not belong to table ${table}`);
  }
}

function isLocalIdForTable(table: string, id: string): boolean {
  return tableFromId(id) === table && /^[^|]+\|[0-9a-f]{32}$/.test(id);
}
