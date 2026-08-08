# Convex Embedded

`@estifanos-sh/convex-embedded` is a local-first runtime for Convex applications. It runs
eligible Convex queries and mutations against a durable SQLite projection on the device, then
replicates the same application operations to Convex when a connection is available. Application
schemas, authorization, and functions remain ordinary Convex code.

> **Preview.** This package is pre-1.0 software. Treat its public API as a preview contract and
> test upgrades against your application's real device data before broad distribution.

## Install

Install Convex Embedded beside Convex:

```sh
pnpm add @estifanos-sh/convex-embedded convex
```

The package requires Node.js 20.19 or newer. Release CI uses Node 24, but Node 20.19+ is the
supported application and Node-runtime baseline. The browser build needs the Vite/Vite+ adapter or
an equivalent Unplugin integration plus cross-origin isolation. Expo needs a custom development or
release build; Expo Go cannot load the native module. Prebuilt Node artifacts support Apple Silicon
macOS, Linux x64 and ARM64, and Windows x64. Intel macOS users must supply a source-built native
artifact.

All public imports use the installed package identity:

| Import                                        | Purpose                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `@estifanos-sh/convex-embedded/convex.config` | Registers the hosted Convex component.                                   |
| `@estifanos-sh/convex-embedded/server`        | Defines local-capable and hosted-only functions plus protocol endpoints. |
| `@estifanos-sh/convex-embedded/schema`        | Defines table placement and the application schema.                      |
| `@estifanos-sh/convex-embedded/values`        | Declares replicated CRDTs, hosted-only fields, and device overlays.      |
| `@estifanos-sh/convex-embedded/text`          | Provides a framework-neutral convergent writer for an `e.text()` field.  |
| `@estifanos-sh/convex-embedded/browser`       | Browser client and upload fetch adapter.                                 |
| `@estifanos-sh/convex-embedded/expo`          | Expo iOS and Android client.                                             |
| `@estifanos-sh/convex-embedded/node`          | Node client and upload fetch adapter.                                    |
| `@estifanos-sh/convex-embedded/vite`          | First-class Vite and Vite+ browser integration.                          |
| `@estifanos-sh/convex-embedded/metro`         | Expo Metro integration.                                                  |
| `@estifanos-sh/convex-embedded/unplugin`      | Registry adapter for Rollup, Rolldown, Webpack, Rspack, and esbuild.     |
| `@estifanos-sh/convex-embedded/bundler`       | Advanced, version-coupled registry generation primitives.                |
| `@estifanos-sh/convex-embedded/devtools`      | Optional browser development panel.                                      |
| `@estifanos-sh/convex-embedded/devtools/vite` | Vite helper that removes the devtools from production builds.            |

`@estifanos-sh/convex-embedded/bundler` exposes the lower-level registry generator behind the build
adapters (`createEmbeddedBundle`, `generateEmbedded`, and artifact types). It is version-coupled
tooling for adapter authors; most applications use `vite`, `metro`, or `unplugin` instead. Package
`internal/*` entrypoints are implementation details, not application APIs.

## Quick start

An Embedded app has four pieces: register the component, define an Embedded schema, export its
protocol endpoints, and configure the platform build.

### 1. Register the component

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import embedded from "@estifanos-sh/convex-embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

### 2. Define the schema

```ts
// convex/schema.ts
import { v } from "convex/values";
import {
  defineEmbeddedSchema,
  localTable,
  replicatedTable,
} from "@estifanos-sh/convex-embedded/schema";
import { e } from "@estifanos-sh/convex-embedded/values";

export default defineEmbeddedSchema({
  documents: replicatedTable({
    owner: v.string(),
    title: v.string(),
    body: e.text(),
    likes: e.count(),
    labels: e.set(v.string()),
    serverLabel: e.remote(v.optional(v.string())),
    expanded: e.local(v.boolean()),
  }).index("by_owner", ["owner"]),
  preferences: localTable({
    compact: v.boolean(),
  }),
});
```

`defineEmbeddedSchema` still returns a normal Convex `SchemaDefinition`. The placement helpers
also derive the hosted, wire, and device data models so a misplaced field or index is rejected by
TypeScript and the build integration.

### 3. Export server functions and transport endpoints

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
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    return await ctx.db.insert("documents", {
      owner: identity.tokenIdentifier,
      title,
      body: "",
    });
  },
});
```

The `pull`, `push`, and `upload` exports are package protocol endpoints. Export them from the
canonical `convex/embedded.ts` module; application code does not call them directly.

### 4. Configure the browser build and open a client

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { convexEmbedded } from "@estifanos-sh/convex-embedded/vite";
import schema from "./convex/schema";

export default defineConfig({
  plugins: [convexEmbedded({ schema, local: "local" })],
});
```

`local` is optional and has no default. Omit it when the app has no device-only function roots;
pass one path or a list of paths when it does.

```ts
// src/client.ts -- client-side code only
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";
import { api } from "../convex/_generated/api";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});

await client.open();

const documents = await client.query(api.documents.list, {});
await client.mutation(api.documents.create, { title: "First document" });
```

The constructor is inert. `open()` is the first call that may acquire storage, create a worker or
native runtime, start schedules, or connect to Convex.

## Placement model

Tables, fields, indexes, and functions use three placements:

| Declaration                                          | Hosted server | Replication wire | Device         |
| ---------------------------------------------------- | ------------- | ---------------- | -------------- |
| `replicatedTable({...})`                             | Yes           | Yes              | Yes            |
| Plain `defineTable({...})` in `defineEmbeddedSchema` | Yes           | No               | No             |
| `localTable({...})`                                  | No            | No               | Yes            |
| Unannotated field in a replicated table              | Yes           | Yes              | Yes            |
| `e.remote(validator)`                                | Yes           | No               | No             |
| `e.local(validator)`                                 | No            | No               | Device overlay |

`replicatedTable` is the only table declaration that reaches the device from Convex. A plain
`defineTable` remains hosted-only. `localTable` owns complete durable device documents: they never
push, pull, or deploy to Convex.

An `e.local` field is stored as an identity-scoped overlay beside its replicated row. Pull,
membership exit, and a server deletion do not erase it. A local mutation clears an overlay by
patching that field to `undefined`. Device reads merge the overlay into the replicated row. Local
functions can patch overlays but cannot insert, replace, or delete a replicated row through them.

Indexes follow their fields. An index over replicated fields exists on the server and device; an
index containing an `e.remote` field is hosted-only; an `e.local` field cannot be indexed. Search,
vector, and staged indexes are hosted-only.

`e.text()`, `e.count()`, and `e.set(validator)` declare replicated CRDT fields. Use their typed
intent APIs in a replicated mutation. Local functions may read projected CRDT values but cannot
write replicated CRDT fields.

```ts
await ctx.db.text.splice("documents", id, "body", {
  index: 0,
  delete: 0,
  insert: "Hello ",
});
await ctx.db.count.add("documents", id, "likes", 1);
await ctx.db.set.add("documents", id, "labels", "urgent");
await ctx.db.set.delete("documents", id, "labels", "draft");
```

`set.add` does nothing when an equal member is already present; `set.delete` does nothing when it
is absent. Both validate the field's `e.set(...)` member validator and the document id. Loro
computes CRDT state in the local runtime. Convex stores opaque CRDT payloads plus ordinary
materialized values; application code continues to use normal typed Convex values.

## Functions

`defineEmbedded()` supplies two server namespaces:

| Builder                            | Runs where                                     | Data it can read                                    | Offline behavior                                                                                      |
| ---------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `replicated.query`                 | Device local projection                        | Replicated fields and tables                        | A one-shot read is local only. A watched read retains its matching hosted pull membership.            |
| `replicated.mutation`              | Device first, then authoritative Convex replay | Replicated fields and tables                        | Commits its local result and replay envelope durably; replay can later apply, conflict, or reject it. |
| `remote.query` / `remote.mutation` | Convex only                                    | Full hosted document, including `e.remote` fields   | Requires a configured connection.                                                                     |
| `local.query` / `local.mutation`   | Device only                                    | Local tables, replicated fields, and local overlays | Never calls Convex.                                                                                   |

`replicated` and `remote` also provide `internalQuery` and `internalMutation`. They keep the
normal Convex semantics and generated references. Use ordinary Convex `action`, `internalAction`,
and `httpAction` for hosted actions and HTTP endpoints; actions are never emulated locally.

A one-shot `client.query()` reads the current local projection and does not establish background
freshness. `client.watchQuery()` creates a reactive local query and, when `url` is configured,
maintains the matching hosted pull membership while it has listeners. Its first value can be empty
or stale before the first successful pull. A remote query or mutation always runs through the hosted
client.

Replicated mutations resolve after the local documents, mutation result, CRDT effects, schedules,
upload dependencies, and pending operation commit together. They do **not** wait for the server to
settle. Observe later terminal outcomes with `subscribeToMutationSettlements()`.

Embedded supports Convex `ctx.db.vars.commitTs` in local and replicated mutations. Declare every
stored or returned timestamp with `v.commitTs()`. The value is a transaction-local logical token:
staged reads, index ranges, and nested queries in the same mutation can use it, but it cannot escape
into an action, schedule argument, CRDT set member, or durable value before commit. At the durable
boundary Embedded replaces every persisted occurrence and the returned value with one device commit
timestamp. Convex binds the same logical value during authoritative replay, so the hosted timestamp
may differ from the optimistic device timestamp; result verification compares the logical value.

## Device-only functions

Put device-only code in the path or paths named by the build adapter's `local` option. There is no
special folder name and no naming convention. Every module under those roots is imported into the
device runtime at startup, so keep UI-only code outside them.

Use the generated, schema-bound `local` value. Do not import a global builder or register local
functions under `convex/`; that boundary keeps device-only code out of the hosted deployment.

```ts
// local/preferences.ts
import { v } from "convex/values";
import { local } from "../convex/_generated/embedded";

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
import { setCompact } from "../local/preferences";

await client.mutation(setCompact, { compact: true });
```

Replicated functions never read local tables or overlays. Compose device state in a local query or
in the view, then pass any identifiers needed for remote retention to a separate replicated query.
For example, watch local pinned IDs and pass the sorted IDs to a replicated `byIds` query. Distinct
argument sets create distinct remote memberships, so keep argument sets stable and bounded.

### Text field helper

`createTextField` from `@estifanos-sh/convex-embedded/text` is an optional, framework-neutral
writer for a single `e.text()` field. It turns the latest desired UI string into a guarded splice,
coalesces rapid edits, and retries from each fresh local value while a concurrent change makes the
previous splice stale. The caller supplies `read`, `write`, and `extract` so the helper has no
dependency on a UI framework or a document shape.

```ts
import { createTextField } from "@estifanos-sh/convex-embedded/text";

const body = createTextField({
  read: () => editor.getText(),
  write: (splice, base) => client.mutation(api.documents.spliceBody, { documentId, splice, base }),
  extract: (result) => result.body,
});

editor.onChange((next) => body.queue(next));
await body.settle(); // for navigation, save indicators, or a controlled teardown
body.close();
```

Use `queue(desired)` for ordinary edits and `flush()` to send pending work immediately. `adopt()`
accepts a remotely arrived authoritative value while preserving a pending local edit. `isDirty`
means the desired text differs from the last adopted value; `isSettling` means a debounce or write
is still active. A stale-base or splice-range result remains pending and retries after the debounce
until a fresh local read converges; a different write failure rejects `settle()`. `close()` cancels
timers and makes later write results inert, so it also ends a still-pending convergence loop.

## Client lifecycle and API

All platform clients share these methods:

```ts
await client.open();
await client.query(api.documents.list, {});
await client.mutation(api.documents.create, { title: "A document" });
await client.action(api.exports.create, { documentId });

const watch = client.watchQuery(api.documents.list, {});
const stopWatch = watch.onUpdate(() => {
  render(watch.localQueryResult());
});

const stopConnection = client.subscribeToConnectionState((state) => {
  console.log(state.local, state.replication);
});

const stopSettlements = client.subscribeToMutationSettlements((settlement) => {
  console.log(settlement.outcome);
});

stopWatch();
stopConnection();
stopSettlements();
await client.close();
```

| API                                        | Semantics                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open(setup?)`                             | Opens the durable runtime and performs package-owned compatibility work. An optional typed setup action performs application-owned device migration work before readiness. |
| `query(reference, args)`                   | Executes a local-capable query against the current local projection, or a remote query against Convex. It does not subscribe.                                              |
| `mutation(reference, args)`                | Commits a local-capable mutation durably before returning, or calls a remote mutation directly. Local success is not remote settlement.                                    |
| `action(reference, args)`                  | Calls a hosted Convex action. It requires `url` and a connection.                                                                                                          |
| `watchQuery(reference, args)`              | Returns a lazy watch. `onUpdate` starts it; `localQueryResult()` returns its latest value; removing the last listener stops it.                                            |
| `setAuth(fetchToken, onChange?)`           | Installs Convex's ordinary token fetcher. The runtime switches partition only after Convex accepts an identity.                                                            |
| `clearAuth()`                              | Immediately selects the unauthenticated partition. It does not relabel or send the previous identity's work.                                                               |
| `connectionState()`                        | Returns the latest frozen local and replication state snapshot.                                                                                                            |
| `subscribeToConnectionState(listener)`     | Receives future coalesced state changes only; it does not replay a prior state.                                                                                            |
| `subscribeToMutationSettlements(listener)` | Receives future durable `applied`, `conflict`, or `rejected` mutation outcomes only. Raw server rejection reasons are not exposed.                                         |
| `close()`                                  | Idempotently stops new work, releases subscriptions, and closes owned runtime resources. It does not wait forever for network settlement.                                  |

Calling a runtime-dependent method before `open()` rejects with `EMBEDDED_NOT_OPEN`. Repeated
`open()` calls with the same setup identity share the original operation; a different identity
rejects with `EMBEDDED_OPEN_MISMATCH`. A failed open leaves the active durable generation unchanged,
but that client instance is terminal: close it, create a new client, and open it again to resume.

The client reports local states `idle`, `starting`, `ready`, `failed`, and `closed`. A ready state
reports `durable` or `temporary` persistence. Replication reports `disabled`, `starting`, `offline`,
`online` (with `pending` or `idle` durable work), `error`, or `closed`.

## Authentication and offline data

Use the normal Convex token-fetcher contract:

```ts
client.setAuth(async ({ forceRefreshToken }) => {
  return await authProvider.fetchToken({ forceRefreshToken });
});
```

The local runtime uses the last identity snapshot accepted by Convex; it does not decode a JWT or
accept an application-provided identity override. An identity change isolates the old partition's
rows, memberships, CRDT heads, and pending operations. Pending work can resume only when Convex
accepts the same identity again. While offline, the last accepted identity is the cached local
capability until `clearAuth()` or a later server exchange changes it.

When a configured browser cannot open OPFS, Embedded uses a temporary in-memory SQLite store and
reports `persistence: "temporary"`. A reload, tab discard, or private-session close can erase local
documents and unsent mutations. `localStorage` is only a small selector and is not a database
fallback. A remote can restore server data into a fresh temporary store, but cannot recover a
mutation that disappeared before it pushed.

## User data migrations

There are three independent migration mechanisms. Pick the one that owns the data:

| Data                                                   | Owner                  | Mechanism                                                   |
| ------------------------------------------------------ | ---------------------- | ----------------------------------------------------------- |
| SQLite layout, record codecs, and replication metadata | Embedded               | Automatic during every `open()`                             |
| Hosted documents in replicated or hosted-only tables   | Your Convex deployment | Normal widen-migrate-narrow, often `@convex-dev/migrations` |
| Device-originated rows in `localTable`                 | Your application       | An optional internal local action passed to `open(setup)`   |

Applications never author migrations for Embedded's private SQLite tables, codecs, queues, or
protocol metadata. Package upgrades use a private candidate generation and atomically switch the
active generation only after a safe upgrade completes. A failed or interrupted candidate leaves
the last active generation readable; future `open()` calls resume it.

For hosted data, use Convex's normal widen-migrate-narrow rollout:

1. Widen validators so both old and new document shapes validate, then deploy code that handles
   both shapes.
2. Backfill authoritative Convex documents.
3. Verify the backfill completed, then narrow validators and remove compatibility code.

Use `@convex-dev/migrations` for a table-sized backfill. Register it beside Embedded and define its
worker with `remote.internalMutation`, so it always sees the hosted document shape:

```sh
pnpm add @convex-dev/migrations
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import migrations from "@convex-dev/migrations/convex.config.js";
import embedded from "@estifanos-sh/convex-embedded/convex.config";

const app = defineApp();
app.use(embedded);
app.use(migrations);
export default app;
```

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

export const addArchived = migrations.define({
  table: "documents",
  migrateOne: (_ctx, document) => ({ archived: document.archived ?? false }),
});
```

Deploy the widened schema and migration first. Dry-run a batch, start the resumable migration, and
inspect its completion before narrowing:

```sh
pnpm convex run migrations:addArchived '{"dryRun":true}'
pnpm convex run migrations:addArchived
```

Add `--prod` to both commands when targeting production. Use an ordinary idempotent
`remote.internalMutation` only for one record or another provably bounded change; never
`collect()` an unbounded table in one mutation. Hosted migration results reach devices through
normal pull replication. A hosted migration cannot access private device rows, and device setup
cannot rewrite hosted rows.

For device-owned data, author normal local Convex code and pass the typed action to `open()`:

```ts
// local/setup.ts
import { v } from "convex/values";
import { local } from "../convex/_generated/embedded";
import { rewritePreferences } from "./preferences";

export const setup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(rewritePreferences, {});
    return null;
  },
});
```

```ts
import { setup } from "../local/setup";

await client.open(setup);
```

There is no migration registry, magic folder, string function path, raw-record callback, or
`@estifanos-sh/convex-embedded/migrations` package. The setup action must be an imported,
build-stamped internal local action with empty arguments and a `null` return. It runs unauthenticated
and may orchestrate bounded, idempotent internal local queries and mutations. Every mutation commits
as a separate durable candidate batch, so paginate instead of collecting an unbounded table. Avoid
non-idempotent external effects such as `fetch()`: a crash can run setup again.

When a target schema removed a local table, setup can read the frozen pre-cutover records through
`ctx.ledger` and delete each record only after its replacement commits:

```ts
export const setup = local.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let cursor: string | null = null;
    do {
      const page = await ctx.ledger.read({
        cursor,
        table: "legacy_preferences",
        validator: v.object({ compact: v.boolean() }),
      });
      for (const preference of page.docs) {
        await ctx.runMutation(rewritePreferences, { compact: preference.compact });
        await ctx.ledger.delete({ id: preference._id, table: "legacy_preferences" });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return null;
  },
});
```

`ctx.ledger` is available only during setup and only for historical `localTable` records. It
validates every read with the supplied Convex validator. Keep the current setup action capable of
handling every historical device shape you still support: users can skip releases.

## Platform setup

### Browser: Vite and Vite+

Vite/Vite+ is the first-class browser integration. `convexEmbedded({ schema, local })` discovers
local-capable Convex modules, writes `convex/_generated/embedded.ts`, installs the registry in both
the application and worker builds, enables browser function execution, and configures development
and preview COOP/COEP headers. `schema` is required; `local` is optional, accepts one path or a list
of device-only roots, and defaults to no roots. `convexDir`, `schemaPath`, and `generatedPath` are
available for non-standard project layouts.

Production HTML responses must also send:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Import `@estifanos-sh/convex-embedded/browser` from client-only code. It cannot run during SSR.
After deployment, verify `crossOriginIsolated === true`, a worker starts, the WASM request succeeds,
and a local query completes.

`convexEmbeddedUnplugin` offers Rollup, Rolldown, Webpack, Rspack, and esbuild adapters. It
generates the registry, but the application must configure its worker pipeline, package-relative
WASM assets, the browser function flag, and production isolation headers. Vite/Vite+ is the
recommended integration. Turbopack and Parcel do not currently have adapters.

### Expo

Install the package, `expo-crypto`, and configure Metro. Expo Go is unsupported because it cannot
load the package's native module.

```sh
pnpm exec expo install expo-crypto
pnpm exec expo install tsx -- --dev
```

```js
// metro.config.js
require("tsx/cjs");
module.exports = require("./metro.config.ts");
```

```ts
// metro.config.ts
import { getDefaultConfig } from "expo/metro-config";
import { withConvexEmbedded } from "@estifanos-sh/convex-embedded/metro";
import schema from "./convex/schema";

module.exports = withConvexEmbedded(getDefaultConfig(__dirname), {
  schema,
  local: "local",
});
```

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/expo";

const client = new ConvexEmbeddedClient({
  path: "convex-embedded.sqlite3", // optional app-data-relative path
  url: process.env.EXPO_PUBLIC_CONVEX_URL,
});
await client.open();
```

Restart Metro after changing a schema or local function source so it regenerates the registry.

### Node

Node receives the same client API and native SQLite backend. Supply the schema and function graph
directly:

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/node";
import * as documents from "./convex/documents";
import schema from "./convex/schema";

const client = new ConvexEmbeddedClient({
  schema,
  modules: { documents },
  local: { preferences: () => import("./local/preferences.js") },
  path: ".convex-embedded/app.sqlite3",
  url: process.env.CONVEX_URL,
});

await client.open();
```

The Node `local` map supports ordinary device queries and mutations. A setup action passed to
`open(setup)` must originate in a build-stamped local graph; a hand-assembled loader map fails
closed for setup identity. One runtime owns remote delivery and schedules for a database path; do
not run multiple independent Node owners against the same SQLite file.

## Revisions, uploads, and devtools

Revisions are app-authorized retained document versions. The component exposes `rev.create`,
`rev.get`, `rev.list`, `rev.restore`, and bounded `rev.delete`, but applications must wrap them in
their own replicated functions. Authorize the live row before every component call; the component
does not know an application's ownership model. Revisions are not a privileged `client.rev` API and
are distinct from replication conflict detection and CRDT checkpoints.

`rev.restore` selects the revision and restores its CRDT state; its caller must write the matching
live row in the _same_ replicated mutation. Replace a value revision or delete a deleted revision:

```ts
export const restoreDocument = replicated.mutation({
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

`rev.delete` can remove only a non-active revision. Pass `numItems` and repeat the same authorized
call until its `{ isDone: true, deleted }` result says the operation finished. It has no cursor:
each call removes the next remaining CRDT records, so a cursor over the old set would be unsound.
Use `rev.list` to choose eligible retained revisions and schedule bounded deletion according to your
application's retention policy.

Use normal `ctx.storage.generateUploadUrl()` in application functions. Browser and Node expose
`createConvexEmbeddedUploadFetch(client)`, which handles local Embedded upload URLs and delegates
all other URLs to ordinary `fetch`. The returned local storage ID becomes durable mutation data and
the remote driver uploads bytes before authoritative replay.

For browser development, mount the optional panel:

```ts
import { mountEmbeddedDevtools } from "@estifanos-sh/convex-embedded/devtools";

const devtools = mountEmbeddedDevtools(client);
// later
devtools.unmount();
```

Use `embeddedDevtools()` from `@estifanos-sh/convex-embedded/devtools/vite` to configure the
TanStack Vite integration. It removes devtools code from production builds by default. Devtools use
the normal client methods; they do not grant raw SQLite, component-write, or authorization bypasses.

## Errors and troubleshooting

| Symptom                                       | Likely cause and response                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `EMBEDDED_NOT_OPEN`                           | Call `await client.open()` before queries, mutations, watches, or actions.                                     |
| `EMBEDDED_OPEN_MISMATCH`                      | Reuse the same setup action for concurrent/repeated `open()` calls, or create a new client for new setup work. |
| Browser worker never becomes ready            | Add the Vite/Unplugin registry to both relevant build graphs and verify worker/WASM assets are emitted.        |
| `crossOriginIsolated` is false                | Send both COOP and COEP headers in production; check third-party resource policy.                              |
| Browser reports temporary persistence         | OPFS was unavailable. Treat local state and unsent offline work as volatile.                                   |
| A function runs hosted-only                   | It uses `remote`, has a `"use node"` directive, is a system file, or is excluded from the local module graph.  |
| Expo native module is missing                 | Use a custom development or release build, not Expo Go, and configure Metro.                                   |
| A migration cannot read a removed local table | Read the historical table through `ctx.ledger` from an `open(setup)` action.                                   |

## Release and compatibility policy

The package owns its engine and protocol compatibility. App authors own only their schema and
device-originated data changes. Keep deployed device builds on a tested upgrade path, preserve setup
actions until the supported population has crossed them, and use normal Convex widen-migrate-narrow
for hosted documents. Never edit SQLite files, call package replication endpoints manually, or
depend on `internal/*` imports.

For source, examples, and issue tracking, see
[github.com/estifanos-sh/convex-embedded](https://github.com/estifanos-sh/convex-embedded).
