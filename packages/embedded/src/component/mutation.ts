import { paginationOptsValidator } from "convex/server";
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import { identityKey } from "./identity";
import { deleteProgress, deleteProgressValidator } from "./model";
import schema from "./schema";
import { isAcknowledged } from "./settlement";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const identitySelectorValidator = v.union(
  v.object({ tokenIdentifier: v.string() }),
  v.object({ identityKey: v.string() }),
);
const outcomeValidator = v.union(
  v.literal("applied"),
  v.literal("conflict"),
  v.literal("rejected"),
);

export const read = query({
  args: {
    identity: v.optional(identitySelectorValidator),
    acknowledged: v.optional(v.boolean()),
    settledBefore: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        mutationId: v.string(),
        clientId: v.string(),
        identity: v.optional(v.string()),
        outcome: outcomeValidator,
        settledAt: v.number(),
        acknowledged: v.boolean(),
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
        ? database.query("mutations").withIndex("by_identity_and_settledat")
        : args.settledBefore === undefined
          ? database
              .query("mutations")
              .withIndex("by_identity_and_settledat", (q) => q.eq("identity", selectedIdentity))
          : database
              .query("mutations")
              .withIndex("by_identity_and_settledat", (q) =>
                q.eq("identity", selectedIdentity).lt("settledAt", args.settledBefore!),
              );
    const clients = new Map<string, DataModel["clients"]["document"] | null>();
    const rows = await stream
      .order("desc")
      .map(async (row) => {
        if (
          selectedIdentity === undefined &&
          args.settledBefore !== undefined &&
          row.settledAt >= args.settledBefore
        ) {
          return null;
        }
        let client = clients.get(row.clientId);
        if (row.clientId !== "hosted" && client === undefined) {
          client = await ctx.db
            .query("clients")
            .withIndex("by_clientid", (q) => q.eq("clientId", row.clientId))
            .unique();
          clients.set(row.clientId, client);
        }
        const acknowledged = isAcknowledged(row, client ?? undefined);
        return {
          mutationId: row.mutationId,
          clientId: row.clientId,
          ...(row.identity === undefined ? {} : { identity: row.identity }),
          outcome: row.settlement.outcome as Exclude<typeof row.settlement.outcome, "rebase">,
          settledAt: row.settledAt,
          acknowledged,
        };
      })
      .filterWith(
        async (row) => args.acknowledged === undefined || args.acknowledged === row.acknowledged,
      )
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: limit,
        maximumRowsRead: limit + 1,
      });
    return {
      page: rows.page,
      isDone: rows.isDone,
      continueCursor: rows.continueCursor,
    };
  },
});

const remove = mutation({
  args: {
    clientId: v.optional(v.string()),
    identity: v.optional(identitySelectorValidator),
    settledBefore: v.number(),
    numItems: v.number(),
  },
  returns: deleteProgressValidator,
  handler: async (ctx, args) => {
    const limit = clamp(args.numItems);
    const selectedIdentity = args.identity ? await identityKey(args.identity) : undefined;
    if (args.clientId === undefined && selectedIdentity === undefined) {
      throw new Error("Settlement deletion requires a clientId or identity selector.");
    }
    const rows = await (
      args.clientId !== undefined
        ? ctx.db
            .query("mutations")
            .withIndex("by_clientid_and_settledat", (q) =>
              q.eq("clientId", args.clientId!).lt("settledAt", args.settledBefore),
            )
        : ctx.db
            .query("mutations")
            .withIndex("by_identity_and_settledat", (q) =>
              q.eq("identity", selectedIdentity!).lt("settledAt", args.settledBefore),
            )
    ).take(limit + 1);
    let deleted = 0;
    for (const row of rows.slice(0, limit)) {
      const client = await ctx.db
        .query("clients")
        .withIndex("by_clientid", (q) => q.eq("clientId", row.clientId))
        .unique();
      if (!isAcknowledged(row, client)) {
        throw new Error("Cannot delete a settlement an active client has not acknowledged.");
      }
      await ctx.db.delete("mutations", row._id);
      deleted += 1;
    }
    return deleteProgress(deleted, rows.length <= limit);
  },
});

export { remove as delete };

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("numItems must be a positive integer.");
  }
  return Math.min(value, 1_024);
}
