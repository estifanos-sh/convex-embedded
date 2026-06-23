import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {
    identityKey: v.optional(v.string()),
    schemaHash: v.optional(v.string()),
    moduleGraphHash: v.optional(v.string()),
    protocolVersion: v.optional(v.number()),
    lastSeenBefore: v.optional(v.number()),
    retired: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, { identityKey, ...args }) =>
    await ctx.runQuery(components.embedded.remote.client.read, {
      ...args,
      ...(identityKey === undefined ? {} : { identity: { identityKey } }),
    }),
});

export const retire = mutation({
  args: {
    clientId: v.string(),
    expectedIdentity: v.optional(v.string()),
    expectedLastSeenAt: v.number(),
  },
  returns: v.union(
    v.object({ retirement: v.literal("retired") }),
    v.object({ retirement: v.literal("missing") }),
  ),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.embedded.remote.client.retire, {
      clientId: args.clientId,
      expectedLastSeenAt: args.expectedLastSeenAt,
      ...(args.expectedIdentity ? { expectedIdentity: args.expectedIdentity } : {}),
    }),
});
