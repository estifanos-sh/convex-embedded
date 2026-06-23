import type {
  EmbeddedDataEvent,
  EmbeddedInternalEventListener,
  EmbeddedSchedulerEvent,
  EmbeddedStorageEvent,
} from "../events";
import type {
  CommitResult,
  FileMetadata,
  PendingUpload,
  ScheduledJob,
  StorageRowChange,
  WriteBatch,
} from "../storage/types";
import { getTimerTime } from "../time";
import { normalizeCopy } from "./codec";

export function commitRowChanges(commit: CommitResult, batch: WriteBatch): StorageRowChange[] {
  const changes = commit.changes.length ? [...commit.changes] : batchRowChanges(batch);
  for (const mapping of batch.idMappings ?? []) {
    changes.push({
      id: `${mapping.table}|${mapping.localId}`,
      op: "upsert",
      row: { ...mapping, id: `${mapping.table}|${mapping.localId}` },
      table: "_id_mappings",
    });
  }
  return changes;
}

export function batchRowChanges(batch: WriteBatch): StorageRowChange[] {
  return [
    ...batch.upserts.map(
      (upsert): StorageRowChange => ({
        id: upsert.id,
        op: "upsert",
        row: { _creationTime: upsert.creationTime, _id: upsert.id, ...upsert.data },
        table: upsert.table,
      }),
    ),
    ...batch.deletes.map(
      (deleted): StorageRowChange => ({
        id: deleted.id,
        op: "delete",
        table: deleted.table,
      }),
    ),
  ];
}

export function emitDeletes(
  emit: EmbeddedInternalEventListener,
  deletes: { id: string; table: string }[],
  source: "local" | "remote",
): void {
  if (!deletes.length) return;
  const at = getTimerTime();
  const changedTables = [...new Set(deletes.map((change) => change.table))];
  emit({
    at,
    changedTables,
    deletes,
    source,
    type: "data",
    upserts: [],
  });
  const storageDeletes = deletes.filter((change) => isStorageTable(change.table));
  if (storageDeletes.length) {
    emit({ at, deletes: storageDeletes, type: "storage", upserts: [] });
  }
  const schedulerDeletes = deletes.filter((change) => change.table === "_scheduled_jobs");
  if (schedulerDeletes.length) {
    emit({ at, deletes: schedulerDeletes, type: "scheduler", upserts: [] });
  }
}

export function emitCommit(
  emit: EmbeddedInternalEventListener,
  commit: CommitResult,
  batch: WriteBatch,
  source: "local" | "remote",
): void {
  const changes = commitRowChanges(commit, batch);
  if (!changes.length) return;
  const upserts = changes.flatMap((change) =>
    change.op === "upsert" ? [{ id: change.id, row: change.row, table: change.table }] : [],
  );
  const deletes = changes.flatMap((change) =>
    change.op === "delete" ? [{ id: change.id, table: change.table }] : [],
  );
  const changedTables = [...new Set(changes.map((change) => change.table))];
  const event: EmbeddedDataEvent = {
    at: getTimerTime(),
    changedTables,
    commitSeq: commit.commitSeq,
    deletes,
    source,
    type: "data",
    upserts,
  };
  emit(event);
  const storageUpserts = upserts.filter((change) => isStorageTable(change.table));
  const storageDeletes = deletes.filter((change) => isStorageTable(change.table));
  if (storageUpserts.length || storageDeletes.length) {
    emit({
      at: event.at,
      deletes: storageDeletes,
      type: "storage",
      upserts: storageUpserts,
    } satisfies EmbeddedStorageEvent);
  }
  const schedulerUpserts = upserts.filter((change) => change.table === "_scheduled_jobs");
  const schedulerDeletes = deletes.filter((change) => change.table === "_scheduled_jobs");
  if (schedulerUpserts.length || schedulerDeletes.length) {
    emit({
      at: event.at,
      deletes: schedulerDeletes,
      type: "scheduler",
      upserts: schedulerUpserts,
    } satisfies EmbeddedSchedulerEvent);
  }
}

export function isStorageTable(table: string): boolean {
  return table === "_storage" || table === "_pending_uploads" || table === "_id_mappings";
}

export function emitFileStore(emit: EmbeddedInternalEventListener, metadata: FileMetadata): void {
  const now = metadata.updatedTime;
  const mapping = {
    createdTime: metadata.createdTime,
    id: `_storage|${metadata.storageId}`,
    localId: metadata.storageId,
    mapping: "local" as const,
    table: "_storage",
    updatedTime: now,
  };
  const upload: PendingUpload & { id: string } = {
    id: metadata.storageId,
    localStorageId: metadata.storageId,
    sha256: metadata.sha256,
    size: metadata.size,
    contentType: metadata.contentType,
    lease: "pending",
    createdTime: metadata.createdTime,
    updatedTime: now,
  };
  const upserts = [
    { id: metadata.storageId, row: { ...metadata, _id: metadata.storageId }, table: "_storage" },
    { id: upload.localStorageId, row: { ...upload }, table: "_pending_uploads" },
    { id: mapping.id, row: mapping, table: "_id_mappings" },
  ];
  const at = getTimerTime();
  emit({
    at,
    changedTables: ["_storage", "_pending_uploads", "_id_mappings"],
    deletes: [],
    source: "local",
    type: "data",
    upserts,
  });
  emit({ at, deletes: [], type: "storage", upserts });
}

export function emitSchedulerUpsert(emit: EmbeddedInternalEventListener, job: ScheduledJob): void {
  const row = normalizeCopy(job) as Record<string, unknown>;
  const upserts = [{ id: job.jobId, row, table: "_scheduled_jobs" }];
  const at = getTimerTime();
  emit({
    at,
    changedTables: ["_scheduled_jobs"],
    deletes: [],
    source: "local",
    type: "data",
    upserts,
  });
  emit({ at, deletes: [], type: "scheduler", upserts });
}
