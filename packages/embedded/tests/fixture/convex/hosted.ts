import { v } from "convex/values";

import { action } from "./_generated/server";

export const echo = action({
  args: { value: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => args.value,
});
