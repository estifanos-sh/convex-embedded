import { v } from "convex/values";

import { mutation } from "./embedded";
import { read as readTime } from "./time";
import { mutation as rawMutation } from "./_generated/server";

export const updatePair = mutation({
  args: {
    first: v.id("documents"),
    second: v.id("documents"),
    firstTitle: v.string(),
    secondTitle: v.string(),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const first = await ctx.db.get(args.first);
    const second = await ctx.db.get(args.second);
    if (!first || !second) throw new Error("Document not found.");
    await ctx.db.patch(args.first, { title: `${args.firstTitle}-intermediate` });
    await ctx.db.patch(args.first, { title: args.firstTitle, updatedAt: args.updatedAt });
    await ctx.db.patch(args.second, { title: args.secondTitle, updatedAt: args.updatedAt });
    return null;
  },
});

export const insertNull = mutation({
  args: { slug: v.string(), title: v.string(), updatedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("documents", {
      body: "",
      slug: args.slug,
      title: args.title,
      updatedAt: args.updatedAt,
    });
    return null;
  },
});

/** Deliberately bypasses Embedded so rollback can be verified against an invalid target. */
export const rawMutationTarget = rawMutation({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("documents", {
      body: "",
      slug: args.slug,
      title: args.slug,
      updatedAt: readTime(),
    });
    return null;
  },
});
