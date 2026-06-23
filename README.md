# Embedded

Embedded is a local-first runtime for Convex. Application schemas, functions, authorization, and
data remain ordinary Convex code. The installed component owns private replication metadata; the
local SQLite runtime owns the device projection and all Loro computation.

The authoritative design and invariants are in
[`packages/embedded/V5.md`](packages/embedded/V5.md).

## Convex Setup

Install the component once:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import embedded from "@convex-dev/embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

Create the one Embedded server definition and export its protocol functions:

```ts
// convex/embedded.ts
import { defineEmbedded } from "@convex-dev/embedded/server";

import { components } from "./_generated/api";
import schema from "./schema";

export const { query, mutation, internalQuery, internalMutation, pull, push } = defineEmbedded({
  component: components.embedded,
  schema,
});
```

Application functions import those builders and use normal Convex authorization and database APIs:

```ts
// convex/documents.ts
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./embedded";

export const list = query({
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

export const create = mutation({
  args: { body: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    return await ctx.db.insert("documents", {
      owner: identity.tokenIdentifier,
      body: args.body,
    });
  },
});
```

There are no table capability declarations, protocol validators, generated engine tables, or raw
function-builder parameters in app code.

## Revisions

Revisions are component-owned CAS snapshots reached through app-authored functions. The app function
performs authorization, calls `components.embedded.rev.*`, and writes the selected value with normal
`ctx.db` operations in the same transaction.

```ts
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation } from "./embedded";

export const savepoint = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, { id }) => {
    const document = await requireOwnedDocument(ctx, id);
    const { _id, _creationTime, ...value } = document;
    return await ctx.runMutation(components.embedded.rev.create, {
      table: "documents",
      rowId: id,
      value,
      deleted: false,
    });
  },
});

export const restore = mutation({
  args: { id: v.id("documents"), revId: v.string() },
  handler: async (ctx, { id, revId }) => {
    await requireOwnedDocument(ctx, id);
    const revision = await ctx.runMutation(components.embedded.rev.set, {
      table: "documents",
      rowId: id,
      revId,
    });
    if (revision.deleted) await ctx.db.delete(id);
    else await ctx.db.replace(id, revision.value);
  },
});
```

The component also exposes `get`, paginated `list`, `ack`, and bounded `delete`. Retention and
cleanup are app policy expressed as ordinary functions, internal mutations, and crons.

## CRDT Fields

Declare collaborative fields with the values entrypoint and edit them through typed database
intents. Loro runs only in the local Rust/WASM runtime; Convex stores opaque payloads and ordinary
materialized values.

```ts
import { defineSchema, defineTable } from "convex/server";
import { text } from "@convex-dev/embedded/values";

export default defineSchema({
  documents: defineTable({ owner: v.string(), body: text() }).index("by_owner", ["owner"]),
});

await ctx.db.text.splice("documents", id, "body", {
  index: 0,
  delete: 0,
  insert: "hello",
});
```

## Clients

Use `@convex-dev/embedded/browser` in browser apps and `@convex-dev/embedded/node` in Node. Both
clients expose normal `query`, `mutation`, `action`, authentication, subscriptions, and storage
flows. Revisions are intentionally not a privileged client API; clients call the app functions
that authorize revision access.

The package also exports `vite`, `devtools`, `devtools/vite`, `values`, `server`, and
`convex.config` entrypoints. `unplugin` and `bundler` are low-level adapter surfaces.

## Develop

```bash
vp install
vp check
vp test
```
