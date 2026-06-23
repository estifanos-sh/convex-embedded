import { paginationOptsValidator } from "convex/server";
import type {
  DataModelFromSchemaDefinition,
  GenericQueryCtx,
  GenericMutationCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import {
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import { crdtKindValidator, deleteProgress, deleteProgressValidator } from "./model";
import schema from "./schema";
import { read as readTime } from "./time";
import { hashValue } from "../hash";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const MAX_DELETE = 1_024;
const MAX_CRDT_FIELDS = 64;
const MAX_REVISION_PAGE = 32;

type RevisionOrigin = DataModel["revisions"]["document"]["origin"];
type RevisionStatus = DataModel["revisions"]["document"]["status"];
type RevisionFilter = {
  table?: string;
  origin?: RevisionOrigin;
  status?: RevisionStatus;
  createdBefore?: number;
};

const revisionOriginValidator = v.union(
  v.literal("savepoint"),
  v.literal("conflict"),
  v.literal("rejected"),
  v.literal("displaced"),
  v.literal("delete"),
);
const revisionStatusValidator = v.union(
  v.literal("active"),
  v.literal("retained"),
  v.literal("acknowledged"),
);

const revisionValidator = v.object({
  revId: v.string(),
  groupId: v.string(),
  table: v.string(),
  rowId: v.string(),
  origin: revisionOriginValidator,
  status: revisionStatusValidator,
  parentRevId: v.optional(v.string()),
  createdAt: v.number(),
  deleted: v.boolean(),
  value: v.optional(v.any()),
  crdt: v.array(
    v.object({
      field: v.string(),
      kind: crdtKindValidator,
      projectionHash: v.string(),
    }),
  ),
});

const localSnapshotValidator = v.object({
  field: v.string(),
  kind: crdtKindValidator,
  headSeq: v.number(),
  projectionHash: v.string(),
  bytes: v.bytes(),
  hash: v.string(),
});

export const create = mutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    value: v.optional(v.any()),
    deleted: v.boolean(),
  },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    return await revisionInsert(ctx, { ...args, origin: "savepoint" });
  },
});

/** Package-internal deterministic create used only while replaying an app mutation. */
export const createReplay = mutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    value: v.optional(v.any()),
    deleted: v.boolean(),
    replay: v.object({
      mutationId: v.string(),
      ordinal: v.number(),
      createdAt: v.number(),
    }),
    snapshots: v.optional(v.array(localSnapshotValidator)),
  },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    return await revisionInsert(ctx, { ...args, origin: "savepoint" });
  },
});

export const createLocal = internalMutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    value: v.optional(v.any()),
    deleted: v.boolean(),
    snapshots: v.array(localSnapshotValidator),
  },
  returns: revisionValidator,
  handler: async (ctx, args) => revisionInsert(ctx, { ...args, origin: "savepoint" }),
});

/** Package-internal retention used by the Embedded writer for displaced local state. */
export const retain = mutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    value: v.optional(v.any()),
    deleted: v.boolean(),
    origin: v.union(
      v.literal("conflict"),
      v.literal("rejected"),
      v.literal("displaced"),
      v.literal("delete"),
    ),
  },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    return await revisionInsert(ctx, args);
  },
});

export const retainLocal = internalMutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    value: v.optional(v.any()),
    deleted: v.boolean(),
    origin: v.union(
      v.literal("conflict"),
      v.literal("rejected"),
      v.literal("displaced"),
      v.literal("delete"),
    ),
    snapshots: v.array(localSnapshotValidator),
  },
  returns: revisionValidator,
  handler: async (ctx, args) => revisionInsert(ctx, args),
});

const revisionCheckpointArgs = {
  table: v.string(),
  rowId: v.string(),
  snapshots: v.array(
    v.object({
      field: v.string(),
      kind: crdtKindValidator,
      headSeq: v.number(),
      projectionHash: v.string(),
      bytes: v.bytes(),
      hash: v.string(),
    }),
  ),
};

type RevisionCheckpointArgs = {
  table: string;
  rowId: string;
  snapshots: Array<{
    field: string;
    kind: "text" | "count" | "set";
    headSeq: number;
    projectionHash: string;
    bytes: ArrayBuffer;
    hash: string;
  }>;
};

/** Hosted replay bridge: accept a snapshot only at the exact live CRDT head. */
export const checkpointWrite = mutation({
  args: revisionCheckpointArgs,
  returns: v.null(),
  handler: async (ctx, args) => revisionCheckpointWrite(ctx, args),
});

async function revisionCheckpointWrite(ctx: MutationCtx, args: RevisionCheckpointArgs) {
  for (const snapshot of args.snapshots) {
    if (snapshot.hash !== (await bytesHash(snapshot.bytes))) {
      throw new Error("CRDT revision checkpoint hash does not match its bytes.");
    }
    let field = await ctx.db
      .query("crdtFields")
      .withIndex("by_table_and_rowid_and_field", (q) =>
        q.eq("table", args.table).eq("rowId", args.rowId).eq("field", snapshot.field),
      )
      .unique();
    if (field && field.kind !== snapshot.kind) {
      throw new Error(`CRDT kind changed for ${args.table}.${snapshot.field}.`);
    }
    if (!field) {
      const fieldId = await ctx.db.insert("crdtFields", {
        key: JSON.stringify([args.table, args.rowId, snapshot.field]),
        table: args.table,
        rowId: args.rowId,
        field: snapshot.field,
        kind: snapshot.kind,
        epoch: 0,
        headSeq: snapshot.headSeq,
        projectionHash: snapshot.projectionHash,
        payloads: 0,
        payloadBytes: 0,
        detached: false,
        updatedAt: readTime(),
      });
      field = await ctx.db.get("crdtFields", fieldId);
      if (!field) throw new Error("Created CRDT field was not readable.");
    } else if (
      field.detached ||
      field.headSeq !== snapshot.headSeq ||
      field.projectionHash !== snapshot.projectionHash
    ) {
      throw new ConvexError({
        code: "EMBEDDED_REBASE",
        message: `CRDT state advanced before revision capture for ${args.table}.${snapshot.field}: live=${field.headSeq}/${field.projectionHash}, captured=${snapshot.headSeq}/${snapshot.projectionHash}.`,
      });
    }
    const checkpoint = await ctx.db
      .query("crdtCheckpoints")
      .withIndex("by_fieldid_and_epoch_and_throughseq", (q) =>
        q.eq("fieldId", field!._id).eq("epoch", field!.epoch).eq("throughSeq", snapshot.headSeq),
      )
      .unique();
    const blobId = await inlineBlobWrite(ctx, snapshot.bytes, snapshot.hash);
    const ready = {
      state: "ready" as const,
      blobId,
      updatedAt: readTime(),
    };
    if (checkpoint) {
      await ctx.db.patch("crdtCheckpoints", checkpoint._id, ready);
    } else {
      await ctx.db.insert("crdtCheckpoints", {
        fieldId: field._id,
        epoch: field.epoch,
        throughSeq: snapshot.headSeq,
        projectionHash: snapshot.projectionHash,
        responseToken: crypto.randomUUID(),
        ...ready,
        createdAt: readTime(),
      });
    }
  }
  return null;
}

export const restoreRead = internalQuery({
  args: { table: v.string(), rowId: v.string(), revId: v.string() },
  returns: v.array(
    v.object({
      field: v.string(),
      kind: crdtKindValidator,
      headSeq: v.number(),
      projectionHash: v.string(),
      bytes: v.bytes(),
      hash: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const target = await revisionRow(ctx, args.table, args.rowId, args.revId);
    if (!target) throw new Error("Revision not found.");
    const links = await ctx.db
      .query("revisionCrdt")
      .withIndex("by_revid", (q) => q.eq("revId", target.revId))
      .take(MAX_CRDT_FIELDS + 1);
    if (links.length > MAX_CRDT_FIELDS) throw new Error("Revision has too many CRDT fields.");
    return await Promise.all(
      links.map(async (link) => {
        if (link.bytes !== undefined && link.hash !== undefined && link.headSeq !== undefined) {
          if (link.hash !== (await bytesHash(link.bytes))) {
            throw new Error(`Revision snapshot for ${target.table}.${link.field} is corrupt.`);
          }
          return {
            field: link.field,
            kind: link.kind,
            headSeq: link.headSeq,
            projectionHash: link.projectionHash,
            bytes: link.bytes,
            hash: link.hash,
          };
        }
        if (!link.checkpointId) {
          throw new Error(`Revision CRDT link for ${target.table}.${link.field} is incomplete.`);
        }
        const checkpoint = await ctx.db.get("crdtCheckpoints", link.checkpointId);
        if (!checkpoint || checkpoint.state !== "ready" || checkpoint.blobId === undefined) {
          throw new Error(`Revision checkpoint for ${target.table}.${link.field} is not ready.`);
        }
        const blob = await readyBlobRead(ctx, checkpoint.blobId);
        return {
          field: link.field,
          kind: link.kind,
          headSeq: checkpoint.throughSeq,
          projectionHash: link.projectionHash,
          bytes: await blobBytesRead(ctx, blob),
          hash: blob.hash,
        };
      }),
    );
  },
});

export const get = query({
  args: { table: v.string(), rowId: v.string(), revId: v.string() },
  returns: v.union(revisionValidator, v.null()),
  handler: async (ctx, args) => revisionRead(ctx, args.table, args.rowId, args.revId),
});

export const list = query({
  args: {
    table: v.optional(v.string()),
    rowId: v.optional(v.string()),
    origin: v.optional(revisionOriginValidator),
    status: v.optional(revisionStatusValidator),
    createdBefore: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(revisionValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = revisionPageLimit(args.paginationOpts.numItems);
    if (args.rowId !== undefined) {
      if (
        args.table === undefined ||
        args.origin !== undefined ||
        args.status !== undefined ||
        args.createdBefore !== undefined
      ) {
        throw new Error("A row revision list requires only table and rowId selectors.");
      }
      const cursor = args.paginationOpts.cursor;
      const rows = await ctx.db
        .query("revisions")
        .withIndex("by_table_and_rowid_and_key", (q) => {
          const row = q.eq("table", args.table!).eq("rowId", args.rowId!);
          return cursor === null ? row : row.lt("key", cursor);
        })
        .order("desc")
        .take(limit + 1);
      const page = rows.slice(0, limit);
      return {
        isDone: rows.length <= limit,
        continueCursor: page.at(-1)?.key ?? cursor ?? "",
        page: await Promise.all(page.map((revision) => revisionValue(ctx, revision))),
      };
    }
    const rows = await revisionStream(ctx, args).paginate({
      cursor: args.paginationOpts.cursor,
      numItems: limit,
      maximumRowsRead: limit + 1,
    });
    return {
      isDone: rows.isDone,
      continueCursor: rows.continueCursor,
      page: await Promise.all(rows.page.map((revision) => revisionValue(ctx, revision))),
    };
  },
});

export const set = mutation({
  args: { table: v.string(), rowId: v.string(), revId: v.string() },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    const target = await revisionRow(ctx, args.table, args.rowId, args.revId);
    if (!target) throw new Error("Revision not found.");
    await revisionCrdtSet(ctx, target);
    const current = await ctx.db
      .query("revisions")
      .withIndex("by_table_and_rowid_and_status", (q) =>
        q.eq("table", args.table).eq("rowId", args.rowId).eq("status", "active"),
      )
      .take(2);
    if (current.length > 1) throw new Error("Revision active pointer is inconsistent.");
    let priorActive: (typeof current)[number] | undefined;
    for (const revision of current) {
      if (revision.status === "active" && revision._id !== target._id) {
        await ctx.db.patch("revisions", revision._id, { status: "retained" });
        priorActive = revision;
      }
    }
    const parentRevId =
      priorActive && !(await revisionReaches(ctx, priorActive.parentRevId, target.revId))
        ? priorActive.revId
        : target.parentRevId;
    await ctx.db.patch("revisions", target._id, { status: "active", parentRevId });
    return revisionValue(ctx, { ...target, status: "active" as const, parentRevId });
  },
});

export const ack = mutation({
  args: { table: v.string(), rowId: v.string(), revId: v.string() },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    const target = await revisionRow(ctx, args.table, args.rowId, args.revId);
    if (!target) throw new Error("Revision not found.");
    if (target.status !== "active") {
      await ctx.db.patch("revisions", target._id, { status: "acknowledged" });
      target.status = "acknowledged";
    }
    return revisionValue(ctx, target);
  },
});

const remove = mutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    revId: v.string(),
    numItems: v.number(),
  },
  returns: deleteProgressValidator,
  handler: async (ctx, args) => {
    const target = await revisionRow(ctx, args.table, args.rowId, args.revId);
    if (!target) return deleteProgress(0, true);
    if (target.status === "active") throw new Error("The active revision cannot be deleted.");
    const limit = clamp(args.numItems);
    const crdt = await ctx.db
      .query("revisionCrdt")
      .withIndex("by_revid", (q) => q.eq("revId", target.revId))
      .take(limit + 1);
    const page = crdt.slice(0, limit);
    for (const row of page) await ctx.db.delete("revisionCrdt", row._id);
    if (page.length === limit) return deleteProgress(page.length, false);
    await ctx.db.delete("revisions", target._id);
    return deleteProgress(page.length + 1, true);
  },
});

export { remove as delete };

async function revisionRead(ctx: QueryCtx, table: string, rowId: string, revId: string) {
  const row = await revisionRow(ctx, table, rowId, revId);
  return row ? revisionValue(ctx, row) : null;
}

async function revisionReaches(
  ctx: QueryCtx,
  parentRevId: string | undefined,
  targetRevId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let cursor = parentRevId;
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === targetRevId) return true;
    seen.add(cursor);
    const row = await ctx.db
      .query("revisions")
      .withIndex("by_revid", (q) => q.eq("revId", cursor!))
      .unique();
    cursor = row?.parentRevId;
  }
  return false;
}

async function revisionRow(ctx: QueryCtx, table: string, rowId: string, revId: string) {
  const row = await ctx.db
    .query("revisions")
    .withIndex("by_revid", (q) => q.eq("revId", revId))
    .unique();
  return row?.table === table && row.rowId === rowId ? row : null;
}

async function revisionValue(
  ctx: QueryCtx,
  row: NonNullable<Awaited<ReturnType<typeof revisionRow>>>,
) {
  const crdt = await ctx.db
    .query("revisionCrdt")
    .withIndex("by_revid", (q) => q.eq("revId", row.revId))
    .take(MAX_CRDT_FIELDS + 1);
  if (crdt.length > MAX_CRDT_FIELDS) throw new Error("Revision has too many CRDT fields.");
  return {
    revId: row.revId,
    groupId: row.groupId,
    table: row.table,
    rowId: row.rowId,
    origin: row.origin,
    status: row.status,
    parentRevId: row.parentRevId,
    createdAt: row.createdAt,
    deleted: row.deleted,
    value: row.value,
    crdt: crdt.map((field) => ({
      field: field.field,
      kind: field.kind,
      projectionHash: field.projectionHash,
    })),
  };
}

function revisionStream(ctx: QueryCtx, args: RevisionFilter) {
  const revisions = paginator(ctx.db, schema).query("revisions");
  if (args.table !== undefined && args.status !== undefined && args.origin !== undefined) {
    return revisions
      .withIndex("by_table_and_status_and_origin_and_createdat", (q) => {
        const range = q
          .eq("table", args.table!)
          .eq("status", args.status!)
          .eq("origin", args.origin!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.table !== undefined && args.status !== undefined) {
    return revisions
      .withIndex("by_table_and_status_and_createdat", (q) => {
        const range = q.eq("table", args.table!).eq("status", args.status!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.table !== undefined && args.origin !== undefined) {
    return revisions
      .withIndex("by_table_and_origin_and_createdat", (q) => {
        const range = q.eq("table", args.table!).eq("origin", args.origin!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.status !== undefined && args.origin !== undefined) {
    return revisions
      .withIndex("by_status_and_origin_and_createdat", (q) => {
        const range = q.eq("status", args.status!).eq("origin", args.origin!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.table !== undefined) {
    return revisions
      .withIndex("by_table_and_createdat", (q) => {
        const range = q.eq("table", args.table!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.status !== undefined) {
    return revisions
      .withIndex("by_status_and_createdat", (q) => {
        const range = q.eq("status", args.status!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  if (args.origin !== undefined) {
    return revisions
      .withIndex("by_origin_and_createdat", (q) => {
        const range = q.eq("origin", args.origin!);
        return args.createdBefore === undefined ? range : range.lt("createdAt", args.createdBefore);
      })
      .order("desc");
  }
  return revisions
    .withIndex("by_createdat", (q) =>
      args.createdBefore === undefined ? q : q.lt("createdAt", args.createdBefore),
    )
    .order("desc");
}

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("numItems must be a positive integer.");
  }
  return Math.min(value, MAX_DELETE);
}

function revisionPageLimit(value: number): number {
  return Math.min(clamp(value), MAX_REVISION_PAGE);
}

function revisionKey(createdAt: number, revId: string): string {
  return `${String(Math.trunc(createdAt)).padStart(16, "0")}:${revId}`;
}

async function revisionInsert(
  ctx: MutationCtx,
  args: {
    table: string;
    rowId: string;
    value?: unknown;
    deleted: boolean;
    origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
    replay?: { mutationId: string; ordinal: number; createdAt: number };
    snapshots?: RevisionCheckpointArgs["snapshots"];
  },
) {
  const snapshots = args.snapshots;
  const fields = snapshots
    ? []
    : await ctx.db
        .query("crdtFields")
        .withIndex("by_table_and_rowid_and_field", (q) =>
          q.eq("table", args.table).eq("rowId", args.rowId),
        )
        .take(MAX_CRDT_FIELDS + 1);
  if (fields.length > MAX_CRDT_FIELDS || (snapshots?.length ?? 0) > MAX_CRDT_FIELDS) {
    throw new Error("Revision has too many CRDT fields.");
  }

  const snapshotFields = new Set<string>();
  for (const snapshot of snapshots ?? []) {
    if (snapshotFields.has(snapshot.field)) {
      throw new Error(`Revision has duplicate CRDT snapshot ${snapshot.field}.`);
    }
    snapshotFields.add(snapshot.field);
    if (snapshot.hash !== (await bytesHash(snapshot.bytes))) {
      throw new Error(`Revision snapshot hash does not match ${snapshot.field}.`);
    }
    if (
      snapshot.projectionHash !==
      (await hashValue(valueAtPath(args.deleted ? undefined : args.value, snapshot.field)))
    ) {
      throw new Error(`Revision snapshot projection does not match ${snapshot.field}.`);
    }
  }

  const checkpoints = [] as Array<{
    field: string;
    kind: (typeof fields)[number]["kind"];
    checkpointId: NonNullable<Awaited<ReturnType<typeof readyCheckpointRead>>>["_id"];
    projectionHash: string;
    hash: string;
  }>;
  for (const field of fields) {
    if (field.detached) continue;
    const checkpoint = await readyCheckpointRead(ctx, field._id, field.epoch, field.headSeq);
    if (!checkpoint) {
      throw new Error(`Revision requires a ready checkpoint for ${args.table}.${field.field}.`);
    }
    checkpoints.push({
      field: field.field,
      kind: field.kind,
      checkpointId: checkpoint._id,
      projectionHash: field.projectionHash,
      hash: (await readyBlobRead(ctx, checkpoint.blobId!)).hash,
    });
  }

  const crdt = snapshots ?? checkpoints;
  const fingerprint = await hashValue({
    deleted: args.deleted,
    value: args.deleted ? null : args.value,
    crdt: crdt.map(({ field, kind, projectionHash, hash }) => ({
      field,
      kind,
      projectionHash,
      hash,
    })),
  });
  if (args.origin !== "savepoint") {
    const existingRows = await ctx.db
      .query("revisions")
      .withIndex("by_table_and_rowid_and_fingerprint", (q) =>
        q.eq("table", args.table).eq("rowId", args.rowId).eq("fingerprint", fingerprint),
      )
      .take(1);
    const existing = existingRows[0];
    if (existing) return await revisionValue(ctx, existing);
  }

  const revId = args.replay
    ? await replayUuid(args.replay.mutationId, args.replay.ordinal, "revision")
    : crypto.randomUUID();
  const groupId = args.replay
    ? await replayUuid(args.replay.mutationId, args.replay.ordinal, "group")
    : crypto.randomUUID();
  const createdAt = args.replay?.createdAt ?? readTime();
  await ctx.db.insert("revisions", {
    key: revisionKey(createdAt, revId),
    revId,
    groupId,
    table: args.table,
    rowId: args.rowId,
    origin: args.origin,
    status: "retained",
    value: args.value,
    deleted: args.deleted,
    fingerprint,
    createdAt,
  });
  for (const snapshot of snapshots ?? []) {
    await ctx.db.insert("revisionCrdt", {
      revId,
      field: snapshot.field,
      kind: snapshot.kind,
      projectionHash: snapshot.projectionHash,
      headSeq: snapshot.headSeq,
      bytes: snapshot.bytes,
      hash: snapshot.hash,
    });
  }
  for (const checkpoint of checkpoints) {
    await ctx.db.insert("revisionCrdt", {
      revId,
      field: checkpoint.field,
      kind: checkpoint.kind,
      checkpointId: checkpoint.checkpointId,
      projectionHash: checkpoint.projectionHash,
    });
  }
  const revision = await revisionRead(ctx, args.table, args.rowId, revId);
  if (!revision) throw new Error("Created revision was not readable.");
  return revision;
}

async function replayUuid(mutationId: string, ordinal: number, kind: "revision" | "group") {
  const digest = await hashValue({ kind, mutationId, ordinal });
  const bytes = Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function revisionCrdtSet(
  ctx: MutationCtx,
  target: NonNullable<Awaited<ReturnType<typeof revisionRow>>>,
): Promise<void> {
  const links = await ctx.db
    .query("revisionCrdt")
    .withIndex("by_revid", (q) => q.eq("revId", target.revId))
    .take(MAX_CRDT_FIELDS + 1);
  if (links.length > MAX_CRDT_FIELDS) throw new Error("Revision has too many CRDT fields.");
  const byField = new Map(links.map((link) => [link.field, link]));
  for (const link of links) {
    if (link.bytes !== undefined && link.hash !== undefined && link.headSeq !== undefined) {
      if (link.hash !== (await bytesHash(link.bytes))) {
        throw new Error(`Revision snapshot for ${target.table}.${link.field} is corrupt.`);
      }
      byField.delete(link.field);
    }
  }
  const fields = await ctx.db
    .query("crdtFields")
    .withIndex("by_table_and_rowid_and_field", (q) =>
      q.eq("table", target.table).eq("rowId", target.rowId),
    )
    .take(MAX_CRDT_FIELDS + 1);
  if (fields.length > MAX_CRDT_FIELDS) throw new Error("Document has too many CRDT fields.");

  for (const field of fields) {
    if (field.detached) continue;
    const link = byField.get(field.field);
    const epoch = field.epoch + 1;
    if (!link) {
      await ctx.db.patch("crdtFields", field._id, {
        epoch,
        headSeq: 0,
        projectionHash: await hashValue(valueAtPath(target.value, field.field)),
        payloads: 0,
        payloadBytes: 0,
        detached: target.deleted,
        updatedAt: readTime(),
      });
      continue;
    }
    if (link.bytes !== undefined && link.hash !== undefined && link.headSeq !== undefined) {
      if (link.hash !== (await bytesHash(link.bytes))) {
        throw new Error(`Revision snapshot for ${target.table}.${field.field} is corrupt.`);
      }
      byField.delete(field.field);
      continue;
    }
    if (!link.checkpointId) {
      throw new Error(`Revision CRDT link for ${target.table}.${field.field} is incomplete.`);
    }
    const checkpoint = await ctx.db.get("crdtCheckpoints", link.checkpointId);
    if (!checkpoint || checkpoint.state !== "ready" || checkpoint.blobId === undefined) {
      throw new Error(`Revision checkpoint for ${target.table}.${field.field} is not ready.`);
    }
    await ctx.db.patch("crdtFields", field._id, {
      epoch,
      headSeq: checkpoint.throughSeq,
      projectionHash: link.projectionHash,
      payloads: 0,
      payloadBytes: 0,
      detached: false,
      updatedAt: readTime(),
    });
    await ctx.db.insert("crdtCheckpoints", {
      fieldId: field._id,
      epoch,
      throughSeq: checkpoint.throughSeq,
      projectionHash: link.projectionHash,
      responseToken: crypto.randomUUID(),
      state: "ready",
      blobId: checkpoint.blobId,
      createdAt: readTime(),
      updatedAt: readTime(),
    });
    byField.delete(field.field);
  }
  if (byField.size > 0) {
    throw new Error("Revision references a CRDT field that is no longer present.");
  }
}

async function readyCheckpointRead(
  ctx: QueryCtx,
  fieldId: Parameters<MutationCtx["db"]["get"]>[0],
  epoch: number,
  headSeq: number,
) {
  return await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_seq", (q) =>
      q
        .eq("fieldId", fieldId as never)
        .eq("epoch", epoch)
        .eq("state", "ready")
        .eq("throughSeq", headSeq),
    )
    .unique();
}

async function inlineBlobWrite(ctx: MutationCtx, bytes: ArrayBuffer, hash: string) {
  let blob = await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
  if (blob) {
    if (blob.state !== "ready" || blob.bytes !== bytes.byteLength || blob.chunks !== 1) {
      throw new Error("Revision checkpoint conflicts with its blob manifest.");
    }
    return blob._id;
  }
  const now = readTime();
  const blobId = await ctx.db.insert("blobs", {
    hash,
    bytes: bytes.byteLength,
    chunks: 1,
    state: "ready",
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("blobChunks", { blobId, ordinal: 0, bytes, hash });
  return blobId;
}

async function readyBlobRead(ctx: QueryCtx, blobId: Parameters<QueryCtx["db"]["get"]>[0]) {
  const blob = await ctx.db.get("blobs", blobId as never);
  if (!blob || blob.state !== "ready") throw new Error("Revision checkpoint blob is not ready.");
  return blob;
}

async function blobBytesRead(
  ctx: QueryCtx,
  blob: NonNullable<Awaited<ReturnType<typeof readyBlobRead>>>,
) {
  const chunks = await ctx.db
    .query("blobChunks")
    .withIndex("by_blobid_and_ordinal", (q) => q.eq("blobId", blob._id))
    .take(blob.chunks + 1);
  if (chunks.length !== blob.chunks || chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal)) {
    throw new Error("Revision checkpoint blob is incomplete.");
  }
  const out = new Uint8Array(blob.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk.bytes), offset);
    offset += chunk.bytes.byteLength;
  }
  if (offset !== blob.bytes || (await bytesHash(out.buffer)) !== blob.hash) {
    throw new Error("Revision checkpoint blob is corrupt.");
  }
  return out.buffer;
}

function valueAtPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

async function bytesHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
