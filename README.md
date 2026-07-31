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
import { embeddedManifest } from "./embedded.generated";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  manifest: embeddedManifest,
  schema,
});

export const { remote, replicated } = embedded;
export const { upload, pull, push } = embedded;
```

Application functions select an explicit placement and use normal Convex authorization and
database APIs:

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

Use `remote` for hosted-only queries and mutations, and the `local` namespace (below) for
device-only operations. Replicated functions see only replicated fields, remote functions see the
hosted document, and local functions see replicated fields plus device overlays.

### Placement model

Tables, fields, indexes, and functions use the same three placements:

| Schema declaration                                       | Hosted server | Replication wire | Device                  |
| -------------------------------------------------------- | ------------- | ---------------- | ----------------------- |
| `replicatedTable({...})`                                 | Yes           | Yes              | Yes                     |
| Plain `defineTable({...})` inside `defineEmbeddedSchema` | Yes           | No               | No                      |
| `localTable({...})`                                      | No            | No               | Yes                     |
| Unannotated field in a `replicatedTable`                 | Yes           | Yes              | Yes                     |
| `e.remote(validator)`                                    | Yes           | No               | No                      |
| `e.local(validator)`                                     | No            | No               | Optional device overlay |

An `e.local` field is stored separately from its replicated document. Pull, membership exit, and a
server deletion do not erase the overlay; if the row returns, the overlay is visible again. A local
mutation clears it by patching the field to `undefined`. Local overlays are scoped to the current
device identity and validated by the validator passed to `e.local`. Local functions may patch these
fields, but cannot insert, replace, or delete the replicated row. A device read merges the
overlay into the row it belongs to, so a local function reading a replicated table sees that
table's `e.local` fields; a `returns` validator on such a function must declare them, or return
only the fields it needs.

A `localTable` owns complete device-only documents. Those rows are durable local state and change
only through local functions (or when the table is removed from the schema); they are never pushed,
pulled, or deployed to Convex.

Index placement follows its fields. A normal index containing only replicated fields exists on both
the server and device. If any indexed field uses `e.remote`, the index is hosted-only. An index may not
contain an `e.local` field. Search, vector, and staged indexes are supported on a `replicatedTable`
only when they are hosted-only; the embedded store does not implement those index kinds.

Device-only functions live in directories the app names with the bundler `local` option, use the
`local` namespace, and are referenced by importing the function value directly. The schema file
registers itself as the type source once:

```ts
// convex/schema.ts
import type {} from "@convex-dev/embedded/local";

const schema = defineEmbeddedSchema({ ... });
export default schema;

declare module "@convex-dev/embedded/local" {
  interface Register { schema: typeof schema }
}
```

The type-only import brings the augmented module into programs that compile only `convex/`; it is
erased at compile time and never deploys.

```ts
// local/preferences.ts — an ordinary TypeScript module
import { local } from "@convex-dev/embedded/local";
import { v } from "convex/values";

export const setCompact = local.mutation({
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
import { setCompact } from "../local/preferences";

await client.mutation(setCompact, { compact: true });
```

Pass the directories as `local` (a path or list of paths; there is no default). Every module under
those roots is bundled into the device runtime and imported at startup, which names each exported
registration; other exports — constants, helpers, anything — are untouched, so the roots hold
ordinary modules with no file conventions. Application imports of these modules are real imports:
values, types, and handlers behave like any other TypeScript. Modules under `convex/` cannot
register local functions or import anything from a local root; that boundary is what keeps
device-only code out of the hosted deployment, and the roots should hold device logic rather than
UI code, since the worker loads everything inside them.

### Composing device state with replicated data

Device state and replicated data compose in one direction only. A replicated function cannot read
a `localTable` or an `e.local` overlay, and `ctx.runQuery` does not cross placements, so a
replicated query can never consult device state from inside itself. Read the device state in a
local query and hand it to the replicated query as arguments.

Which channel you need depends on what the device state changes:

- If it changes how rows you already have are displayed — pinned documents sorted to the top of a
  list, a collapsed row, a local highlight — compose it in your view code. Watch the replicated
  query for the rows, watch the local query for the device state, and combine the two where you
  render. The demos do exactly this: `api.documents.read` returns the list, `local/pins.ts` returns
  the pinned ids, and the list puts the pinned rows first.
- If it changes which rows the device must hold — pinned documents that stay synced even when they
  fall outside the list you are watching — pass the ids as arguments to a second replicated query:

```ts
// convex/documents.ts
export const byIds = replicated.query({
  args: { ids: v.array(v.id("documents")) },
  returns: v.array(documentValidator),
  handler: async (ctx, args) => {
    const documents = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return documents.filter((document) => document !== null);
  },
});
```

```ts
// application code
const pinned = client.watchQuery(pinnedIds, {});
const documents = client.watchQuery(api.documents.byIds, {
  ids: [...(pinned.localQueryResult() ?? [])].sort(),
});
```

Arguments are the subscription's identity, so each distinct id set gets its own pull subscription
and its own cached result. Toggling a pin retires one subscription and starts another and leaves
every other watch alone, including the main list. Sort the ids so an unchanged set never produces
new arguments, keep the array bounded, and expect a document created offline to join the
subscription only after its insert is accepted, because arguments reach the server as server ids.

Do not use a local query to re-create a replicated query's result. A local query sees only the rows
some replicated subscription already delivered, publishes no subscription of its own, and is never
served from the server's retained answer, so re-sorting or re-paging a replicated list in one shows
a list the server never returned.

The build plugin writes `convex/embedded.generated.ts`, a small checked-in lockfile holding the
function manifest and the identity hashes of the schema source and that manifest. The device schema
is not in it: every adapter analyzes the live schema and inlines the result into the virtual
registry, so the file stays about a kilobyte. Its multi-dot name is load-bearing — the Convex CLI
skips those modules, so the lockfile never deploys as a hosted function while `convex/embedded.ts`
still imports `embeddedManifest` from it and esbuild bundles it into the deployment. Treat it like
other generated Convex output: do not edit it by hand, and pass the imported schema to every bundler
adapter so stale placement metadata cannot enter a device build.

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
  generatedPath: "embedded.generated.ts",
  local: "local",
  schema,
  schemaPath: "schema.ts",
});
```

`convexDir`, `generatedPath`, and `schemaPath` above are the defaults. Keep a multi-dot basename for
`generatedPath` so the Convex CLI never deploys the lockfile as a function module. `schema` is
required so every build rewrites and verifies the placement lockfile. `local` names the device-only directories — one path
or a list — and is omitted when the application has none. Files in `convex/` with a top-level `"use node"`
directive are hosted-only and are intentionally excluded from the local registry.

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

| Build system       | Integration level                                                                     |
| ------------------ | ------------------------------------------------------------------------------------- |
| Vite / Vite+       | Full adapter; end-to-end tested                                                       |
| Rollup / Rolldown  | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| Webpack / Rspack   | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| esbuild            | Function-registry adapter; worker, assets, flag, and headers remain app configuration |
| Metro              | Expo native adapter; restart after schema or device-function changes                  |
| Turbopack / Parcel | No adapter currently provided                                                         |

`@convex-dev/embedded/bundler` is the lower-level registry generator used by these adapters. Most
applications should use `vite` or `unplugin` instead.

### Expo and Metro

Expo development and release builds can use the package-owned native store through
`@convex-dev/embedded/expo`; Expo Go cannot load the required native module. Wrap the Expo Metro
configuration with `withConvexEmbedded` from `@convex-dev/embedded/metro`. Use
[Expo's supported `tsx` hook](https://docs.expo.dev/guides/typescript/#typescript-for-projects-config-files)
so the configuration can import the TypeScript Convex schema. Install it with
`pnpm exec expo install tsx -- --dev`, then split the configuration into this JavaScript shim and
TypeScript implementation:

```js
// metro.config.js
require("tsx/cjs");
module.exports = require("./metro.config.ts");
```

```ts
// metro.config.ts
import { withConvexEmbedded } from "@convex-dev/embedded/metro";
import { getDefaultConfig } from "expo/metro-config";
import schema from "./convex/schema";

module.exports = withConvexEmbedded(getDefaultConfig(__dirname), {
  schema,
});
```

Metro analyzes `schema` and rewrites `convex/embedded.generated.ts` before materializing its
registry, exactly as the Vite and Unplugin adapters do.

Metro builds its registry when the configuration loads. Restart Metro after changing the schema or
any device function source. The Expo client supports local storage, local functions, and native
remote replication when passed a Convex deployment `url`. The native remote uses the same Rust
protocol driver as Node. Omit `url` for local-only execution.

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
for the current operating system and architecture. Device-only modules are passed programmatically:
the constructor's `local` option takes a record of import thunks keyed by module path relative to
the application's local directory, mirroring how `modules` supplies the Convex function graph.

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
import { replicated } from "./embedded";

export const savepoint = replicated.mutation({
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

export const restore = replicated.mutation({
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
import { defineEmbeddedSchema, replicatedTable } from "@convex-dev/embedded/schema";
import { e } from "@convex-dev/embedded/values";
import { v } from "convex/values";

export default defineEmbeddedSchema({
  documents: replicatedTable({
    owner: v.string(),
    body: e.text(),
    serverLabel: e.remote(v.optional(v.string())),
    expanded: e.local(v.boolean()),
  }).index("by_owner", ["owner"]),
});
```

```ts
// convex/documents.ts
import { v } from "convex/values";

import { replicated } from "./embedded";

export const insertText = replicated.mutation({
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
