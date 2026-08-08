import type { StorageBackend, StoreSchema } from "../../src/storage/types";

const localId = "issues|11111111111111111111111111111111";
const remoteLocalId = "issues|22222222222222222222222222222222";

/** One adapter-neutral oracle read through the production TypeScript storage contract. */
export async function portableOracle(store: StorageBackend): Promise<unknown> {
  const identity = await store.identity.read();
  const mutation = await store.mutation.write({
    args: "{}",
    mutationId: "fixture:retained",
    name: "issues:update",
  });
  const schedules = (await store.schedule.read()).sort((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
  const mappings = (await store.id.page.read("issues")).sort((left, right) =>
    left.localId.localeCompare(right.localId),
  );
  const uploads = (await store.upload.read()).sort((left, right) =>
    left.localStorageId.localeCompare(right.localStorageId),
  );
  const file = await store.file.read("fixture:file");
  const bytes = await store.blob.read("fixture:file");
  const projection = await store.remoteDocDebugRead?.("issues", remoteLocalId);
  const cursor = await store.remoteCursorDebugRead?.("fixture:subscription");
  const membership = (await store.remoteMemberDebugRead?.("fixture:subscription"))?.sort((a, b) =>
    `${a.table}:${a.serverDocumentId}`.localeCompare(`${b.table}:${b.serverDocumentId}`),
  );
  const result = await store.result?.read("fixture:result");
  const crdt = await store.doc.crdt.snapshot.read("issues", localId);
  if (
    file === undefined ||
    bytes === null ||
    projection === undefined ||
    result === undefined ||
    cursor === undefined ||
    membership === undefined
  ) {
    throw new Error("baseline portable oracle is missing required fixture state.");
  }
  return {
    identityKey: identity.identityKey,
    deviceDocument: await store.doc.read("preferences", "preferences:fixture"),
    localDocument: await store.doc.read("issues", localId),
    remoteDocument: await store.doc.read("issues", remoteLocalId),
    localFields: await store.doc.device?.read("issues", localId),
    mutation: {
      commitSeq: mutation.commitSeq ?? null,
      error: mutation.error ?? null,
      mutationId: mutation.mutationId,
      result: mutation.result ?? null,
      status: mutation.status,
    },
    schedules: schedules.map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      name: job.name,
      args: job.args,
      dueTime: job.dueTime,
      state: job.state,
      leaseUntil: job.state === "running" ? job.leaseUntil : null,
      createdTime: job.createdTime,
      updatedTime: job.updatedTime,
    })),
    mappings: mappings.map((mapping) => ({
      table: mapping.table,
      localId: mapping.localId,
      mapping: mapping.mapping,
      convexId: "convexId" in mapping ? (mapping.convexId ?? null) : null,
      createdTime: mapping.createdTime,
      updatedTime: mapping.updatedTime,
    })),
    uploads: uploads.map((upload) => ({
      localStorageId: upload.localStorageId,
      sha256: upload.sha256,
      size: upload.size,
      contentType: upload.contentType ?? null,
      lease: upload.lease,
      owner: upload.lease === "claimed" ? upload.owner : null,
      leaseUntil: upload.lease === "claimed" ? upload.leaseUntil : null,
      createdTime: upload.createdTime,
      updatedTime: upload.updatedTime,
    })),
    file: {
      storageId: file.storageId,
      sha256: file.sha256,
      size: file.size,
      contentType: file.contentType ?? null,
      source: file.source ?? null,
      createdTime: file.createdTime,
      updatedTime: file.updatedTime,
    },
    fileBytes: [...bytes],
    crdt: crdt.map((snapshot) => ({
      field: snapshot.field,
      kind: snapshot.kind,
      headSeq: snapshot.headSeq,
      projectionHash: snapshot.projectionHash,
      hash: snapshot.hash,
    })),
    remoteProjection: {
      table: projection.table,
      localDocumentId: projection.localDocumentId,
      currentRevId: projection.currentRevId,
      serverDocumentId: projection.serverDocumentId,
      projectionHash: projection.projectionHash,
      currentRootId: projection.currentRootId ?? null,
      currentNodeId: projection.currentNodeId ?? null,
      serverBase: projection.serverBase ?? null,
      logicalClock: projection.logicalClock,
      updatedTime: projection.updatedTime,
    },
    remoteCursor: cursor,
    remoteMembership: membership,
    result: {
      key: result.key,
      function: result.function,
      args: result.args,
      schemaHash: result.schemaHash,
      moduleHash: result.moduleHash,
      skeleton: new TextDecoder().decode(result.skeleton),
      paths: new TextDecoder().decode(result.paths),
      skeletonHash: result.skeletonHash,
      clock: result.clock,
    },
  };
}

export function portableOracleJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sort(child)]),
  );
}

/** Exact target contract with a real schema/index evolution from the public baseline fixture. */
export const fixtureTargetSchema: StoreSchema = {
  hash: "e".repeat(64),
  setupHash: "",
  tables: [
    {
      name: "preferences",
      placement: "device",
      columns: [],
      crdtFields: [],
      localFields: [],
      indexes: [],
    },
    {
      name: "issues",
      placement: "replicated",
      columns: [{ name: "title" }],
      crdtFields: [{ field: "body", kind: "text" }],
      localFields: [{ field: "expanded", validator: { type: "boolean" } }],
      indexes: [{ name: "by_title", fields: ["title"] }],
    },
  ],
};
