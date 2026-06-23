import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { query } from "./embedded";

export * from "../../../../../convex/documents";

export const page = query({
  args: {
    paginationOpts: paginationOptsValidator,
    prefix: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("documents")
      .withIndex("by_title", (q) => q.gte("title", args.prefix).lt("title", `${args.prefix}\uffff`))
      .paginate(args.paginationOpts);
  },
});
