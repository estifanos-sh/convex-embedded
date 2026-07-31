import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { remote } from "./embedded";

export const read = remote.query({
  args: {
    state: v.optional(v.union(v.literal("referenced"), v.literal("unreferenced"))),
    updatedBefore: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.runQuery(components.embedded.file.read, args),
});

export const remove = remote.mutation({
  args: { storageId: v.string(), expectedVersion: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.runMutation(components.embedded.file.delete, args),
});
