import { v } from "convex/values";

import { defineLocal } from "@convex-dev/embedded/local";
import schema from "../convex/schema";

const local = defineLocal(schema);

/** Exercises the complete local runtime/storage timestamp boundary without requiring an app table. */
export const timestamp = local.mutation({
  args: {},
  returns: v.commitTs(),
  handler: (ctx) => ctx.db.vars.commitTs,
});
