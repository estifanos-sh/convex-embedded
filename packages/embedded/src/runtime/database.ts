import type { GenericDataModel, TableNamesInDataModel, WithoutSystemFields } from "convex/server";
import type {
  RuntimeStorageReader,
  RuntimeStorageWriter,
  StoreSchema,
  StoredDoc,
  TableDef,
  UpsertIn,
  WriteBatch,
} from "../storage/types";
import type { Doc, Id } from "./model";
import { type Query, QueryBuilder, type QueryOverlay, type ReadTracker } from "./query";
import { dataOf, extractCols, makeId, materialize, type RawDoc, tableFromId } from "./values";

export type Schema = Map<string, TableDef>;

export function toSchema(schema: StoreSchema): Schema {
  return new Map(schema.tables.map((t) => [t.name, t]));
}

export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends TableNamesInDataModel<DM>>(id: Id<T>): Promise<Doc<DM, T> | null>;
  query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T>;
}

export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  insert<T extends TableNamesInDataModel<DM>>(
    table: T,
    value: WithoutSystemFields<Doc<DM, T>>,
  ): Promise<Id<T>>;
  patch<T extends TableNamesInDataModel<DM>>(
    id: Id<T>,
    partial: Partial<WithoutSystemFields<Doc<DM, T>>>,
  ): Promise<void>;
  replace<T extends TableNamesInDataModel<DM>>(
    id: Id<T>,
    value: WithoutSystemFields<Doc<DM, T>>,
  ): Promise<void>;
  delete(id: Id<TableNamesInDataModel<DM>>): Promise<void>;
}

function tableDef(schema: Schema, table: string): TableDef {
  const def = schema.get(table);
  if (!def) throw new Error(`unknown table: ${table}`);
  return def;
}

export function createReader<DM extends GenericDataModel>(
  store: RuntimeStorageReader,
  schema: Schema,
  tracker?: ReadTracker,
): DatabaseReader<DM> {
  return {
    async get<T extends TableNamesInDataModel<DM>>(id: Id<T>): Promise<Doc<DM, T> | null> {
      const table = tableFromId(id);
      tracker?.table(table);
      const stored = await store.get(table, id);
      return stored ? (materialize(stored) as unknown as Doc<DM, T>) : null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      return new QueryBuilder<DM, T>(store, tableDef(schema, table), undefined, tracker);
    },
  };
}

export function createWriter<DM extends GenericDataModel>(
  store: RuntimeStorageWriter,
  schema: Schema,
  tracker?: ReadTracker,
): { db: DatabaseWriter<DM>; toBatch: () => WriteBatch } {
  const upserts = new Map<string, { input: UpsertIn; doc: StoredDoc }>();
  const deletes = new Set<string>();

  const stage = (
    def: TableDef,
    id: string,
    data: Record<string, unknown>,
    creationTime: number,
  ): void => {
    deletes.delete(id);
    upserts.set(id, {
      input: { table: def.name, id, data, cols: extractCols(def, data), creationTime },
      doc: { _id: id, _creationTime: creationTime, data },
    });
  };

  const read = async (id: string): Promise<RawDoc | null> => {
    if (deletes.has(id)) return null;
    const staged = upserts.get(id);
    if (staged) return materialize(staged.doc);
    const stored = await store.get(tableFromId(id), id);
    return stored ? materialize(stored) : null;
  };

  const overlayFor = (table: string): QueryOverlay => ({
    staged: [...upserts.values()]
      .filter((e) => e.input.table === table)
      .map((e) => materialize(e.doc)),
    deleted: new Set([...deletes].filter((id) => tableFromId(id) === table)),
  });

  const db: DatabaseWriter<DM> = {
    async get<T extends TableNamesInDataModel<DM>>(id: Id<T>): Promise<Doc<DM, T> | null> {
      return (await read(id)) as unknown as Doc<DM, T> | null;
    },
    query<T extends TableNamesInDataModel<DM>>(table: T): Query<DM, T> {
      return new QueryBuilder<DM, T>(
        store,
        tableDef(schema, table),
        () => overlayFor(table),
        tracker,
      );
    },
    async insert<T extends TableNamesInDataModel<DM>>(
      table: T,
      value: WithoutSystemFields<Doc<DM, T>>,
    ): Promise<Id<T>> {
      const id = makeId(table);
      stage(
        tableDef(schema, table),
        id,
        dataOf(value as Record<string, unknown>),
        store.nextCreationTime(),
      );
      return id as Id<T>;
    },
    async patch<T extends TableNamesInDataModel<DM>>(
      id: Id<T>,
      partial: Partial<WithoutSystemFields<Doc<DM, T>>>,
    ): Promise<void> {
      const current = await read(id);
      if (!current) throw new Error(`patch: document not found: ${id}`);
      const merged = { ...current, ...(partial as Record<string, unknown>) };
      stage(tableDef(schema, tableFromId(id)), id, dataOf(merged), current._creationTime);
    },
    async replace<T extends TableNamesInDataModel<DM>>(
      id: Id<T>,
      value: WithoutSystemFields<Doc<DM, T>>,
    ): Promise<void> {
      const current = await read(id);
      if (!current) throw new Error(`replace: document not found: ${id}`);
      stage(
        tableDef(schema, tableFromId(id)),
        id,
        dataOf(value as Record<string, unknown>),
        current._creationTime,
      );
    },
    async delete(id: Id<TableNamesInDataModel<DM>>): Promise<void> {
      upserts.delete(id);
      deletes.add(id);
    },
  };

  const toBatch = (): WriteBatch => ({
    upserts: [...upserts.values()].map((e) => e.input),
    deletes: [...deletes].map((id) => ({ table: tableFromId(id), id })),
  });

  return { db, toBatch };
}
