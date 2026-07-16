import { paginationOptsValidator } from "convex/server";
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

export const read = query({
  args: {
    state: v.optional(v.union(v.literal("referenced"), v.literal("unreferenced"))),
    updatedBefore: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        storageId: v.string(),
        references: v.number(),
        version: v.number(),
        updatedAt: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = clamp(args.paginationOpts.numItems);
    const rows = await paginator(ctx.db, schema)
      .query("files")
      .withIndex("by_storageid")
      .filterWith(
        async (file) =>
          (args.state === undefined ||
            (args.state === "referenced" ? file.references > 0 : file.references === 0)) &&
          (args.updatedBefore === undefined || file.updatedAt < args.updatedBefore),
      )
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: limit,
        maximumRowsRead: limit + 1,
      });
    return {
      isDone: rows.isDone,
      continueCursor: rows.continueCursor,
      page: rows.page.map((file) => ({
        storageId: file.storageId,
        references: file.references,
        version: file.version,
        updatedAt: file.updatedAt,
      })),
    };
  },
});

const deletion = mutation({
  args: { storageId: v.string(), expectedVersion: v.number() },
  returns: v.union(
    v.object({ deletion: v.literal("deleted") }),
    v.object({ deletion: v.literal("missing") }),
    v.object({ deletion: v.literal("referenced") }),
    v.object({ deletion: v.literal("changed") }),
  ),
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("files")
      .withIndex("by_storageid", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (!file) return { deletion: "missing" as const };
    if (file.references !== 0) return { deletion: "referenced" as const };
    if (file.version !== args.expectedVersion) return { deletion: "changed" as const };
    await ctx.db.delete("files", file._id);
    return { deletion: "deleted" as const };
  },
});

export { deletion as delete };

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("paginationOpts.numItems must be a positive integer.");
  }
  return Math.min(value, 1_024);
}
