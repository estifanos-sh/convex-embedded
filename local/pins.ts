import { local } from "@convex-dev/embedded/local";
import { v } from "convex/values";

export const toggle = local.mutation({
  args: { documentId: v.id("documents") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pin = await ctx.db
      .query("pins")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .unique();
    if (pin) {
      await ctx.db.delete(pin._id);
      return false;
    }
    await ctx.db.insert("pins", { documentId: args.documentId });
    return true;
  },
});

export const pinned = local.query({
  args: {},
  returns: v.array(v.id("documents")),
  handler: async (ctx) => {
    const pins = await ctx.db.query("pins").collect();
    const documents = await Promise.all(pins.map((pin) => ctx.db.get(pin.documentId)));
    return documents.filter((document) => document !== null).map((document) => document._id);
  },
});
