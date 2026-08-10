import { v } from "convex/values";

import { local } from "../convex/embedded.generated";

const { query } = local;

export const scope = "device";

export const documentTitles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("documents").collect()).map((row) => row.title),
});
