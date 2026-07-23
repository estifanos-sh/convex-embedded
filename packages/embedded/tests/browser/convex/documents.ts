import { v } from "convex/values";

import { embedded } from "./embedded";

export * from "../../../../../convex/documents";

const summaryValidator = v.object({
  _id: v.id("documents"),
  title: v.string(),
  updatedAt: v.number(),
});

/**
 * Bench-owned body-omitting projection over `documents` (`{_id, title, updatedAt}`). The demo folded
 * its list into `documents:read`, so the browser remote benchmark keeps this partial list in its own
 * fixture to exercise the engine's retained-result cache: a body edit leaves the projection
 * byte-identical and is cache-served, while a title edit rewrites it.
 */
export const summaries = embedded.replicated.query({
  args: {
    limit: v.optional(v.number()),
    prefix: v.optional(v.string()),
  },
  returns: v.array(summaryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(1_024, Math.max(1, Math.trunc(args.limit ?? 40)));
    const prefix = args.prefix;
    const rows =
      prefix === undefined
        ? await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(limit)
        : await ctx.db
            .query("documents")
            .withIndex("by_title", (q) => q.gte("title", prefix).lt("title", `${prefix}\uffff`))
            .take(limit);
    return rows.map((row) => ({ _id: row._id, title: row.title, updatedAt: row.updatedAt }));
  },
});
