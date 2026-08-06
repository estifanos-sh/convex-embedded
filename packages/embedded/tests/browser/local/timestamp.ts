import { v } from "convex/values";

import { local } from "../convex/_generated/embedded";

/** Exercises the complete local runtime/storage timestamp boundary without requiring an app table. */
export const timestamp = local.mutation({
  args: {},
  returns: v.commitTs(),
  handler: (ctx) => ctx.db.vars.commitTs,
});
