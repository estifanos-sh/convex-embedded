import { ConvexError, v } from "convex/values";

import { embedded } from "./embedded";
import { read as readTime } from "./time";

export const read = embedded.replicated.query({
  args: { id: v.id("documents") },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }
    return await ctx.db.get(args.id);
  },
});

export const deniedQuery = embedded.replicated.query({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.get(args.id);
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }
    return null;
  },
});

export const deniedMutation = embedded.replicated.mutation({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }
    await ctx.db.insert("documents", {
      body: "",
      slug: args.slug,
      title: args.slug,
      updatedAt: readTime(),
    });
    return null;
  },
});

export const deniedUpdate = embedded.replicated.mutation({
  args: { id: v.id("documents"), title: v.string(), updatedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }
    await ctx.db.patch(args.id, { title: args.title, updatedAt: args.updatedAt });
    return null;
  },
});
