import type { RuntimeStorageWriter, ReadSpec, WriteBatch } from "../storage/types";

/** Installed component path. The empty string is the root app. @internal */
export type ComponentInstancePath = string;

/** Root app instance path. @internal */
export const ROOT_INSTANCE: ComponentInstancePath = "";

/** Runtime invalidation key for a logical table in a component instance. @internal */
export function invalidationKey(instancePath: ComponentInstancePath, table: string): string {
  return instancePath === ROOT_INSTANCE ? table : `${instancePath}:${table}`;
}

/** Physical storage table for a logical table in a component instance. @internal */
function physicalTable(instancePath: ComponentInstancePath, table: string): string {
  if (instancePath === ROOT_INSTANCE) return table;
  return `__e_${table}`;
}

/** Creates a logical view of storage for one component instance. @internal */
export function namespaceStore(
  store: RuntimeStorageWriter,
  instancePath: ComponentInstancePath,
): RuntimeStorageWriter {
  if (instancePath === ROOT_INSTANCE) return store;
  const mapScan = (spec: ReadSpec): ReadSpec => ({
    ...spec,
    table: physicalTable(instancePath, spec.table),
  });
  return {
    ...store,
    doc: {
      count: {
        read: (spec) =>
          store.doc.count.read({
            ...spec,
            table: physicalTable(instancePath, spec.table),
          }),
      },
      read: (table, id) => store.doc.read(physicalTable(instancePath, table), id),
      version: {
        read: (table, id) => store.doc.version.read(physicalTable(instancePath, table), id),
      },
      crdt: {
        read: (table, id, field) =>
          store.doc.crdt.read(physicalTable(instancePath, table), id, field),
        snapshot: {
          read: (table, id) => store.doc.crdt.snapshot.read(physicalTable(instancePath, table), id),
        },
      },
      page: {
        read: (spec) => store.doc.page.read(mapScan(spec)),
      },
    },
    key: {
      page: {
        read: (spec) => store.key.page.read(mapScan(spec)),
      },
    },
  };
}

/** Maps a logical write batch into physical storage table names. @internal */
export function namespaceBatch(instancePath: ComponentInstancePath, batch: WriteBatch): WriteBatch {
  if (instancePath === ROOT_INSTANCE) return batch;
  return {
    crdtOps: batch.crdtOps?.map((op) => ({
      ...op,
      table: physicalTable(instancePath, op.table),
    })),
    crdtOnlyIds: batch.crdtOnlyIds?.map((row) => ({
      ...row,
      table: physicalTable(instancePath, row.table),
    })),
    crdtRestores: batch.crdtRestores?.map((restore) => ({
      ...restore,
      table: physicalTable(instancePath, restore.table),
    })),
    deletes: batch.deletes.map((deleted) => ({
      ...deleted,
      table: physicalTable(instancePath, deleted.table),
    })),
    freshIds: batch.freshIds?.map((fresh) => ({
      ...fresh,
      table: physicalTable(instancePath, fresh.table),
    })),
    dataOnlyIds: batch.dataOnlyIds?.map((dataOnly) => ({
      ...dataOnly,
      table: physicalTable(instancePath, dataOnly.table),
    })),
    idMappings: batch.idMappings?.map((mapping) => ({
      ...mapping,
      table: physicalTable(instancePath, mapping.table),
    })),
    localFieldWrites: batch.localFieldWrites?.map((write) => ({
      ...write,
      table: physicalTable(instancePath, write.table),
    })),
    localFieldDeletes: batch.localFieldDeletes?.map((deleted) => ({
      ...deleted,
      table: physicalTable(instancePath, deleted.table),
    })),
    docWrites: batch.docWrites.map((docWrite) => ({
      ...docWrite,
      table: physicalTable(instancePath, docWrite.table),
    })),
    pendingCommitTs: batch.pendingCommitTs,
    schedules: batch.schedules,
  };
}

/** Returns logical invalidation keys affected by a logical write batch. @internal */
export function batchInvalidationKeys(
  instancePath: ComponentInstancePath,
  batch: WriteBatch,
): string[] {
  return [
    ...new Set([
      ...batch.docWrites.map((docWrite) => invalidationKey(instancePath, docWrite.table)),
      ...batch.deletes.map((deleted) => invalidationKey(instancePath, deleted.table)),
      ...(batch.localFieldWrites ?? []).map((write) => invalidationKey(instancePath, write.table)),
      ...(batch.localFieldDeletes ?? []).map((deleted) =>
        invalidationKey(instancePath, deleted.table),
      ),
    ]),
  ];
}
