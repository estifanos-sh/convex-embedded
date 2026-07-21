# Embedded

Embedded is a local-first runtime for Convex. Application schemas, functions, authorization, and
data remain ordinary Convex code. The installed component owns private replication metadata; the
local SQLite runtime owns the device projection and all Loro computation.

## Requirements

- `convex` 1.42.1 or newer
- Node.js 24 or newer for the Node runtime and package build tools
- Cross-origin isolation for browser builds that use the threaded WASM runtime

Install the package alongside Convex:

```sh
pnpm add @convex-dev/embedded convex
```

## 1. Configure Convex

Install the component once:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import embedded from "@convex-dev/embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

Create one Embedded server definition and export its protocol functions:

```ts
// convex/embedded.ts
import { defineEmbedded } from "@convex-dev/embedded/server";

import { components } from "./_generated/api";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  schema,
});

export const { upload, pull, push } = embedded;
```

Application functions select an explicit placement and use normal Convex authorization and
database APIs:

```ts
// convex/documents.ts
import { ConvexError, v } from "convex/values";

import { embedded } from "./embedded";

export const list = embedded.replicated.query({
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

export const create = embedded.replicated.mutation({
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

Use `embedded.remote` for hosted-only queries and mutations and `embedded.local` for device-only
operations. Replicated functions see only replicated fields, remote functions see the hosted
document, and local functions see replicated fields plus device overlays.

### Placement model

Tables, fields, indexes, and functions use the same three placements:

| Schema declaration                                       | Hosted server | Replication wire | Device                  |
| -------------------------------------------------------- | ------------- | ---------------- | ----------------------- |
| `embeddedTable({...})`                                   | Yes           | Yes              | Yes                     |
| Plain `defineTable({...})` inside `defineEmbeddedSchema` | Yes           | No               | No                      |
| `localTable({...})`                                      | No            | No               | Yes                     |
| Unannotated field in an `embeddedTable`                  | Yes           | Yes              | Yes                     |
| `e.omit(validator)`                                      | Yes           | No               | No                      |
| `e.local(validator)`                                     | No            | No               | Optional device overlay |

An `e.local` field is stored separately from its replicated document. Pull, membership exit, and a
server deletion do not erase the overlay; if the row returns, the overlay is visible again. A local
mutation clears it by patching the field to `undefined`. Local overlays are scoped to the current
device identity and validated by the validator passed to `e.local`. Local functions may patch these
fields, but cannot insert, replace, or delete the replicated row.

A `localTable` owns complete device-only documents. Those rows are durable local state and change
only through local functions (or when the table is removed from the schema); they are never pushed,
pulled, or deployed to Convex.

Index placement follows its fields. A normal index containing only replicated fields exists on both
the server and device. If any indexed field uses `e.omit`, the index is hosted-only. An index may not
contain an `e.local` field. Search, vector, and staged indexes are supported on an `embeddedTable`
only when they are hosted-only; the embedded store does not implement those index kinds.

Device-only functions live in a `*.local.ts` module and are referenced through the generated local
API rather than Convex's hosted `_generated/api`:

```ts
// convex/preferences.local.ts
import { v } from "convex/values";
import { embedded } from "./embedded";

export const setCompact = embedded.local.mutation({
  args: { compact: v.boolean() },
  handler: async (ctx, { compact }) => {
    const current = await ctx.db.query("preferences").first();
    if (current) await ctx.db.patch("preferences", current._id, { compact });
    else await ctx.db.insert("preferences", { compact });
  },
});
```

```ts
// application code
import { localApi } from "./convex/_generated/embedded";

await client.mutation(localApi["preferences.local"].setCompact, { compact: true });
```

The build plugin regenerates `_generated/embedded.ts` from the schema and function graph. Treat it
like other generated Convex output: do not edit it by hand, and always pass the imported schema to
the plugin so stale placement metadata cannot enter a device build.

## 2. Configure the browser build

The browser package is more than a JavaScript import. A build must:

1. Discover locally executable Convex functions and provide them through Embedded's virtual module.
2. Build the module worker that owns SQLite and replication.
3. Emit the SQLite WASM module and its pthread worker so package-relative `new URL(...,
import.meta.url)` references remain valid.
4. Serve the application with cross-origin isolation headers.

### Vite and Vite+

Vite is the first-class, end-to-end tested browser integration. Add the Embedded plugin to the app's
Vite configuration:

```ts
// vite.config.ts
import { convexEmbedded } from "@convex-dev/embedded/vite";
import { defineConfig } from "vite";
import schema from "./convex/schema";

export default defineConfig({
  plugins: [convexEmbedded({ schema })],
});
```

`convexEmbedded({ schema })` supplies the virtual function registry to both the page and worker builds,
configures dependency optimization, enables browser function references before the application
loads, and adds these headers to Vite's development and preview servers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite+ uses the same plugin because it builds applications through Vite. Run the project through
`vp`; no separate Vite+ adapter is required.

The plugin options are relative to the Vite project root:

```ts
convexEmbedded({
  convexDir: "convex",
  schema,
  schemaPath: "schema.ts",
});
```

The paths above are the defaults; `schema` is required so every build regenerates and verifies the
device contract. Files in `convex/` with a top-level `"use node"` directive are hosted-only and are
intentionally excluded from the local registry.

### Rollup, Rolldown, Webpack, Rspack, and esbuild

The package exposes Unplugin adapters for projects that do not use Vite:

```ts
import { convexEmbeddedUnplugin } from "@convex-dev/embedded/unplugin";
import schema from "./convex/schema";

// Rollup
export default {
  plugins: [convexEmbeddedUnplugin.rollup({ schema })],
};
```

Use the matching adapter in other configurations:

```ts
convexEmbeddedUnplugin.rolldown({ schema });
convexEmbeddedUnplugin.webpack({ schema });
convexEmbeddedUnplugin.rspack({ schema });
convexEmbeddedUnplugin.esbuild({ schema });
```

These adapters provide function discovery and the virtual registry. They do **not** reproduce all
of the Vite adapter's runtime configuration. A non-Vite application must also:

- apply the adapter to the worker build when the bundler has a separate worker pipeline;
- process module workers and package-relative `new URL(..., import.meta.url)` assets;
- emit the equivalents of `browser-embedded.mjs`, `wasm/index.wasm`, and
  `thread/browser-worker.mjs` without breaking their resolved URLs;
- set `window.__convexAllowFunctionsInBrowser = true` before importing application code; and
- configure the production headers described below.

For example, a plain HTML entry can set the browser flag before the application module:

```html
<script>
  window.__convexAllowFunctionsInBrowser = true;
</script>
<script type="module" src="/src/main.ts"></script>
```

The available adapter is not a claim that every bundler's worker and WASM asset pipeline has been
validated. Vite is currently covered by end-to-end build tests; non-Vite integrations should add a
production-build smoke test that starts the client and runs one local query.

| Build system               | Integration level                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Vite / Vite+               | Full adapter; end-to-end tested                                                       |
| Rollup / Rolldown          | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| Webpack / Rspack           | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| esbuild                    | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| Turbopack / Parcel / Metro | No adapter currently provided                                                         |

`@convex-dev/embedded/bundler` is the lower-level registry generator used by these adapters. Most
applications should use `vite` or `unplugin` instead.

### Frameworks and server rendering

Import `@convex-dev/embedded/browser` only from client-side code. The browser entry creates a Web
Worker and reads browser storage; it cannot run during SSR. In frameworks with server and client
module graphs, put client creation behind the framework's client-only boundary or a guarded dynamic
import.

### Production hosting

Vite's development headers do not configure deployed hosting. Every production HTML response must
include:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve worker and WASM assets from the same origin when possible. Resources loaded from another
origin must opt into compatible CORS or `Cross-Origin-Resource-Policy` behavior; otherwise the
browser can block them under `require-corp`.

After deployment, verify that `crossOriginIsolated === true`, the Embedded worker starts, the WASM
request succeeds, and a local query completes. A page loading successfully is not enough to prove
that its worker and storage runtime started.

## 3. Create a client

Use the browser entry from client-side application code:

```ts
import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";

import { api } from "../convex/_generated/api";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});

const documents = await client.query(api.documents.list, {});
const id = await client.mutation(api.documents.create, { body: "Hello" });

const watch = client.watchQuery(api.documents.list, {});
const unsubscribe = watch.onUpdate(() => {
  console.log(watch.localQueryResult());
});

console.log(client.connectionState());

// During application teardown:
unsubscribe();
await client.close();
```

The client also exposes `action`, `setAuth`, and `clearAuth`. Queries and mutations use generated
Convex function references; the bundler adapter decides which functions are safe to execute locally.
Revisions are intentionally not a privileged client API. Clients call app-authored functions that
authorize revision access.

Node applications import `ConvexEmbeddedClient` from `@convex-dev/embedded/node`. The Node entry
does not need a browser bundler plugin or cross-origin isolation, but it does require a native binary
for the current operating system and architecture.

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

The component does not expose a separate maintenance state or retention command. An app defines
retention policy by listing eligible retained revisions and scheduling bounded `delete` calls. The
active revision cannot be deleted.

## CRDT fields

Declare collaborative fields with the values entrypoint and edit them through typed database
intents. Loro runs only in the local Rust/WASM runtime; Convex stores opaque payloads and ordinary
materialized values.

```ts
// convex/schema.ts
import { defineEmbeddedSchema, embeddedTable } from "@convex-dev/embedded/schema";
import { e } from "@convex-dev/embedded/values";
import { v } from "convex/values";

export default defineEmbeddedSchema({
  documents: embeddedTable({
    owner: v.string(),
    body: e.text(),
    serverLabel: e.omit(v.optional(v.string())),
    expanded: e.local(v.boolean()),
  }).index("by_owner", ["owner"]),
});
```

```ts
// convex/documents.ts
import { v } from "convex/values";

import { embedded } from "./embedded";

export const insertText = embedded.replicated.mutation({
  args: { id: v.id("documents"), index: v.number(), value: v.string() },
  handler: async (ctx, { id, index, value }) => {
    await ctx.db.text.splice("documents", id, "body", {
      index,
      delete: 0,
      insert: value,
    });
  },
});
```

## Troubleshooting browser builds

| Symptom                                            | Likely cause                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The build cannot resolve `virtual:convex-embedded` | The Vite or Unplugin adapter is missing from that build graph                          |
| The page loads but the client never initializes    | The worker build lacks the adapter, or its worker/WASM assets were not emitted         |
| A worker or WASM request returns 404               | The bundler rewrote or omitted a package-relative asset URL                            |
| `crossOriginIsolated` is false                     | Production hosting is missing COOP/COEP headers, or an embedded resource violates them |
| A Convex function is hosted-only                   | It has `"use node"`, is a system file, or is otherwise excluded from local execution   |
| Private browsing reports temporary storage         | OPFS was denied; local state is intentionally using the volatile in-memory backend     |

When debugging a deployment, inspect the worker console and network requests as well as the page
console. The browser page can remain responsive while the Embedded worker is blocked or failed.
