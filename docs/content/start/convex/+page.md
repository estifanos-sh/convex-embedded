---
title: Configure Convex
description: Install the component and export the canonical Embedded server and replication endpoints.
---

# Configure Convex

Install the component once in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import embedded from "@estifanos-sh/convex-embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

Create one Embedded server definition in the canonical
`convex/embedded.ts` module:

```ts
import { defineEmbedded } from "@estifanos-sh/convex-embedded/server";

import { components } from "./_generated/api";
import { embeddedManifest } from "./embedded.generated";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  manifest: embeddedManifest,
  schema,
});

export const { remote, replicated } = embedded;
export const { pull, push, upload } = embedded;
```

The native replication driver always uses these canonical `pull` and `push`
exports. Their paths are deliberately not configurable.

`upload` is the authenticated endpoint the device actor uses to mint a hosted
storage capability while draining a local file. It is not an unauthenticated
application upload endpoint.

## Write a replicated function

Replicated functions use standard Convex authorization and database APIs:

```ts
// convex/documents.ts
import { ConvexError, v } from "convex/values";
import { replicated } from "./embedded";

export const list = replicated.query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    return await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("owner", identity.tokenIdentifier))
      .collect();
  },
});

export const create = replicated.mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    return await ctx.db.insert("documents", {
      body,
      owner: identity.tokenIdentifier,
    });
  },
});
```

Use `remote` for hosted-only functions. Device-only functions use the generated
`local` builder described in [Local functions](/concepts/functions).

## Application-owned uploads

For a normal upload flow, write an authorized Convex mutation:

```ts
export const createUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    if ((await ctx.auth.getUserIdentity()) === null) {
      throw new Error("UNAUTHENTICATED");
    }
    return await ctx.storage.generateUploadUrl();
  },
});
```
