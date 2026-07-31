import { v } from "convex/values";

import { defineLocal } from "../../../src/local";
import schema from "../convex/schema";

const { query } = defineLocal(schema);

export const scope = "device";

export const documentTitles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("documents").collect()).map((row) => row.title),
});
