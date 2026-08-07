import { v } from "convex/values";

import { remote } from "./embedded";

/** Versioned sentinel that exists only on the isolated remote-test deployment. */
export const read = remote.query({
  args: {},
  returns: v.object({
    fixture: v.literal("@estifanos-sh/convex-embedded/remote-test-fixture"),
    version: v.literal(1),
  }),
  handler: () => ({
    fixture: "@estifanos-sh/convex-embedded/remote-test-fixture" as const,
    version: 1 as const,
  }),
});
