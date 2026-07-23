import { v } from "convex/values";
import { embedded } from "./embedded";

export const url = embedded.replicated.mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});
