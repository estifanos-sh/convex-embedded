import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  crdtEffectValidator,
  crdtKindValidator,
  insertRefValidator,
  readWitnessValidator,
  revisionCheckpointValidator,
  settlementValidator,
} from "./model";

export default defineSchema({
  mutations: defineTable({
    clientId: v.string(),
    mutationId: v.string(),
    replayId: v.string(),
    fingerprint: v.string(),
    logicalFingerprint: v.string(),
    settlement: settlementValidator,
    settledAt: v.number(),
    identity: v.optional(v.string()),
  })
    .index("by_clientid_and_mutationid", ["clientId", "mutationId"])
    .index("by_identity_and_mutationid", ["identity", "mutationId"])
    .index("by_identity_and_replayid", ["identity", "replayId"])
    .index("by_clientid_and_settledat", ["clientId", "settledAt"])
    .index("by_identity_and_settledat", ["identity", "settledAt"]),

  replays: defineTable({
    tokenHash: v.string(),
    kind: v.literal("push"),
    clientId: v.string(),
    requestId: v.string(),
    functionName: v.string(),
    mutationId: v.string(),
    replayId: v.string(),
    fingerprint: v.string(),
    logicalFingerprint: v.string(),
    runtime: v.object({
      schemaHash: v.string(),
      moduleGraphHash: v.string(),
      protocolVersion: v.number(),
    }),
    acknowledgeReplayId: v.optional(v.string()),
    resultHash: v.string(),
    mutationTime: v.number(),
    randomSeed: v.string(),
    reads: v.array(readWitnessValidator),
    inserts: v.array(insertRefValidator),
    schedules: v.array(v.object({ mutationId: v.string(), ordinal: v.number() })),
    uploads: v.array(v.object({ mutationId: v.string(), ordinal: v.number() })),
    crdt: v.array(crdtEffectValidator),
    revisionCheckpoints: v.array(revisionCheckpointValidator),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_tokenhash", ["tokenHash"])
    .index("by_clientid_and_requestid_and_functionname", ["clientId", "requestId", "functionName"])
    .index("by_expiresat", ["expiresAt"]),

  crdtFields: defineTable({
    key: v.optional(v.string()),
    table: v.string(),
    rowId: v.string(),
    field: v.string(),
    kind: crdtKindValidator,
    epoch: v.number(),
    headSeq: v.number(),
    projectionHash: v.string(),
    payloads: v.number(),
    payloadBytes: v.number(),
    detached: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_table", ["table"])
    .index("by_table_and_key", ["table", "key"])
    .index("by_table_and_rowid_and_field", ["table", "rowId", "field"])
    .index("by_detached_and_updatedat", ["detached", "updatedAt"]),

  crdtPayloads: defineTable({
    fieldId: v.id("crdtFields"),
    epoch: v.number(),
    seq: v.number(),
    bytes: v.bytes(),
    hash: v.string(),
    createdAt: v.number(),
  }).index("by_fieldid_and_epoch_and_seq", ["fieldId", "epoch", "seq"]),

  crdtCheckpoints: defineTable({
    fieldId: v.id("crdtFields"),
    epoch: v.number(),
    throughSeq: v.number(),
    projectionHash: v.string(),
    responseToken: v.string(),
    state: v.union(v.literal("requested"), v.literal("ready")),
    blobId: v.optional(v.id("blobs")),
    retainUntil: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_fieldid_and_epoch_and_throughseq", ["fieldId", "epoch", "throughSeq"])
    .index("by_field_epoch_state_seq", ["fieldId", "epoch", "state", "throughSeq"])
    .index("by_field_epoch_state_retain_seq", [
      "fieldId",
      "epoch",
      "state",
      "retainUntil",
      "throughSeq",
    ]),

  blobs: defineTable({
    hash: v.string(),
    bytes: v.number(),
    chunks: v.number(),
    state: v.union(v.literal("staging"), v.literal("ready")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_hash", ["hash"]),

  blobChunks: defineTable({
    blobId: v.id("blobs"),
    ordinal: v.number(),
    bytes: v.bytes(),
    hash: v.string(),
  }).index("by_blobid_and_ordinal", ["blobId", "ordinal"]),

  revisions: defineTable({
    key: v.optional(v.string()),
    revId: v.string(),
    groupId: v.string(),
    table: v.string(),
    rowId: v.string(),
    origin: v.union(
      v.literal("savepoint"),
      v.literal("conflict"),
      v.literal("rejected"),
      v.literal("displaced"),
      v.literal("delete"),
    ),
    status: v.union(v.literal("active"), v.literal("retained")),
    parentRevId: v.optional(v.string()),
    value: v.optional(v.any()),
    deleted: v.boolean(),
    fingerprint: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_revid", ["revId"])
    .index("by_table_and_rowid_and_createdat", ["table", "rowId", "createdAt"])
    .index("by_table_and_rowid_and_key", ["table", "rowId", "key"])
    .index("by_table_and_rowid_and_fingerprint", ["table", "rowId", "fingerprint"])
    .index("by_table_and_rowid_and_status", ["table", "rowId", "status"])
    // rev.list: each optional retention selector remains in the database range.
    .index("by_createdat", ["createdAt"])
    .index("by_table_and_createdat", ["table", "createdAt"])
    .index("by_status_and_createdat", ["status", "createdAt"])
    .index("by_origin_and_createdat", ["origin", "createdAt"])
    .index("by_table_and_status_and_createdat", ["table", "status", "createdAt"])
    .index("by_table_and_origin_and_createdat", ["table", "origin", "createdAt"])
    .index("by_status_and_origin_and_createdat", ["status", "origin", "createdAt"])
    .index("by_table_and_status_and_origin_and_createdat", [
      "table",
      "status",
      "origin",
      "createdAt",
    ]),

  revisionCrdt: defineTable({
    revId: v.string(),
    field: v.string(),
    kind: crdtKindValidator,
    projectionHash: v.string(),
    checkpointId: v.optional(v.id("crdtCheckpoints")),
    headSeq: v.optional(v.number()),
    bytes: v.optional(v.bytes()),
    hash: v.optional(v.string()),
  })
    .index("by_revid", ["revId"])
    .index("by_checkpointid", ["checkpointId"]),

  files: defineTable({
    storageId: v.string(),
    references: v.number(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_storageid", ["storageId"]),

  clients: defineTable({
    clientId: v.string(),
    schemaHash: v.string(),
    moduleGraphHash: v.string(),
    protocolVersion: v.number(),
    lastSeenAt: v.number(),
    lastPushAt: v.optional(v.number()),
    acknowledgedThrough: v.optional(v.number()),
    retired: v.boolean(),
    identity: v.optional(v.string()),
  })
    .index("by_clientid", ["clientId"])
    .index("by_lastseenat", ["lastSeenAt"])
    .index("by_identity_and_lastseenat", ["identity", "lastSeenAt"]),
});
