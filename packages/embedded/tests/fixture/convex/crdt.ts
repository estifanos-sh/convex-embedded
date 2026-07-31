import { v } from "convex/values";

import { components } from "./_generated/api";
import { remote } from "./embedded";

const deleteResultValidator = v.object({ deleted: v.number(), isDone: v.boolean() });

export const field = remote.query({
  args: { rowId: v.id("documents"), field: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.rowId);
    if (!document) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.crdt.field.get, {
      table: "documents",
      rowId: args.rowId,
      field: args.field,
    });
  },
});

export const checkpoint = remote.mutation({
  args: { rowId: v.id("documents"), field: v.string() },
  returns: v.object({
    checkpointId: v.string(),
    state: v.union(v.literal("requested"), v.literal("ready")),
  }),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.rowId);
    if (!document) throw new Error("Document not found.");
    return await ctx.runMutation(components.embedded.crdt.checkpoint.write, {
      table: "documents",
      rowId: args.rowId,
      field: args.field,
    });
  },
});

export const payloadDelete = remote.mutation({
  args: { checkpointId: v.string(), numItems: v.number() },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.embedded.crdt.payload.delete, args);
  },
});

export const clear = remote.mutation({
  args: { fieldId: v.string(), expectedEpoch: v.number(), numItems: v.number() },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.embedded.crdt.clear, args);
  },
});

export const revisionDelete = remote.mutation({
  args: { rowId: v.id("documents"), revId: v.string(), numItems: v.number() },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.embedded.rev.delete, {
      table: "documents",
      rowId: args.rowId,
      revId: args.revId,
      numItems: args.numItems,
    });
  },
});
