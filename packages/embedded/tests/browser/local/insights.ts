import { v } from "convex/values";

import { defineLocal } from "../../../src/local";
import schema from "../convex/schema";

const { query } = defineLocal(schema);

export const documentCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("documents").collect();
    return rows.length;
  },
});
