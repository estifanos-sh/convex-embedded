# Embedded

Embedded is a local-first runtime for Convex. Application schemas, functions, authorization, and
data remain ordinary Convex code. The installed component owns private replication metadata; the
local SQLite runtime owns the device projection and all Loro computation.

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

Revisions are retained document versions. They are not the compare-and-swap mechanism used by
replication, and they are not the internal CRDT checkpoints used to compact operation history.

Embedded uses optimistic validation while pushing a local mutation. That validation decides whether
the mutation still applies to the current Convex state. If concurrent work displaced a value, the
component can retain that value as a conflict revision; it does not create a revision merely because
a comparison occurred. Apps can also create explicit savepoints.

Revision access always goes through an app-authored function. The app function performs
authorization, calls `components.embedded.rev.*`, and, when restoring, writes the selected value with
normal `ctx.db` operations in the same transaction.

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
    const revision = await ctx.runMutation(components.embedded.rev.restore, {
      table: "documents",
      rowId: id,
      revId,
    });
    if (revision.deleted) await ctx.db.delete(id);
    else await ctx.db.replace(id, revision.value);
  },
});
```

The public revision surface is deliberately small:

- `create` makes an explicit savepoint.
- `get` reads one revision.
- `list` pages through a row's history or through retention candidates.
- `restore` selects a revision; the app wrapper updates its live row in the same transaction.
- `delete` removes one non-active revision.

Deletion is bounded because one revision can reference many CRDT records and a Convex mutation has
finite work limits. Pass `numItems` and repeat the call against the same revision until it returns
`{ isDone: true, deleted }`. There is no deletion cursor: every call removes the next remaining
records, so a cursor over the old state would be incorrect. The same `{ isDone, deleted }` result is
used by every bounded destructive component API.

The component does not expose a separate maintenance state or retention command. An app defines retention
policy by listing eligible retained revisions and scheduling bounded `delete` calls. The active
revision cannot be deleted.

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

### Browser storage

The browser client opens durable SQLite storage in OPFS when the browser allows it. It tests the
real open operation instead of inferring support from the user agent or the presence of
`navigator.storage.getDirectory`.

If the browser denies OPFS, the client opens the same SQLite schema with Turso's in-memory backend
and emits a `runtime` event with `degradation: "temporary-storage"`. This occurs in current Safari
and Firefox private browsing. Chromium supplies an in-memory filesystem for incognito profiles, so
the OPFS path can still open there; Chromium deletes that profile storage when the incognito session
ends.

Temporary storage lasts only as long as its worker context. A reload, tab discard, browser exit, or
private-session close may erase local documents and unsent mutations. A configured remote can pull
authoritative data into a new temporary store, but it cannot recover an offline mutation that the
browser erased before push.

`localStorage` holds only the small browser storage selector. It is not a database fallback: it is
synchronous, string-only, quota-limited, and lacks the transactions and file semantics SQLite
needs. Private browsers clear or isolate it too. An IndexedDB-backed SQLite VFS would be a separate
storage backend, not a safe use of `localStorage`.
