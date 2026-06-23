import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./embedded";

const checkpointValidator = v.object({
  checkpointId: v.string(),
  state: v.union(v.literal("requested"), v.literal("ready")),
});

export const checkpoint = mutation({
  args: { rowId: v.id("documents"), field: v.string() },
  returns: checkpointValidator,
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.rowId))) throw new Error("Document not found.");
    return await ctx.runMutation(components.embedded.crdt.checkpoint.write, {
      table: "documents",
      rowId: args.rowId,
      field: args.field,
    });
  },
});

export const field = query({
  args: { rowId: v.id("documents"), field: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.rowId))) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.crdt.field.get, {
      table: "documents",
      rowId: args.rowId,
      field: args.field,
    });
  },
});
