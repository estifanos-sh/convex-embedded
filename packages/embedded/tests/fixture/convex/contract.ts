import { v } from "convex/values";

import { query } from "./embedded";

/** Versioned sentinel that exists only on the isolated remote-test deployment. */
export const read = query({
  args: {},
  returns: v.object({
    fixture: v.literal("@convex-dev/embedded/remote-test-fixture"),
    version: v.literal(1),
  }),
  handler: () => ({
    fixture: "@convex-dev/embedded/remote-test-fixture" as const,
    version: 1 as const,
  }),
});
