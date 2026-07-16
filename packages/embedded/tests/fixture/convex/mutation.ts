import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const deleteResultValidator = v.object({ deleted: v.number(), isDone: v.boolean() });

export const list = query({
  args: {
    identityKey: v.optional(v.string()),
    acknowledged: v.optional(v.boolean()),
    settledBefore: v.optional(v.number()),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) =>
    await ctx.runQuery(components.embedded.mutation.read, {
      ...(args.identityKey === undefined ? {} : { identity: { identityKey: args.identityKey } }),
      ...(args.acknowledged === undefined ? {} : { acknowledged: args.acknowledged }),
      ...(args.settledBefore === undefined ? {} : { settledBefore: args.settledBefore }),
      paginationOpts: args.paginationOpts ?? { cursor: null, numItems: 100 },
    }),
});

export const settlement = query({
  args: {
    clientId: v.string(),
    mutationId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, { clientId, mutationId }) =>
    await ctx.runQuery(components.embedded.protocol.settlementRead, { clientId, mutationId }),
});

export const remove = mutation({
  args: {
    clientId: v.optional(v.string()),
    identityKey: v.optional(v.string()),
    settledBefore: v.number(),
    numItems: v.number(),
  },
  returns: deleteResultValidator,
  handler: async (ctx, args) =>
    await ctx.runMutation(components.embedded.mutation.delete, {
      settledBefore: args.settledBefore,
      numItems: args.numItems,
      ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
      ...(args.identityKey === undefined ? {} : { identity: { identityKey: args.identityKey } }),
    }),
});
