import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { internalMutation } from "./embedded";
import schema from "./schema";

const migrations = new Migrations(components.migrations, { internalMutation, schema });

export const normalizeUpdatedAt = migrations.define({
  table: "documents",
  customRange: (query) => query.withIndex("by_updatedAt", (q) => q.lt("updatedAt", 0)),
  migrateOne: (_ctx, document) => ({
    title: `migrated:${document.title}`,
    updatedAt: Math.abs(document.updatedAt),
  }),
});

export const run = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await ctx.runMutation(internal.migrations.normalizeUpdatedAt, {
      cursor: null,
      reset: true,
      oneBatchOnly: true,
    });
    return null;
  },
});
