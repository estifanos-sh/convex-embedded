import { Migrations } from "@convex-dev/migrations";

import { components, internal } from "./_generated/api";
import { embedded } from "./embedded";
import schema from "./schema";

const migrations = new Migrations(components.migrations, {
  internalMutation: embedded.remote.internalMutation,
  schema,
});

export const normalizeUpdatedAt = migrations.define({
  table: "documents",
  customRange: (query) => query.withIndex("by_updatedAt", (q) => q.lt("updatedAt", 0)),
  migrateOne: (_ctx, document) => ({
    title: `migrated:${document.title}`,
    updatedAt: Math.abs(document.updatedAt),
  }),
});

export const run = migrations.runner(internal.migrations.normalizeUpdatedAt);
