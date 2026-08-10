import { v } from "convex/values";

import { local } from "../convex/embedded.generated";

const ensureVersion = local.internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if ((await ctx.db.query("setupState").first()) === null) {
      await ctx.db.insert("setupState", { version: 1 });
    }
    return null;
  },
});

export const setup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(ensureVersion, {});
    return null;
  },
});

export const failingSetup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(ensureVersion, {});
    throw new Error("browser setup failed after a durable batch");
  },
});

export const otherSetup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: () => null,
});

export const setupVersions = local.query({
  args: {},
  returns: v.array(v.number()),
  handler: async (ctx) => (await ctx.db.query("setupState").collect()).map((row) => row.version),
});
