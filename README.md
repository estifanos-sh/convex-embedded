# Embedded

Embedded is a local-first runtime for Convex. Application schemas, functions, authorization, and
data remain ordinary Convex code. The installed component owns private replication metadata; the
local SQLite runtime owns the device projection and all Loro computation.

## Requirements

- `convex` 1.43.0 or newer
- Node.js 24 or newer for the Node runtime and package build tools. Prebuilt Node artifacts support
  Apple Silicon macOS, Linux x64/ARM64, and Windows x64; Intel macOS requires an explicitly supplied
  source-built artifact.
- Cross-origin isolation for browser builds that use the threaded WASM runtime

Install the package alongside Convex:

```sh
pnpm add @estifanos-sh/convex-embedded convex
```

### Independent test releases

This independent package is published directly as `@estifanos-sh/convex-embedded`. Its import
paths, generated modules, and bundler configuration all use that same identity:

```sh
pnpm add @estifanos-sh/convex-embedded@<version> convex
```

The `package preview` pull-request label publishes an ephemeral package assembled from JavaScript,
WASM, four Node targets, both Apple XCFramework slices, and all four Android ABIs. It is a GitHub
release asset, not an npm publication.

Every npm publication is an explicit `publish.yml` workflow dispatch. Select `prerelease` or
`release`, provide the exact source commit, and provide a matching `v<version>` tag—for example,
`v0.0.1-preview.0`. The workflow qualifies and assembles that one commit before creating the tag
and publishing the package. npm trusted publishing binds release authority to this repository and
this package identity; no other repository can publish it.

## 1. Configure Convex

Install the component once:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import embedded from "@estifanos-sh/convex-embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

Create one Embedded server definition and export its protocol functions:

```ts
// convex/embedded.ts
import { defineEmbedded } from "@estifanos-sh/convex-embedded/server";

import { components } from "./_generated/api";
import { embeddedManifest } from "./_generated/embedded";
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

### Commit timestamps

Embedded implements Convex 1.43's `ctx.db.vars.commitTs` in ordinary local and replicated
mutations. Declare persisted and returned timestamps with `v.commitTs()`; Embedded keeps the value
logical while the mutation runs, then atomically replaces every persisted occurrence and the
returned value with one device commit timestamp:

```ts
// convex/schema.ts
import { v } from "convex/values";

import { defineEmbeddedSchema, replicatedTable } from "@estifanos-sh/convex-embedded/schema";

export default defineEmbeddedSchema({
  events: replicatedTable({
    name: v.string(),
    committedAt: v.commitTs(),
  }).index("by_committed_at", ["committedAt"]),
});

// convex/events.ts
import { v } from "convex/values";

import { replicated } from "./embedded";

export const create = replicated.mutation({
  args: { name: v.string() },
  returns: v.commitTs(),
  handler: async (ctx, args) => {
    const committedAt = ctx.db.vars.commitTs;
    await ctx.db.insert("events", { name: args.name, committedAt });

    // Staged reads use the logical value, including indexed equality and ranges.
    await ctx.db
      .query("events")
      .withIndex("by_committed_at", (q) => q.eq("committedAt", committedAt))
      .unique();
    return committedAt;
  },
});
```

The placeholder is valid only inside the mutation transaction. It cannot escape through a
top-level query or action, scheduled-function arguments, CRDT set members, or durable storage
without being resolved. A nested query called by the same mutation may receive and return it
because it shares the transaction. The bigint returned to application code is the resolved device
timestamp.

For a replicated mutation, the device resolves its optimistic documents, local after-images, and
result using the device transaction timestamp. During authoritative replay, Embedded binds the
same logical value to hosted Convex's `ctx.db.vars.commitTs`; the hosted timestamp can therefore
differ from the device timestamp. Result verification hashes the logical value, not either physical
timestamp. Nested app-mutation calls from replicated mutations remain unsupported until their
writes can join the parent's replay capture; factor shared logic into a helper or component call
instead.

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
app-bound `local` namespace from `convex/_generated/embedded`, and are referenced by importing the
function value directly. The bundler plugin writes that generated contract from the schema, so the
builders always use the application's device data model without a global module augmentation.

```ts
// convex/schema.ts
const schema = defineEmbeddedSchema({ ... });
export default schema;
```

```ts
// local/preferences.ts — an ordinary TypeScript module
import { local } from "../convex/_generated/embedded";
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

The build plugin writes `convex/_generated/embedded.ts`, a small checked-in contract holding the
function manifest, identity hashes for the schema source and manifest, and the schema-bound `local`
builders. Every adapter still analyzes the live schema and inlines the device storage schema into
the virtual registry, so the contract stays small. Its `_generated` directory keeps it out of
deployment discovery while `convex/embedded.ts` imports `embeddedManifest` for deployment. Treat it
like other generated Convex output: do not edit it by hand, and run the configured bundler adapter
after schema or function changes so stale placement metadata cannot enter a device build.

## Schema changes and migrations

Embedded has three migration layers. Choose the layer that owns the data being changed:

| Change                                                     | Migration mechanism                                |
| ---------------------------------------------------------- | -------------------------------------------------- |
| Embedded package internals                                 | Automatic during `client.open()`                   |
| Hosted fields in a `replicatedTable` or plain hosted table | Convex migration component or an internal mutation |
| `localTable` documents or other device-originated records  | Optional device setup action                       |

A hosted migration cannot read a device's local records. Device setup cannot change hosted rows.
If one release changes both, coordinate the hosted migration and the app's new setup action as two
parts of the same widen-migrate-narrow rollout.

### Package compatibility

Applications never author migrations for Embedded's private SQLite tables or record formats.
`client.open()` performs package-owned compatibility work automatically and fails without deleting
the existing store when that work cannot be proven safe.

Preview 2 establishes the first library-store compatibility baseline. Stores created by earlier
unreleased previews are left intact but cannot be opened by Preview 2; clear that preview-only app
storage once, or choose a new storage id. Starting with Preview 2, released compatibility is tested
against immutable store fixtures.

### Hosted Convex data

Use Convex's usual widen-migrate-narrow sequence for authoritative hosted data:

1. Widen the schema so both old and new documents validate, and deploy code that handles both.
2. Backfill existing documents.
3. Verify completion, then narrow the schema and remove the compatibility code.

For a table-sized backfill, use `@convex-dev/migrations`. It batches work, records progress, resumes
after failures, and can dry-run a batch. Install and register it beside Embedded:

```sh
pnpm add @convex-dev/migrations
```

```ts
// convex/convex.config.ts
import embedded from "@estifanos-sh/convex-embedded/convex.config";
import migrations from "@convex-dev/migrations/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(embedded);
app.use(migrations);
export default app;
```

Define hosted migrations with Embedded's `remote.internalMutation` builder so they operate on the
hosted document shape:

```ts
// convex/migrations.ts
import { Migrations } from "@convex-dev/migrations";

import { components } from "./_generated/api";
import { remote } from "./embedded";
import schema from "./schema";

const migrations = new Migrations(components.migrations, {
  internalMutation: remote.internalMutation,
  schema,
});

export const backfillArchived = migrations.define({
  table: "documents",
  migrateOne: (_ctx, document) => ({
    archived: document.archived ?? false,
  }),
});
```

Deploy the widened schema and migration before running it. Dry-run one batch first, then start the
resumable migration; add `--prod` to both commands for production:

```sh
pnpm convex run migrations:backfillArchived '{"dryRun":true}'
pnpm convex run migrations:backfillArchived
```

An ordinary `remote.internalMutation` is also a migration function. It is appropriate for one
document or another provably bounded change:

```ts
// convex/migrations.ts
import { v } from "convex/values";

import { remote } from "./embedded";

export const migrateOneDocument = remote.internalMutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const document = await ctx.db.get(id);
    if (document && document.archived === undefined) {
      await ctx.db.patch(id, { archived: false });
    }
    return null;
  },
});
```

Run it with `pnpm convex run migrations:migrateOneDocument '{"id":"..."}'`. Keep direct
migration functions idempotent. Do not read an unbounded table with `collect()` in one mutation;
use the migrations component or implement explicit cursor-based batching instead. Hosted migration
results reach devices through normal pull replication.

### Device-originated data

Open every embedded client explicitly. An optional setup action runs before the client becomes
ready and orchestrates ordinary internal local queries and mutations over device-owned data:

```ts
import { v } from "convex/values";

import { local } from "../convex/_generated/embedded";
import { rewritePreferences } from "./preferences";

export const setup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Call bounded, idempotent internal mutations here.
    await ctx.runMutation(rewritePreferences, {});
    return null;
  },
});

await client.open(setup);
```

When setup must read a device table that the current schema removed, bind that helper to an
explicit historical schema. The main generated `local` value remains bound to the current schema;
`local.compatibility(legacySchema)` returns only internal, setup-only builders:

```ts
// local/setup.ts
import { type GenericId, v } from "convex/values";

import { local } from "../convex/_generated/embedded";
import { legacySchema } from "./legacySchema";

const legacy = local.compatibility(legacySchema);

export const preferencesLegacyRead = legacy.internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("legacy_preferences").first(),
});

export const preferencesCurrentWrite = local.internalMutation({
  args: { compact: v.boolean() },
  handler: async (ctx, { compact }) => {
    if ((await ctx.db.query("preferences").first()) === null) {
      await ctx.db.insert("preferences", { compact });
    }
  },
});

export const preferencesLegacyDelete = legacy.internalMutation({
  args: { id: v.id("legacy_preferences") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete("legacy_preferences", id);
  },
});

export const setup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const preference = (await ctx.runQuery(preferencesLegacyRead, {})) as {
      _id: GenericId<"legacy_preferences">;
      compact: boolean;
    } | null;
    if (preference !== null) {
      await ctx.runMutation(preferencesCurrentWrite, { compact: preference.compact });
      await ctx.runMutation(preferencesLegacyDelete, { id: preference._id });
    }
    return null;
  },
});
```

`legacySchema` is an ordinary `defineEmbeddedSchema` value that describes the historical table.
Embedded includes it only in the unpublished setup workspace. Functions returned by
`local.compatibility(...)` are private setup helpers: they can run through the setup action, but
the active runner excludes and rejects them after cutover. They therefore cannot become a hidden
long-lived API for removed tables. Every local registration dispatched with `ctx.runQuery` or
`ctx.runMutation` must be a named export so the configured bundler can stamp and register it. A
dropped table's originated rows must be explicitly deleted by
an idempotent setup mutation after their replacement is written; otherwise final target validation
fails and preserves the old active generation.

`setup` must be an imported, bundled internal local action with empty arguments and a `null`
result; callbacks, strings, server references, public actions, queries, and mutations are rejected.
Each `ctx.runMutation` is a separate durable setup batch, so setup code must be idempotent and
paginate instead of collecting an unbounded table. Setup runs unauthenticated and has no hosted
function, scheduling, file-storage, nested-action, or raw-package-record context. It is still normal
JavaScript, so avoid non-idempotent external side effects: Embedded cannot roll back a `fetch()` if
the process dies afterward. A throw preserves the previously opened data and terminally fails that
client instance. Close it, construct a new client, and open with the same setup identity to resume
and rerun the action.

Pass the setup action in every build that may still need to execute or resume it. After it has
completed on the supported device population, a later release may return to plain `open()`; the
store retains the completed setup identity without retaining an executable hook. Pass a different
setup action when a later app version needs new setup work. That action must handle every source
shape the application still supports across skipped releases. Plain `open()` remains sufficient
for automatic package upgrades and compatible schema changes that require no app-authored rewrite.

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
import { convexEmbedded } from "@estifanos-sh/convex-embedded/vite";
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
  generatedPath: "_generated/embedded.ts",
  local: "local",
  schema,
  schemaPath: "schema.ts",
});
```

`convexDir`, `generatedPath`, and `schemaPath` above are the defaults. `generatedPath` lives under
Convex's generated directory, so the CLI does not deploy it as a function module. `schema` is
required so every build rewrites and verifies the generated contract. `local` names the device-only directories — one path
or a list — and is omitted when the application has none. Files in `convex/` with a top-level `"use node"`
directive are hosted-only and are intentionally excluded from the local registry.

### Rollup, Rolldown, Webpack, Rspack, and esbuild

The package exposes Unplugin adapters for projects that do not use Vite:

```ts
import { convexEmbeddedUnplugin } from "@estifanos-sh/convex-embedded/unplugin";
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

`@estifanos-sh/convex-embedded/bundler` is the lower-level registry generator used by these adapters. Most
applications should use `vite` or `unplugin` instead.

### Expo and Metro

Expo development and release builds can use the package-owned native store through
`@estifanos-sh/convex-embedded/expo`; Expo Go cannot load the required native module. Wrap the Expo Metro
configuration with `withConvexEmbedded` from `@estifanos-sh/convex-embedded/metro`. Use
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
import { withConvexEmbedded } from "@estifanos-sh/convex-embedded/metro";
import { getDefaultConfig } from "expo/metro-config";
import schema from "./convex/schema";

module.exports = withConvexEmbedded(getDefaultConfig(__dirname), {
  schema,
});
```

Metro analyzes `schema` and rewrites `convex/_generated/embedded.ts` before materializing its
registry, exactly as the Vite and Unplugin adapters do.

Metro builds its registry when the configuration loads. Restart Metro after changing the schema or
any device function source. The Expo client supports local storage, local functions, and native
remote replication when passed a Convex deployment `url`. The native remote uses the same Rust
protocol driver as Node. Omit `url` for local-only execution.

### Frameworks and server rendering

Import `@estifanos-sh/convex-embedded/browser` only from client-side code. The browser entry creates a Web
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
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";

import { api } from "../convex/_generated/api";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});
await client.open();

const documents = await client.query(api.documents.list, {});
const id = await client.mutation(api.documents.create, { body: "Hello" });

const watch = client.watchQuery(api.documents.list, {});
const unsubscribe = watch.onUpdate(() => {
  console.log(watch.localQueryResult());
});

console.log(client.connectionState());

const stopConnectionState = client.subscribeToConnectionState((state) => {
  console.log(state.local, state.replication);
});

const stopSettlements = client.subscribeToMutationSettlements((settlement) => {
  if (settlement.outcome === "conflict") {
    console.log("Mutation retained conflict revisions", settlement.retainedRevisions);
  }
});

// During application teardown:
unsubscribe();
stopConnectionState();
stopSettlements();
await client.close();
```

The client also exposes `action`, `setAuth`, and `clearAuth`. Queries and mutations use generated
Convex function references; the bundler adapter decides which functions are safe to execute locally.
Revisions are intentionally not a privileged client API. Clients call app-authored functions that
authorize revision access.

`connectionState()` is a frozen snapshot with independent `local` and `replication` branches.
`local` moves through `idle`, `starting`, `ready`, `failed`, and `closed`; a ready branch also says
whether persistence is `durable` or `temporary`. `replication` distinguishes disabled, starting,
offline, online, error, and closed state, and an online branch says whether durable work is still
pending. `subscribeToConnectionState()` is live-only and coalesces a burst of transitions into the
latest snapshot.

`subscribeToMutationSettlements()` is also live-only: it never replays an outcome that happened
before subscription. A settlement is emitted only after the native store commits that terminal
outcome. `applied` means the authoritative replay committed; `conflict` carries the closed
`EMBEDDED_CONFLICT` code and exact retained revisions; `rejected` carries a closed
`EMBEDDED_REJECTED` or `EMBEDDED_DIVERGENCE` code and any retained revisions. Internal rebase
attempts and raw server rejection reasons are never exposed.

Node applications import `ConvexEmbeddedClient` from `@estifanos-sh/convex-embedded/node`. The Node entry
does not need a browser bundler plugin or cross-origin isolation, but it does require a native binary
for the current operating system and architecture. Device-only modules are passed programmatically:
the constructor's `local` option takes a record of import thunks keyed by module path relative to
the application's local directory, mirroring how `modules` supplies the Convex function graph.

Those direct loaders support ordinary local queries and mutations. A Node setup action passed to
`open(setup)` must come from local source transformed by an Embedded bundler adapter so it carries a
trusted module name and graph hash; an unstamped, hand-assembled loader map fails closed for setup.
Browser and Expo builds receive the stamp automatically from their required Vite/Unplugin or Metro
integration.

### Browser storage

The browser client opens durable SQLite storage in OPFS when the browser allows it. It tests the
real open operation instead of inferring support from the user agent or the presence of
`navigator.storage.getDirectory`.

If the browser denies OPFS, the client opens the same SQLite schema with Turso's in-memory backend.
The ready local connection state then reports `persistence: "temporary"`. This occurs in current
Safari and Firefox private browsing. Chromium supplies an in-memory filesystem for incognito
profiles, so the OPFS path can still open there; Chromium deletes that profile storage when the
incognito session ends.

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
import { defineEmbeddedSchema, replicatedTable } from "@estifanos-sh/convex-embedded/schema";
import { e } from "@estifanos-sh/convex-embedded/values";
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
