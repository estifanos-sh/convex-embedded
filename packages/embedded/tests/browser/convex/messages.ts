import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const send = mutation({
  args: { body: v.string(), channel: v.string() },
  returns: v.id("messages"),
  handler: (ctx, args) => ctx.db.insert("messages", args),
});

export const list = query({
  args: { channel: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      _creationTime: v.number(),
      body: v.string(),
      channel: v.string(),
    }),
  ),
  handler: (ctx, args) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .collect(),
});
