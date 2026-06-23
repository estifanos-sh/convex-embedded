import { paginationOptsValidator } from "convex/server";
import type { DataModelFromSchemaDefinition, GenericQueryCtx, QueryBuilder } from "convex/server";
import { queryGeneric } from "convex/server";
import { v } from "convex/values";

import { crdtKindValidator } from "../model";
import schema from "../schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

const fieldValidator = v.object({
  id: v.string(),
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
  checkpoint: v.optional(
    v.object({
      id: v.string(),
      state: v.union(v.literal("requested"), v.literal("ready")),
      throughSeq: v.number(),
      bytes: v.optional(v.number()),
      createdAt: v.number(),
    }),
  ),
});

export const read = query({
  args: {
    table: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(fieldValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = clamp(args.paginationOpts.numItems);
    const cursor = args.paginationOpts.cursor ?? "";
    const rows = await (
      args.table === undefined
        ? ctx.db.query("crdtFields").withIndex("by_key", (q) => q.gt("key", cursor))
        : ctx.db
            .query("crdtFields")
            .withIndex("by_table_and_key", (q) => q.eq("table", args.table!).gt("key", cursor))
    ).take(limit + 1);
    const isDone = rows.length <= limit;
    const page = rows.slice(0, limit);

    return {
      isDone,
      continueCursor: page.at(-1)?.key ?? cursor,
      page: await Promise.all(page.map((field) => fieldValue(ctx, field))),
    };
  },
});

export const get = query({
  args: { table: v.string(), rowId: v.string(), field: v.string() },
  returns: v.union(fieldValidator, v.null()),
  handler: async (ctx, args) => {
    const field = await ctx.db
      .query("crdtFields")
      .withIndex("by_table_and_rowid_and_field", (q) =>
        q.eq("table", args.table).eq("rowId", args.rowId).eq("field", args.field),
      )
      .unique();
    return field ? await fieldValue(ctx, field) : null;
  },
});

async function fieldValue(
  ctx: GenericQueryCtx<DataModel>,
  field: DataModel["crdtFields"]["document"],
) {
  const checkpoints = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_fieldid_and_epoch_and_throughseq", (q) =>
      q.eq("fieldId", field._id).eq("epoch", field.epoch),
    )
    .order("desc")
    .take(1);
  const checkpoint = checkpoints[0] ?? null;
  const checkpointBlob = checkpoint?.blobId ? await ctx.db.get("blobs", checkpoint.blobId) : null;
  return {
    id: field._id,
    table: field.table,
    rowId: field.rowId,
    field: field.field,
    kind: field.kind,
    epoch: field.epoch,
    headSeq: field.headSeq,
    projectionHash: field.projectionHash,
    payloads: field.payloads,
    payloadBytes: field.payloadBytes,
    detached: field.detached,
    checkpoint:
      checkpoint === null
        ? undefined
        : {
            id: checkpoint._id,
            state: checkpoint.state,
            throughSeq: checkpoint.throughSeq,
            bytes: checkpointBlob?.bytes,
            createdAt: checkpoint.createdAt,
          },
  };
}

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("paginationOpts.numItems must be a positive integer.");
  }
  return Math.min(value, 1_024);
}
