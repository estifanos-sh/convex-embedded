import { type Infer, v } from "convex/values";

import { delegate } from "./documents";
import { remote } from "./embedded";
import { documentValidator } from "../../../../../convex/documents";
import { history as remoteHistory, restore as remoteRestore } from "../../../../../convex/remote";
import { revisionValidator } from "../../../../../convex/rev";

/**
 * Remote-placement counterparts of the fixture's `documents` re-declarations. The device router
 * forwards a remote call to the deployment on the strength of its manifest entry alone, so these
 * exist to put `remote:history`/`remote:restore` in the browser build's manifest; the deployment
 * runs the demo's own handlers.
 */
export const history = remote.query({
  args: {
    id: v.id("documents"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.any(),
  handler: (ctx, args): Promise<unknown> => delegate(remoteHistory, ctx, args),
});

export const restore = remote.mutation({
  args: { id: v.id("documents"), revId: v.string() },
  returns: v.object({ document: documentValidator, revision: revisionValidator }),
  handler: (
    ctx,
    args,
  ): Promise<{
    document: Infer<typeof documentValidator>;
    revision: Infer<typeof revisionValidator>;
  }> => delegate(remoteRestore, ctx, args),
});
