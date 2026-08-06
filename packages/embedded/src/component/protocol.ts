import type {
  DataModelFromSchemaDefinition,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  mutationIdentityMatches,
  mutationReplayMatches,
  mutationReplaySettlement,
} from "./compatibility";
import {
  appliedSettlementInputValidator,
  changeInputValidator,
  crdtEffectValidator,
  failureSettlementInputValidator,
  fileInputValidator,
  insertRefValidator,
  opaqueBytesValidator,
  pullChangeValidator,
  pullCrdtValidator,
  readWitnessValidator,
  revisionCheckpointValidator,
  revisionInputValidator,
  revisionKey,
  rowInputValidator,
  settlementValidator,
} from "./model";
import schema from "./schema";
import { read as readTime } from "./time";
import { write as retentionWrite } from "./crdt/retention";
import { bytesHash, hashDocument, hashValue } from "../hash";
import {
  EMBEDDED_CLIENT_RETIRED,
  EMBEDDED_PROTOCOL_LEGACY_VERSION,
  EMBEDDED_PROTOCOL_MISMATCH,
  EMBEDDED_PROTOCOL_VERSION,
  isEmbeddedProtocolVersion,
} from "../protocol";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationCtx = GenericMutationCtx<DataModel>;
type QueryCtx = GenericQueryCtx<DataModel>;

const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const MAX_CHANGES = 1_024;
const MAX_FILES = 1_024;
const MAX_ROWS = 1_024;
const MAX_CRDT_PAYLOAD_BYTES = 1_048_576;
const BLOB_CHUNK_BYTES = 196_608;
const MAX_BLOB_CHUNKS = 32;
const MAX_CRDT_CHECKPOINT_BYTES = BLOB_CHUNK_BYTES * MAX_BLOB_CHUNKS;
const MAX_PULL_CRDT_PAYLOADS = 512;
const CRDT_CHECKPOINT_PAYLOAD_INTERVAL = 16;
// Component queries cannot use Convex pagination. Keep each logical checkpoint page bounded by
// both the maximum database read and the returned byte envelope, then continue with our own
// sequence cursor. Eight maximum-sized payloads remain below Convex's query read limit.
const MAX_CHECKPOINT_PAGE_ITEMS = 8;
const MAX_CHECKPOINT_PAGE_BYTES = 1_048_576;
const MAX_CRDT_FIELDS_PER_ROW = 64;

const runtimeValidator = v.object({
  schemaHash: v.string(),
  moduleGraphHash: v.string(),
  protocolVersion: v.number(),
});
const witnessValidator = v.object({
  table: v.string(),
  rowId: v.string(),
  field: v.string(),
  epoch: v.number(),
  headSeq: v.number(),
  projectionHash: v.string(),
  genesis: v.boolean(),
});
const commitFields = {
  clientId: v.string(),
  replayId: v.string(),
  fingerprint: v.string(),
  logicalFingerprint: v.string(),
  runtime: runtimeValidator,
  acknowledgeReplayId: v.optional(v.string()),
  identity: v.optional(v.string()),
};
const correctionTargetValidator = v.object({ table: v.string(), rowId: v.string() });
const verificationValidator = v.union(
  v.object({ kind: v.literal("ready"), witnesses: v.array(witnessValidator) }),
  v.object({ kind: v.literal("conflict"), targets: v.array(correctionTargetValidator) }),
  v.object({ kind: v.literal("unsupported") }),
);
const commitRequestValidator = v.union(
  v.object({
    ...commitFields,
    kind: v.literal("apply"),
    verification: verificationValidator,
    settlement: appliedSettlementInputValidator,
    changes: v.array(changeInputValidator),
    crdt: v.array(crdtEffectValidator),
    files: v.array(fileInputValidator),
  }),
  v.object({
    ...commitFields,
    kind: v.literal("failure"),
    settlement: failureSettlementInputValidator,
    changes: v.array(changeInputValidator),
    revisions: v.array(revisionInputValidator),
  }),
);
export const commit = mutation({
  args: { request: commitRequestValidator },
  returns: settlementValidator,
  handler: async (ctx, args) => {
    const request = args.request;
    if (request.changes.length > MAX_CHANGES) {
      throw new Error(`Embedded commit accepts at most ${MAX_CHANGES} row changes.`);
    }
    if (request.kind === "apply" && request.files.length > MAX_FILES) {
      throw new Error(`Embedded commit accepts at most ${MAX_FILES} file changes.`);
    }

    await clientWrite(ctx, request.clientId, request.runtime, request.identity);

    const replayPrior = await mutationReplayRead(ctx, request.identity, request.replayId);
    if (replayPrior) {
      if (
        !mutationReplayMatches(
          {
            fingerprint: replayPrior.fingerprint,
            logicalFingerprint: replayPrior.logicalFingerprint,
            replayId: replayPrior.replayId,
            outcome: replayPrior.settlement.outcome,
          },
          {
            fingerprint: request.fingerprint,
            logicalFingerprint: request.logicalFingerprint,
            mutationId: request.settlement.mutationId,
            replayId: request.replayId,
          },
        )
      ) {
        mutationIdReuse(replayPrior.settlement.outcome);
      }
      const settlement =
        request.kind === "apply"
          ? mutationReplaySettlement(replayPrior.settlement, request.crdt)
          : replayPrior.settlement;
      throw new ConvexError({
        code: "EMBEDDED_DUPLICATE",
        message: "Mutation was already applied.",
        settlement,
      });
    }

    const logicalPrior = await mutationLogicalRead(
      ctx,
      request.identity,
      request.settlement.mutationId,
    );
    if (logicalPrior) {
      if (
        !mutationIdentityMatches(
          {
            fingerprint: logicalPrior.fingerprint,
            logicalFingerprint: logicalPrior.logicalFingerprint,
            replayId: logicalPrior.replayId,
            outcome: logicalPrior.settlement.outcome,
          },
          {
            fingerprint: request.fingerprint,
            logicalFingerprint: request.logicalFingerprint,
            mutationId: request.settlement.mutationId,
            replayId: request.replayId,
          },
        )
      ) {
        mutationIdReuse(logicalPrior.settlement.outcome);
      }
      if (logicalPrior.settlement.outcome === "applied") {
        const settlement =
          request.kind === "apply"
            ? mutationReplaySettlement(logicalPrior.settlement, request.crdt)
            : logicalPrior.settlement;
        throw new ConvexError({
          code: "EMBEDDED_DUPLICATE",
          message: "Mutation was already applied.",
          settlement,
        });
      }
    }

    if (request.kind === "apply") {
      if (request.verification.kind === "unsupported") {
        throw new ConvexError({
          code: "EMBEDDED_UNSUPPORTED_WITNESS",
          message: "The carried range witness cannot be reproduced by this V5 server.",
        });
      }
      if (request.verification.kind === "conflict") {
        throw new ConvexError({
          code: "EMBEDDED_CONFLICT",
          message: "An authoritative plain read changed after the local mutation ran.",
          targets: request.verification.targets,
        });
      }
      await witnessAssert(
        ctx,
        request.verification.witnesses,
        request.changes.map(({ table, rowId }) => ({ table, rowId })),
      );
    }

    if (request.acknowledgeReplayId) {
      await acknowledgeWrite(ctx, request.acknowledgeReplayId, request.identity);
    }

    if (request.kind === "apply") {
      await crdtDetach(ctx, request.changes);
      for (const effect of request.crdt) await crdtWrite(ctx, effect);
      await fileWrite(ctx, request.files);
    }
    const revisions =
      request.kind === "failure"
        ? await revisionWrite(ctx, request.settlement, request.revisions)
        : [];
    const settlement = {
      ...request.settlement,
      revisions: [...request.settlement.revisions, ...revisions],
      crdt:
        request.kind === "apply"
          ? request.crdt.map((effect) => ({
              table: effect.table,
              rowId: effect.rowId,
              field: effect.field,
              kind: effect.kind,
              headSeq: effect.baseSeq + 1,
              projectionHash: effect.projectionHash,
            }))
          : [],
      authoritative: request.changes.map((change) =>
        change.op === "put"
          ? {
              op: change.op,
              table: change.table,
              rowId: change.rowId,
              fields: change.fields,
              plainHash: change.contentHash,
            }
          : {
              op: change.op,
              table: change.table,
              rowId: change.rowId,
              plainHash: change.contentHash,
            },
      ),
    };
    if (settlement.outcome === "rebase") return settlement;
    const settledAt = readTime();
    await ctx.db.insert("mutations", {
      clientId: request.clientId,
      mutationId: settlement.mutationId,
      replayId: request.replayId,
      fingerprint: request.fingerprint,
      logicalFingerprint: request.logicalFingerprint,
      settlement,
      settledAt,
      ...(request.identity === undefined ? {} : { identity: request.identity }),
    });
    return settlement;
  },
});

async function witnessAssert(
  ctx: MutationCtx,
  witnesses: Array<{
    table: string;
    rowId: string;
    field: string;
    epoch: number;
    headSeq: number;
    projectionHash: string;
    genesis: boolean;
  }>,
  correctionTargets: Array<{ table: string; rowId: string }>,
): Promise<void> {
  if (witnesses.length > MAX_ROWS * MAX_CRDT_FIELDS_PER_ROW) {
    throw new Error("Embedded commit carries too many CRDT witnesses.");
  }
  const seen = new Set<string>();
  const targets = new Map<string, { table: string; rowId: string }>();
  for (const witness of witnesses) {
    const key = `${witness.table}\u0000${witness.rowId}\u0000${witness.field}`;
    if (seen.has(key)) throw new Error("Embedded commit carries a duplicate CRDT witness.");
    seen.add(key);
    const current = await ctx.db
      .query("crdtFields")
      .withIndex("by_table_and_rowid_and_field", (q) =>
        q.eq("table", witness.table).eq("rowId", witness.rowId).eq("field", witness.field),
      )
      .unique();
    const active = current && !current.detached ? current : null;
    const matches = active
      ? active.epoch === witness.epoch &&
        active.headSeq === witness.headSeq &&
        active.projectionHash === witness.projectionHash
      : witness.genesis;
    if (!matches) {
      targets.set(`${witness.table}\u0000${witness.rowId}`, {
        table: witness.table,
        rowId: witness.rowId,
      });
    }
  }
  if (targets.size > 0) {
    throw new ConvexError({
      code: "EMBEDDED_REBASE",
      message: "An authoritative CRDT dependency advanced after the local mutation ran.",
      targets: correctionTargets,
    });
  }
}

async function fileWrite(
  ctx: MutationCtx,
  files: Array<{ storageId: string; delta: number }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const file of files) {
    if (file.storageId.length === 0 || !Number.isSafeInteger(file.delta) || file.delta === 0) {
      throw new Error("File changes require a storage ID and a non-zero safe-integer delta.");
    }
    if (seen.has(file.storageId)) {
      throw new Error("File changes must contain at most one delta per storage ID.");
    }
    seen.add(file.storageId);
  }

  for (const file of files) {
    const current = await ctx.db
      .query("files")
      .withIndex("by_storageid", (q) => q.eq("storageId", file.storageId))
      .unique();
    const references = (current?.references ?? 0) + file.delta;
    if (!Number.isSafeInteger(references) || references < 0) {
      throw new Error("File reference accounting would become negative or exceed safe bounds.");
    }
    if (current) {
      await ctx.db.patch("files", current._id, {
        references,
        version: current.version + 1,
        updatedAt: readTime(),
      });
    } else {
      await ctx.db.insert("files", {
        storageId: file.storageId,
        references,
        version: 1,
        updatedAt: readTime(),
      });
    }
  }
}

async function revisionWrite(
  ctx: MutationCtx,
  settlement: {
    mutationId: string;
    outcome: "applied" | "conflict" | "rejected" | "rebase";
  },
  revisions: Array<
    | { content: "value"; table: string; rowId: string; value: unknown }
    | { content: "deleted"; table: string; rowId: string }
  >,
): Promise<Array<{ table: string; rowId: string; revId: string }>> {
  if (revisions.length === 0) return [];
  if (settlement.outcome !== "conflict" && settlement.outcome !== "rejected") {
    throw new Error("Only conflict or rejection settlements may retain revisions.");
  }
  const groupId = crypto.randomUUID();
  const createdAt = readTime();
  const retained: Array<{ table: string; rowId: string; revId: string }> = [];
  for (const revision of revisions) {
    const deleted = revision.content === "deleted";
    const fingerprint = await hashValue({
      deleted,
      value: revision.content === "value" ? revision.value : null,
      crdt: [],
    });
    const existing = (
      await ctx.db
        .query("revisions")
        .withIndex("by_table_and_rowid_and_fingerprint", (q) =>
          q.eq("table", revision.table).eq("rowId", revision.rowId).eq("fingerprint", fingerprint),
        )
        .take(1)
    )[0];
    if (existing) {
      retained.push({ table: revision.table, rowId: revision.rowId, revId: existing.revId });
      continue;
    }
    const revId = crypto.randomUUID();
    await ctx.db.insert("revisions", {
      key: revisionKey(createdAt, revId),
      revId,
      groupId,
      table: revision.table,
      rowId: revision.rowId,
      origin: settlement.outcome,
      status: "retained",
      ...(revision.content === "value" ? { value: revision.value } : {}),
      deleted,
      fingerprint,
      createdAt,
    });
    retained.push({ table: revision.table, rowId: revision.rowId, revId });
  }
  return retained;
}

export const settlementRead = query({
  args: { clientId: v.string(), mutationId: v.string() },
  returns: v.union(
    v.object({ fingerprint: v.string(), settlement: settlementValidator }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mutations")
      .withIndex("by_clientid_and_mutationid", (q) =>
        q.eq("clientId", args.clientId).eq("mutationId", args.mutationId),
      )
      .order("desc")
      .first();
    return row === null ? null : { fingerprint: row.fingerprint, settlement: row.settlement };
  },
});

const REPLAY_SWEEP_SLICE = 8;

export const replayWrite = mutation({
  args: {
    tokenHash: v.string(),
    kind: v.literal("push"),
    clientId: v.string(),
    identity: v.optional(v.string()),
    requestId: v.string(),
    functionName: v.string(),
    mutationId: v.string(),
    replayId: v.string(),
    fingerprint: v.string(),
    logicalFingerprint: v.string(),
    resultHash: v.string(),
    mutationTime: v.number(),
    randomSeed: v.string(),
    reads: v.array(readWitnessValidator),
    inserts: v.array(insertRefValidator),
    schedules: v.array(v.object({ mutationId: v.string(), ordinal: v.number() })),
    uploads: v.array(v.object({ mutationId: v.string(), ordinal: v.number() })),
    crdt: v.array(crdtEffectValidator),
    revisionCheckpoints: v.array(revisionCheckpointValidator),
    runtime: runtimeValidator,
    acknowledgeReplayId: v.optional(v.string()),
    expiresAt: v.number(),
  },
  returns: v.union(settlementValidator, v.null()),
  handler: async (ctx, args) => {
    await clientWrite(ctx, args.clientId, args.runtime, args.identity);
    await replayDelete(ctx);
    const replaySettled = await mutationReplayRead(ctx, args.identity, args.replayId);
    if (replaySettled) {
      if (
        !mutationReplayMatches(
          {
            fingerprint: replaySettled.fingerprint,
            logicalFingerprint: replaySettled.logicalFingerprint,
            replayId: replaySettled.replayId,
            outcome: replaySettled.settlement.outcome,
          },
          {
            fingerprint: args.fingerprint,
            logicalFingerprint: args.logicalFingerprint,
            mutationId: args.mutationId,
            replayId: args.replayId,
          },
        )
      ) {
        mutationIdReuse(replaySettled.settlement.outcome);
      }
      return mutationReplaySettlement(replaySettled.settlement, args.crdt);
    }
    const logicalSettled = await mutationLogicalRead(ctx, args.identity, args.mutationId);
    if (logicalSettled) {
      if (
        !mutationIdentityMatches(
          {
            fingerprint: logicalSettled.fingerprint,
            logicalFingerprint: logicalSettled.logicalFingerprint,
            replayId: logicalSettled.replayId,
            outcome: logicalSettled.settlement.outcome,
          },
          {
            fingerprint: args.fingerprint,
            logicalFingerprint: args.logicalFingerprint,
            mutationId: args.mutationId,
            replayId: args.replayId,
          },
        )
      ) {
        mutationIdReuse(logicalSettled.settlement.outcome);
      }
      if (logicalSettled.settlement.outcome === "applied") {
        return mutationReplaySettlement(logicalSettled.settlement, args.crdt);
      }
    }
    const prior = await ctx.db
      .query("replays")
      .withIndex("by_clientid_and_requestid_and_functionname", (q) =>
        q
          .eq("clientId", args.clientId)
          .eq("requestId", args.requestId)
          .eq("functionName", args.functionName),
      )
      .unique();
    if (prior) {
      if (
        prior.mutationId !== args.mutationId ||
        prior.replayId !== args.replayId ||
        prior.fingerprint !== args.fingerprint ||
        prior.logicalFingerprint !== args.logicalFingerprint
      ) {
        throw new ConvexError({
          code: "EMBEDDED_REPLAY_TOKEN_REUSE",
          message: "Replay token was reused for a different mutation.",
        });
      }
      return null;
    }
    const foreign = await ctx.db
      .query("replays")
      .withIndex("by_tokenhash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (foreign) {
      throw new ConvexError({
        code: "EMBEDDED_REPLAY_TOKEN_REUSE",
        message: "Replay token was reused for a different device.",
      });
    }
    await ctx.db.insert("replays", args);
    return null;
  },
});

async function replayDelete(ctx: MutationCtx): Promise<void> {
  const now = readTime();
  const expired = await ctx.db
    .query("replays")
    .withIndex("by_expiresat", (q) => q.lt("expiresAt", now))
    .take(REPLAY_SWEEP_SLICE);
  for (const replay of expired) await ctx.db.delete("replays", replay._id);
}

export const replayConsume = mutation({
  args: {
    requestId: v.string(),
    functionName: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("push"),
      clientId: v.string(),
      mutationId: v.string(),
      replayId: v.string(),
      fingerprint: v.string(),
      logicalFingerprint: v.string(),
      runtime: runtimeValidator,
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
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tokenHash = await replayTokenHash(args.requestId, args.functionName);
    const replay = await ctx.db
      .query("replays")
      .withIndex("by_tokenhash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!replay || replay.consumedAt !== undefined || replay.expiresAt < readTime()) return null;
    await ctx.db.patch("replays", replay._id, { consumedAt: readTime() });
    return {
      kind: replay.kind,
      clientId: replay.clientId,
      mutationId: replay.mutationId,
      replayId: replay.replayId,
      fingerprint: replay.fingerprint,
      logicalFingerprint: replay.logicalFingerprint,
      runtime: replay.runtime,
      acknowledgeReplayId: replay.acknowledgeReplayId,
      resultHash: replay.resultHash,
      mutationTime: replay.mutationTime,
      randomSeed: replay.randomSeed,
      reads: replay.reads,
      inserts: replay.inserts,
      schedules: replay.schedules,
      uploads: replay.uploads,
      crdt: replay.crdt,
      revisionCheckpoints: replay.revisionCheckpoints,
    };
  },
});

export const pull = query({
  args: {
    runtime: runtimeValidator,
    rows: v.array(rowInputValidator),
  },
  returns: v.object({
    members: v.array(v.object({ table: v.string(), rowId: v.string() })),
    changes: v.array(pullChangeValidator),
    crdt: v.array(pullCrdtValidator),
  }),
  handler: async (ctx, args) => {
    if (args.rows.length > MAX_ROWS) {
      throw new Error("Embedded pull exceeds its bounded row window.");
    }
    assertRuntime(args.runtime);
    const current = new Map(
      args.rows.map((row) => [memberKey(row.table, row.rowId), row] as const),
    );
    const members = [...current.values()]
      .map(({ table, rowId }) => ({ table, rowId }))
      .sort((left, right) => {
        const leftKey = memberKey(left.table, left.rowId);
        const rightKey = memberKey(right.table, right.rowId);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    // App-query rows are the entire plain-data source of truth. Convex reruns this query when
    // that authorized result changes, so there is no component cursor or shadow row state.
    const changes = await Promise.all(
      [...current.values()].map(async (row) => ({
        op: "put" as const,
        plainHash: await hashDocument(row.fields, row.crdtFields),
        table: row.table,
        rowId: row.rowId,
        fields: row.fields,
      })),
    );
    return {
      members,
      changes,
      crdt: await crdtRead(ctx, args.rows),
    };
  },
});

export const blobWrite = mutation({
  args: {
    hash: v.string(),
    bytes: v.number(),
    chunks: v.number(),
    ordinal: v.number(),
    chunk: v.bytes(),
    chunkHash: v.string(),
  },
  returns: v.object({ blobId: v.string(), ready: v.boolean() }),
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.bytes) ||
      args.bytes <= 0 ||
      args.bytes > MAX_CRDT_CHECKPOINT_BYTES ||
      !Number.isSafeInteger(args.chunks) ||
      args.chunks <= 0 ||
      args.chunks > MAX_BLOB_CHUNKS ||
      !Number.isSafeInteger(args.ordinal) ||
      args.ordinal < 0 ||
      args.ordinal >= args.chunks ||
      args.chunk.byteLength === 0 ||
      args.chunk.byteLength > BLOB_CHUNK_BYTES
    ) {
      throw new Error("Invalid bounded Embedded blob chunk.");
    }
    if (args.chunkHash !== (await bytesHash(args.chunk))) {
      throw new Error("Embedded blob chunk hash does not match its bytes.");
    }
    let blob = await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (blob && (blob.bytes !== args.bytes || blob.chunks !== args.chunks)) {
      throw new Error("Embedded blob hash was reused with a different manifest.");
    }
    if (!blob) {
      const now = readTime();
      const id = await ctx.db.insert("blobs", {
        hash: args.hash,
        bytes: args.bytes,
        chunks: args.chunks,
        state: "staging",
        createdAt: now,
        updatedAt: now,
      });
      blob = await ctx.db.get("blobs", id);
      if (!blob) throw new Error("Created Embedded blob was not readable.");
    }
    const prior = await ctx.db
      .query("blobChunks")
      .withIndex("by_blobid_and_ordinal", (q) =>
        q.eq("blobId", blob!._id).eq("ordinal", args.ordinal),
      )
      .unique();
    if (prior) {
      if (prior.hash !== args.chunkHash || !bytesEqual(prior.bytes, args.chunk)) {
        throw new Error("Embedded blob chunk ordinal was reused with different bytes.");
      }
    } else {
      await ctx.db.insert("blobChunks", {
        blobId: blob._id,
        ordinal: args.ordinal,
        bytes: args.chunk,
        hash: args.chunkHash,
      });
    }
    const chunks = await ctx.db
      .query("blobChunks")
      .withIndex("by_blobid_and_ordinal", (q) => q.eq("blobId", blob!._id))
      .take(args.chunks + 1);
    if (chunks.length > args.chunks) throw new Error("Embedded blob has excess chunks.");
    if (chunks.length === args.chunks && blob.state !== "ready") {
      if (chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal)) {
        throw new Error("Embedded blob chunks are not contiguous.");
      }
      const assembled = concatBytes(chunks.map((chunk) => chunk.bytes));
      if (assembled.byteLength !== args.bytes || (await bytesHash(assembled)) !== args.hash) {
        throw new Error("Embedded blob does not match its immutable manifest.");
      }
      await ctx.db.patch("blobs", blob._id, { state: "ready", updatedAt: readTime() });
      return { blobId: blob._id, ready: true };
    }
    return { blobId: blob._id, ready: blob.state === "ready" };
  },
});

export const checkpointRead = query({
  args: {
    table: v.string(),
    rowId: v.string(),
    field: v.string(),
    checkpointId: v.id("crdtCheckpoints"),
    epoch: v.number(),
    headSeq: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.union(
    v.object({ kind: v.literal("stale") }),
    v.object({
      checkpoint: v.object({
        id: v.string(),
        seq: v.number(),
        bytes: v.number(),
        hash: v.string(),
      }),
      headSeq: v.number(),
      chunks: v.array(v.object({ ordinal: v.number(), bytes: v.bytes(), hash: v.string() })),
      payloads: v.array(v.object({ seq: v.number(), bytes: v.bytes(), hash: v.string() })),
      continueCursor: v.union(v.string(), v.null()),
      isDone: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const checkpoint = await ctx.db.get("crdtCheckpoints", args.checkpointId);
    if (!checkpoint || checkpoint.state !== "ready" || !checkpoint.blobId) {
      return { kind: "stale" as const };
    }
    const field = await ctx.db.get("crdtFields", checkpoint.fieldId);
    if (!field || field.detached || field.epoch !== args.epoch || checkpoint.epoch !== args.epoch) {
      return { kind: "stale" as const };
    }
    if (field.table !== args.table || field.rowId !== args.rowId || field.field !== args.field) {
      throw new Error("Embedded checkpoint does not address the authorized field.");
    }
    if (
      !Number.isSafeInteger(args.headSeq) ||
      args.headSeq < checkpoint.throughSeq ||
      args.headSeq > field.headSeq ||
      args.headSeq - checkpoint.throughSeq > MAX_PULL_CRDT_PAYLOADS
    ) {
      throw new Error("Embedded checkpoint head is outside the readable field history.");
    }
    const blob = await ctx.db.get("blobs", checkpoint.blobId);
    if (!blob || blob.state !== "ready") return { kind: "stale" as const };
    const cursor = checkpointCursor(args.cursor, checkpoint.throughSeq, args.headSeq, blob.chunks);
    const chunks = [] as Array<{ ordinal: number; bytes: ArrayBuffer; hash: string }>;
    const payloads = [] as Array<{ seq: number; bytes: ArrayBuffer; hash: string }>;
    let continueCursor: string | null;
    let isDone: boolean;
    if (cursor.kind === "chunk") {
      const page = await ctx.db
        .query("blobChunks")
        .withIndex("by_blobid_and_ordinal", (q) =>
          q.eq("blobId", blob._id).gt("ordinal", cursor.ordinal),
        )
        .take(MAX_CHECKPOINT_PAGE_ITEMS);
      let pageBytes = 0;
      for (const chunk of page) {
        if (chunks.length > 0 && pageBytes + chunk.bytes.byteLength > MAX_CHECKPOINT_PAGE_BYTES) {
          break;
        }
        if (chunk.ordinal !== cursor.ordinal + chunks.length + 1) return { kind: "stale" as const };
        chunks.push({ ordinal: chunk.ordinal, bytes: chunk.bytes, hash: chunk.hash });
        pageBytes += chunk.bytes.byteLength;
      }
      const last = chunks.at(-1);
      if (!last) return { kind: "stale" as const };
      const checkpointDone = last.ordinal + 1 === blob.chunks;
      isDone = checkpointDone && checkpoint.throughSeq === args.headSeq;
      continueCursor = isDone
        ? null
        : checkpointDone
          ? `payload:${checkpoint.throughSeq}`
          : `chunk:${last.ordinal}`;
    } else {
      const page = await ctx.db
        .query("crdtPayloads")
        .withIndex("by_fieldid_and_epoch_and_seq", (q) =>
          q
            .eq("fieldId", field._id)
            .eq("epoch", args.epoch)
            .gt("seq", cursor.seq)
            .lte("seq", args.headSeq),
        )
        .take(MAX_CHECKPOINT_PAGE_ITEMS);
      if (page[0]?.seq !== cursor.seq + 1) return { kind: "stale" as const };
      let pageBytes = 0;
      for (const payload of page) {
        if (
          payloads.length > 0 &&
          pageBytes + payload.bytes.byteLength > MAX_CHECKPOINT_PAGE_BYTES
        ) {
          break;
        }
        if (payload.seq !== cursor.seq + payloads.length + 1) return { kind: "stale" as const };
        payloads.push({ seq: payload.seq, bytes: payload.bytes, hash: payload.hash });
        pageBytes += payload.bytes.byteLength;
      }
      const last = payloads.at(-1)!;
      isDone = last.seq === args.headSeq;
      continueCursor = isDone ? null : `payload:${last.seq}`;
    }
    return {
      checkpoint: {
        id: checkpoint._id,
        seq: checkpoint.throughSeq,
        bytes: blob.bytes,
        hash: blob.hash,
      },
      headSeq: args.headSeq,
      chunks,
      payloads,
      continueCursor,
      isDone,
    };
  },
});

export const installation = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return (await ctx.meta.getFunctionMetadata()).componentPath;
  },
});

export const acknowledge = mutation({
  args: { replayId: v.string(), identity: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await acknowledgeWrite(ctx, args.replayId, args.identity);
    return null;
  },
});

async function acknowledgeWrite(
  ctx: MutationCtx,
  replayId: string,
  identity?: string,
): Promise<void> {
  const row = await mutationReplayRead(ctx, identity, replayId);
  if (!row) return;
  if (row.acknowledgedAt === undefined) {
    // Commit timestamps are assigned by Convex in this transaction. The fact lives on the exact
    // settlement row, so later rows cannot become eligible for destructive GC by accident.
    await ctx.db.patch("mutations", row._id, { acknowledgedAt: ctx.db.vars.commitTs });
  }
  const client = await clientRead(ctx, row.clientId);
  if (client && row._creationTime > (client.acknowledgedThrough ?? 0)) {
    // Keep this legacy high-water diagnostic for the remote-client administration surface. It is
    // intentionally not consulted by settlement deletion; only `mutations.acknowledgedAt` is.
    await ctx.db.patch("clients", client._id, { acknowledgedThrough: row._creationTime });
  }
}

/** Mutation identity survives page, worker, and remote-client incarnations. */
async function mutationLogicalRead(
  ctx: MutationCtx,
  identity: string | undefined,
  mutationId: string,
) {
  return await ctx.db
    .query("mutations")
    .withIndex("by_identity_and_mutationid", (q) =>
      q.eq("identity", identity).eq("mutationId", mutationId),
    )
    .order("desc")
    .first();
}

async function mutationReplayRead(
  ctx: MutationCtx,
  identity: string | undefined,
  replayId: string,
) {
  return await ctx.db
    .query("mutations")
    .withIndex("by_identity_and_replayid", (q) =>
      q.eq("identity", identity).eq("replayId", replayId),
    )
    .unique();
}

function mutationIdReuse(priorOutcome: "applied" | "conflict" | "rejected" | "rebase"): never {
  throw new ConvexError({
    code: "EMBEDDED_MUTATION_ID_REUSE",
    message: "Mutation ID was reused for a different logical mutation or replay attempt.",
    priorOutcome,
  });
}

async function crdtRead(
  ctx: QueryCtx,
  rows: Array<{ table: string; rowId: string; crdtFields: string[] }>,
) {
  const result: Array<{
    table: string;
    rowId: string;
    field: string;
    kind: "text" | "count" | "set";
    epoch: number;
    checkpoint: { id: string; seq: number; bytes: number; hash: string };
    headSeq: number;
    projectionHash: string;
    checkpointRequest?: {
      checkpointId: string;
      responseToken: string;
      throughSeq: number;
      projectionHash: string;
    };
    payload?: { seq: number; bytes: ArrayBuffer; hash: string };
  }> = [];
  for (const row of rows) {
    if (row.crdtFields.length > MAX_CRDT_FIELDS_PER_ROW) {
      throw new Error(
        `Embedded pull accepts at most ${MAX_CRDT_FIELDS_PER_ROW} CRDT fields per row.`,
      );
    }
    for (const fieldName of row.crdtFields) {
      const field = await ctx.db
        .query("crdtFields")
        .withIndex("by_table_and_rowid_and_field", (q) =>
          q.eq("table", row.table).eq("rowId", row.rowId).eq("field", fieldName),
        )
        .unique();
      if (!field) continue;
      if (field.detached) continue;
      const [checkpointRequest] = await ctx.db
        .query("crdtCheckpoints")
        .withIndex("by_field_epoch_state_seq", (q) =>
          q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("state", "requested"),
        )
        .order("desc")
        .take(1);
      const [checkpoint] = await ctx.db
        .query("crdtCheckpoints")
        .withIndex("by_field_epoch_state_seq", (q) => {
          const state = q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("state", "ready");
          return checkpointRequest === undefined
            ? state
            : state.lte("throughSeq", checkpointRequest.throughSeq);
        })
        .order("desc")
        .take(1);
      if (!checkpoint?.blobId) {
        throw new Error("Embedded CRDT field has no ready checkpoint.");
      }
      const blob = await ctx.db.get("blobs", checkpoint.blobId);
      if (!blob || blob.state !== "ready") {
        throw new Error("Embedded CRDT checkpoint has no ready blob.");
      }
      const checkpointSeq = checkpoint.throughSeq;
      if (field.headSeq - checkpointSeq > MAX_PULL_CRDT_PAYLOADS) {
        throw new Error("Embedded CRDT checkpoint does not cover the retained pull bound.");
      }
      const [payload] = await ctx.db
        .query("crdtPayloads")
        .withIndex("by_fieldid_and_epoch_and_seq", (q) =>
          q.eq("fieldId", field._id).eq("epoch", field.epoch),
        )
        .order("desc")
        .take(1);
      if (checkpointSeq < field.headSeq && payload?.seq !== field.headSeq) {
        throw new Error("Embedded CRDT live result is missing its latest payload.");
      }
      result.push({
        table: field.table,
        rowId: field.rowId,
        field: field.field,
        kind: field.kind,
        epoch: field.epoch,
        checkpoint: {
          id: checkpoint._id,
          seq: checkpointSeq,
          bytes: blob.bytes,
          hash: blob.hash,
        },
        headSeq: field.headSeq,
        projectionHash: field.projectionHash,
        ...(checkpointRequest === undefined
          ? {}
          : {
              checkpointRequest: {
                checkpointId: checkpointRequest._id,
                responseToken: checkpointRequest.responseToken,
                throughSeq: checkpointRequest.throughSeq,
                projectionHash: checkpointRequest.projectionHash,
              },
            }),
        ...(checkpointSeq === field.headSeq || payload === undefined
          ? {}
          : { payload: { seq: payload.seq, bytes: payload.bytes, hash: payload.hash } }),
      });
    }
  }
  return result;
}

function checkpointCursor(
  value: string | null,
  checkpointSeq: number,
  headSeq: number,
  chunks: number,
): { kind: "chunk"; ordinal: number } | { kind: "payload"; seq: number } {
  if (value === null) return { kind: "chunk", ordinal: -1 };
  const [kind, raw] = value.split(":");
  const coordinate = Number(raw);
  if (!Number.isSafeInteger(coordinate)) throw new Error("Invalid Embedded checkpoint cursor.");
  if (kind === "chunk" && coordinate >= 0 && coordinate < chunks - 1) {
    return { kind, ordinal: coordinate };
  }
  if (kind === "payload" && coordinate >= checkpointSeq && coordinate < headSeq) {
    return { kind, seq: coordinate };
  }
  throw new Error("Invalid Embedded checkpoint cursor.");
}

export const witnessRead = query({
  args: {
    rows: v.array(v.object({ table: v.string(), rowId: v.string() })),
  },
  returns: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      crdt: v.array(
        v.object({
          field: v.string(),
          epoch: v.number(),
          headSeq: v.number(),
          projectionHash: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.rows.length > MAX_ROWS) {
      throw new Error(`Embedded witness read accepts at most ${MAX_ROWS} rows.`);
    }
    return await Promise.all(
      args.rows.map(async (address) => {
        const crdt = await ctx.db
          .query("crdtFields")
          .withIndex("by_table_and_rowid_and_field", (q) =>
            q.eq("table", address.table).eq("rowId", address.rowId),
          )
          .take(MAX_CRDT_FIELDS_PER_ROW + 1);
        if (crdt.length > MAX_CRDT_FIELDS_PER_ROW) {
          throw new Error(
            `Embedded witness read accepts at most ${MAX_CRDT_FIELDS_PER_ROW} CRDT fields per row.`,
          );
        }
        return {
          table: address.table,
          rowId: address.rowId,
          crdt: crdt
            .filter((field) => !field.detached)
            .map((field) => ({
              field: field.field,
              epoch: field.epoch,
              headSeq: field.headSeq,
              projectionHash: field.projectionHash,
            })),
        };
      }),
    );
  },
});

async function crdtDetach(
  ctx: MutationCtx,
  changes: Array<{ op: "put" | "del"; table: string; rowId: string }>,
): Promise<void> {
  for (const change of changes) {
    if (change.op !== "del") continue;
    const crdtFields = await ctx.db
      .query("crdtFields")
      .withIndex("by_table_and_rowid_and_field", (q) =>
        q.eq("table", change.table).eq("rowId", change.rowId),
      )
      .take(MAX_CRDT_FIELDS_PER_ROW + 1);
    if (crdtFields.length > MAX_CRDT_FIELDS_PER_ROW) {
      throw new Error(
        `Embedded delete accepts at most ${MAX_CRDT_FIELDS_PER_ROW} CRDT fields per row.`,
      );
    }
    for (const field of crdtFields) {
      if (!field.detached) {
        await ctx.db.patch("crdtFields", field._id, {
          detached: true,
          updatedAt: readTime(),
        });
      }
    }
  }
}

async function crdtWrite(
  ctx: MutationCtx,
  effect: {
    table: string;
    rowId: string;
    field: string;
    kind: "text" | "count" | "set";
    baseSeq: number;
    projection: unknown;
    projectionHash: string;
    payload: ArrayBuffer;
    checkpoint?: {
      throughSeq: number;
      content:
        | { kind: "inline"; bytes: ArrayBuffer; hash: string }
        | { kind: "staged"; blobId: string; bytes: number; hash: string };
    };
  },
): Promise<void> {
  if (effect.payload.byteLength === 0 || effect.payload.byteLength > MAX_CRDT_PAYLOAD_BYTES) {
    throw new Error(`CRDT payload must contain 1-${MAX_CRDT_PAYLOAD_BYTES} bytes.`);
  }
  if (effect.projectionHash !== (await hashValue(effect.projection))) {
    throw new Error("CRDT projection hash does not match the carried projection.");
  }
  const checkpointBlob = effect.checkpoint
    ? await blobResolve(ctx, effect.checkpoint.content)
    : null;
  let field = await ctx.db
    .query("crdtFields")
    .withIndex("by_table_and_rowid_and_field", (q) =>
      q.eq("table", effect.table).eq("rowId", effect.rowId).eq("field", effect.field),
    )
    .unique();
  if (field && (field.kind !== effect.kind || field.detached)) {
    throw new Error("CRDT field kind or epoch does not match the active field.");
  }
  const headSeq = field?.headSeq ?? 0;
  if (effect.baseSeq !== headSeq) {
    throw new Error(`EMBEDDED_REBASE:${headSeq}`);
  }
  const created = field === null;
  if (!field) {
    const fieldId = await ctx.db.insert("crdtFields", {
      key: JSON.stringify([effect.table, effect.rowId, effect.field]),
      table: effect.table,
      rowId: effect.rowId,
      field: effect.field,
      kind: effect.kind,
      epoch: 0,
      headSeq: 0,
      projectionHash: effect.projectionHash,
      payloads: 0,
      payloadBytes: 0,
      detached: false,
      updatedAt: readTime(),
    });
    field = await ctx.db.get("crdtFields", fieldId);
    if (!field) throw new Error("Created CRDT field was not readable.");
  }
  const seq = headSeq + 1;
  if (created && (!effect.checkpoint || effect.checkpoint.throughSeq !== seq)) {
    throw new Error("The first CRDT effect must carry its ready checkpoint.");
  }
  if (!created && effect.checkpoint) {
    throw new Error("CRDT checkpoint responses use the checkpoint push request.");
  }
  await ctx.db.insert("crdtPayloads", {
    fieldId: field._id,
    epoch: field.epoch,
    seq,
    bytes: effect.payload,
    hash: await bytesHash(effect.payload),
    createdAt: readTime(),
  });
  await ctx.db.patch("crdtFields", field._id, {
    headSeq: seq,
    projectionHash: effect.projectionHash,
    payloads: field.payloads + 1,
    payloadBytes: field.payloadBytes + effect.payload.byteLength,
    updatedAt: readTime(),
  });
  if (effect.checkpoint) {
    if (effect.checkpoint.throughSeq > seq) {
      throw new Error("CRDT checkpoint cannot cover a future sequence.");
    }
    const checkpoint = await ctx.db
      .query("crdtCheckpoints")
      .withIndex("by_fieldid_and_epoch_and_throughseq", (q) =>
        q
          .eq("fieldId", field!._id)
          .eq("epoch", field!.epoch)
          .eq("throughSeq", effect.checkpoint!.throughSeq),
      )
      .unique();
    if (!checkpoint) {
      if (!created || effect.checkpoint.throughSeq !== seq) {
        throw new Error("CRDT checkpoint bytes require a matching checkpoint request.");
      }
      await ctx.db.insert("crdtCheckpoints", {
        fieldId: field._id,
        epoch: field.epoch,
        throughSeq: effect.checkpoint.throughSeq,
        projectionHash: effect.projectionHash,
        responseToken: crypto.randomUUID(),
        state: "ready",
        blobId: checkpointBlob!._id,
        createdAt: readTime(),
        updatedAt: readTime(),
      });
      return;
    }
    throw new Error("CRDT checkpoint responses use the checkpoint push request.");
  }
  await checkpointRequestWrite(ctx, field, seq, effect.projectionHash);
}

async function checkpointRequestWrite(
  ctx: MutationCtx,
  field: DataModel["crdtFields"]["document"],
  throughSeq: number,
  projectionHash: string,
): Promise<void> {
  const [requested] = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_seq", (q) =>
      q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("state", "requested"),
    )
    .take(1);
  if (requested) return;
  const [ready] = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_seq", (q) =>
      q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("state", "ready"),
    )
    .order("desc")
    .take(1);
  if (throughSeq - (ready?.throughSeq ?? 0) < CRDT_CHECKPOINT_PAYLOAD_INTERVAL) return;
  await ctx.db.insert("crdtCheckpoints", {
    fieldId: field._id,
    epoch: field.epoch,
    throughSeq,
    projectionHash,
    responseToken: crypto.randomUUID(),
    state: "requested",
    createdAt: readTime(),
    updatedAt: readTime(),
  });
}

export const checkpointWrite = mutation({
  args: {
    checkpointId: v.id("crdtCheckpoints"),
    responseToken: v.string(),
    throughSeq: v.number(),
    projectionHash: v.string(),
    content: opaqueBytesValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const checkpoint = await ctx.db.get("crdtCheckpoints", args.checkpointId);
    if (!checkpoint) throw new Error("CRDT checkpoint request not found.");
    if (
      checkpoint.responseToken !== args.responseToken ||
      checkpoint.throughSeq !== args.throughSeq ||
      checkpoint.projectionHash !== args.projectionHash
    ) {
      throw new Error("CRDT checkpoint response does not match its request.");
    }
    if (checkpoint.state === "ready") {
      // Several live clients can observe and answer the same request before the first response
      // commits. The first ready checkpoint is authoritative; every later response for that exact
      // request is settled without resolving or retaining its losing blob.
      return null;
    }
    const blob = await blobResolve(ctx, args.content);
    const field = await ctx.db.get("crdtFields", checkpoint.fieldId);
    if (!field || field.epoch !== checkpoint.epoch || field.headSeq < checkpoint.throughSeq) {
      throw new Error("CRDT checkpoint request no longer covers an active field.");
    }
    const now = readTime();
    await retentionWrite(ctx, checkpoint.fieldId, checkpoint.epoch, checkpoint.throughSeq, now);
    await ctx.db.patch("crdtCheckpoints", checkpoint._id, {
      state: "ready",
      blobId: blob._id,
      updatedAt: now,
    });
    return null;
  },
});

async function blobResolve(
  ctx: MutationCtx,
  content:
    | { kind: "inline"; bytes: ArrayBuffer; hash: string }
    | { kind: "staged"; blobId: string; bytes: number; hash: string },
) {
  if (content.kind === "staged") {
    const blob = await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q) => q.eq("hash", content.blobId))
      .unique();
    if (
      !blob ||
      blob.state !== "ready" ||
      content.blobId !== content.hash ||
      blob.bytes !== content.bytes ||
      blob.hash !== content.hash
    ) {
      throw new Error("Staged Embedded blob does not match its immutable manifest.");
    }
    return blob;
  }
  if (
    content.bytes.byteLength === 0 ||
    content.bytes.byteLength > BLOB_CHUNK_BYTES ||
    content.hash !== (await bytesHash(content.bytes))
  ) {
    throw new Error("Inline Embedded checkpoint bytes are invalid.");
  }
  let blob = await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q) => q.eq("hash", content.hash))
    .unique();
  if (blob) {
    if (blob.state !== "ready" || blob.bytes !== content.bytes.byteLength || blob.chunks !== 1) {
      throw new Error("Inline Embedded checkpoint conflicts with its blob manifest.");
    }
    return blob;
  }
  const now = readTime();
  const blobId = await ctx.db.insert("blobs", {
    hash: content.hash,
    bytes: content.bytes.byteLength,
    chunks: 1,
    state: "ready",
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("blobChunks", {
    blobId,
    ordinal: 0,
    bytes: content.bytes,
    hash: content.hash,
  });
  blob = await ctx.db.get("blobs", blobId);
  if (!blob) throw new Error("Created Embedded checkpoint blob was not readable.");
  return blob;
}

function concatBytes(chunks: Array<ArrayBuffer>): ArrayBuffer {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function clientRead(ctx: MutationCtx, clientId: string) {
  return await ctx.db
    .query("clients")
    .withIndex("by_clientid", (q) => q.eq("clientId", clientId))
    .unique();
}

async function clientWrite(
  ctx: MutationCtx,
  clientId: string,
  runtime: { schemaHash: string; moduleGraphHash: string; protocolVersion: number },
  identity?: string,
) {
  assertRuntime(runtime);
  const row = await clientRead(ctx, clientId);
  if (row?.retired) {
    throw new ConvexError({
      code: EMBEDDED_CLIENT_RETIRED,
      message: "Embedded remote client has been permanently retired.",
    });
  }
  const now = readTime();
  const fields = {
    schemaHash: runtime.schemaHash,
    moduleGraphHash: runtime.moduleGraphHash,
    protocolVersion: runtime.protocolVersion,
    lastSeenAt: now,
    lastPushAt: now,
    ...(identity === undefined ? {} : { identity }),
  };
  if (row) {
    await ctx.db.patch("clients", row._id, fields);
    return { ...row, ...fields };
  } else {
    const id = await ctx.db.insert("clients", {
      clientId,
      ...fields,
      retired: false,
    });
    const created = await ctx.db.get("clients", id);
    if (!created) throw new Error("Created remote client was not readable.");
    return created;
  }
}

function assertRuntime(runtime: {
  schemaHash: string;
  moduleGraphHash: string;
  protocolVersion: number;
}): void {
  if (!isEmbeddedProtocolVersion(runtime.protocolVersion)) {
    throw new ConvexError({
      code: EMBEDDED_PROTOCOL_MISMATCH,
      expected: [EMBEDDED_PROTOCOL_LEGACY_VERSION, EMBEDDED_PROTOCOL_VERSION],
      message: `Embedded protocol ${runtime.protocolVersion} is not supported.`,
      received: runtime.protocolVersion,
    });
  }
}

function memberKey(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`;
}

export async function replayTokenHash(requestId: string, functionName: string): Promise<string> {
  return await hashValue({ requestId, functionName });
}
