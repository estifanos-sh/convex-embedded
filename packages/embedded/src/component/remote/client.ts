import { paginationOptsValidator } from "convex/server";
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import { identityKey } from "../identity";
import { CURRENT_WIRE_CONTRACT_ID } from "../../protocol";
import schema from "../schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const identitySelectorValidator = v.union(
  v.object({ tokenIdentifier: v.string() }),
  v.object({ identityKey: v.string() }),
);

export const read = query({
  args: {
    identity: v.optional(identitySelectorValidator),
    schemaHash: v.optional(v.string()),
    moduleGraphHash: v.optional(v.string()),
    contractId: v.optional(v.string()),
    lastSeenBefore: v.optional(v.number()),
    retired: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        clientId: v.string(),
        identity: v.optional(v.string()),
        schemaHash: v.string(),
        moduleGraphHash: v.string(),
        contractId: v.literal(CURRENT_WIRE_CONTRACT_ID),
        lastSeenAt: v.number(),
        lastPushAt: v.optional(v.number()),
        retired: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = clamp(args.paginationOpts.numItems);
    const selectedIdentity = args.identity ? await identityKey(args.identity) : undefined;
    const database = paginator(ctx.db, schema);
    const stream =
      selectedIdentity === undefined
        ? database.query("clients").withIndex("by_lastseenat")
        : database
            .query("clients")
            .withIndex("by_identity_and_lastseenat", (q) => q.eq("identity", selectedIdentity));
    const rows = await stream
      .filterWith(
        async (client) =>
          client.clientId !== "hosted" &&
          (args.schemaHash === undefined || client.schemaHash === args.schemaHash) &&
          (args.moduleGraphHash === undefined || client.moduleGraphHash === args.moduleGraphHash) &&
          (args.contractId === undefined || client.contractId === args.contractId) &&
          (args.lastSeenBefore === undefined || client.lastSeenAt < args.lastSeenBefore) &&
          (args.retired === undefined || client.retired === args.retired),
      )
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: limit,
        maximumRowsRead: limit + 1,
      });
    return {
      isDone: rows.isDone,
      continueCursor: rows.continueCursor,
      page: rows.page.map((client) => ({
        clientId: client.clientId,
        ...(client.identity === undefined ? {} : { identity: client.identity }),
        schemaHash: client.schemaHash,
        moduleGraphHash: client.moduleGraphHash,
        contractId: client.contractId,
        lastSeenAt: client.lastSeenAt,
        ...(client.lastPushAt === undefined ? {} : { lastPushAt: client.lastPushAt }),
        retired: client.retired,
      })),
    };
  },
});

export const retire = mutation({
  args: {
    clientId: v.string(),
    expectedLastSeenAt: v.number(),
    expectedIdentity: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ retirement: v.literal("retired") }),
    v.object({ retirement: v.literal("missing") }),
  ),
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_clientid", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) return { retirement: "missing" as const };
    if (client.lastSeenAt !== args.expectedLastSeenAt) {
      throw new Error("Remote client changed after it was selected for retirement.");
    }
    if (args.expectedIdentity !== undefined && client.identity !== args.expectedIdentity) {
      throw new Error("Remote client identity changed after it was selected for retirement.");
    }
    if (!client.retired) await ctx.db.patch("clients", client._id, { retired: true });

    return { retirement: "retired" as const };
  },
});

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("paginationOpts.numItems must be a positive integer.");
  }
  return Math.min(value, 1_024);
}
