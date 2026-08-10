import { local } from "../convex/embedded.generated.js";
import { v } from "convex/values";

export const toggleExpanded = local.mutation({
  args: { documentId: v.id("documents") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return false;
    const expanded = document.expanded !== true;
    await ctx.db.patch(args.documentId, { expanded });
    return expanded;
  },
});

export const expanded = local.query({
  args: {},
  returns: v.array(v.id("documents")),
  handler: async (ctx) => {
    const documents = await ctx.db.query("documents").collect();
    return documents
      .filter((document) => document.expanded === true)
      .map((document) => document._id);
  },
});
