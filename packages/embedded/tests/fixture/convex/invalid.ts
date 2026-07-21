import { v } from "convex/values";

import { embedded } from "./embedded";
import { read as readTime } from "./time";

/** Deliberately remote so rollback can be verified against an invalid replay target. */
export const rawMutationTarget = embedded.remote.mutation({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("documents", {
      body: "",
      slug: args.slug,
      title: args.slug,
      updatedAt: readTime(),
    });
    return null;
  },
});
