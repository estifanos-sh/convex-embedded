import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const get = query({
  args: { rowId: v.id("documents"), revId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.rowId);
    if (!document) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.rev.get, {
      table: "documents",
      rowId: args.rowId,
      revId: args.revId,
    });
  },
});

export const list = query({
  args: { rowId: v.id("documents"), cursor: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.rowId);
    if (!document) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.rev.list, {
      table: "documents",
      rowId: args.rowId,
      paginationOpts: { cursor: args.cursor, numItems: 100 },
    });
  },
});

export const scan = query({
  args: {
    table: v.optional(v.string()),
    origin: v.optional(
      v.union(
        v.literal("savepoint"),
        v.literal("conflict"),
        v.literal("rejected"),
        v.literal("displaced"),
        v.literal("delete"),
      ),
    ),
    status: v.optional(
      v.union(v.literal("active"), v.literal("retained"), v.literal("acknowledged")),
    ),
    createdBefore: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.runQuery(components.embedded.rev.list, args),
});

export const remove = mutation({
  args: { table: v.string(), rowId: v.string(), revId: v.string(), numItems: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.runMutation(components.embedded.rev.delete, args),
});
