import { v } from "convex/values";
import { replicated } from "./embedded";

export const url = replicated.mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});
