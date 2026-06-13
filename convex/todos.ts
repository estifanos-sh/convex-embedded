import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const todoValidator = v.object({
  _id: v.id("todos"),
  _creationTime: v.number(),
  text: v.string(),
  done: v.boolean(),
});

export const list = query({
  args: {},
  returns: v.array(todoValidator),
  handler: async (ctx) => {
    return await ctx.db.query("todos").order("desc").take(100);
  },
});

export const add = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) throw new Error("Todo text cannot be empty.");
    await ctx.db.insert("todos", { text, done: false });
    return null;
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.id);
    if (!todo) throw new Error("Todo not found.");
    await ctx.db.patch(args.id, { done: !todo.done });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("todos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return null;
  },
});

export const clearCompleted = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const completed = await ctx.db
      .query("todos")
      .withIndex("by_done", (q) => q.eq("done", true))
      .take(100);
    for (const todo of completed) await ctx.db.delete(todo._id);
    return null;
  },
});
