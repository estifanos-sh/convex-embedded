import { type GenericId, v } from "convex/values";
import { internal } from "./_generated/api";
import { embedded } from "./embedded";
import { read as readTime } from "./time";

export const append = embedded.replicated.mutation({
  args: { id: v.id("documents") },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(0, internal.schedule.scheduledAppend, { id: args.id });
  },
});

export const appendAfter = embedded.replicated.mutation({
  args: { id: v.id("documents"), delayMs: v.number() },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(args.delayMs, internal.schedule.scheduledAppend, {
      id: args.id,
    });
  },
});

export const cancel = embedded.replicated.mutation({
  args: { scheduleId: v.id("_scheduled_functions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.cancel(args.scheduleId);
    return null;
  },
});

export const scheduledAppend = embedded.replicated.internalMutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) return null;
    const title = `${document.title}!`;
    const updatedAt = readTime();
    await ctx.db.patch(args.id, { title, updatedAt });
    return null;
  },
});
