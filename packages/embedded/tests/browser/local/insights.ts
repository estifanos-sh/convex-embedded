import { v } from "convex/values";

import { local } from "../convex/embedded.generated";

const { query } = local;

export const documentCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("documents").collect();
    return rows.length;
  },
});
