# Embedded

A local-first engine for Convex. Embedded runs Convex queries and mutations on-device, stores data in Turso, and uses Loro for local-first document history and peer replication.

## Roadmap

This roadmap records the target architecture. The current implementation is still the lower-level Rust/Turso runtime and browser coordinator.

### Implemented Today

- Rust/Turso storage with schema-derived indexes, mutation idempotency records, and native/WASM bindings.
- Local JavaScript execution for Convex queries and mutations, including validators and basic watch invalidation.
- Browser coordination through Web Locks and BroadcastChannel so one leader owns OPFS storage while followers proxy work.
- Vite/unplugin bundler adapters for packaging browser schema and function modules.

### Core Runtime

Embedded keeps one local writer per storage identity.

```txt
ConvexEmbeddedClient
  -> browser/React Native/node runtime
     -> single local writer
        -> Rust storage engine
           -> Turso rows, indexes, metadata
           -> Loro document state
```

Browser tabs coordinate through Web Locks and BroadcastChannel. One leader owns WASM, Turso, and OPFS. Followers proxy requests and watches to the leader.

We are not designing around local CDC or MVCC. The runtime commits through one writer, records enough metadata for remote delivery and debugging, and keeps CRDT compute on devices.

### Convex Parity

Embedded should feel like Convex first. The current runtime is still a subset, and full parity needs explicit work in these areas:

- Actions, HTTP actions, and `ctx.runAction`.
- Public/internal visibility checks for locally callable functions.
- Auth identity, auth-aware watch dedupe keys, and local identity persistence.
- Scheduler, file storage, and system table support.
- Search and vector indexes.
- Stable Convex-style pagination cursors.
- More precise realtime dependency tracking than table-level invalidation.
- Query logs and query journals.
- Convex value limits, object key rules, record key rules, nesting limits, array length limits, and document size limits.
- Hosted-compatible ID shape or a clear local-to-hosted ID mapping layer.
- Convex-style optimistic update ordering over base query results.
- Clear separation between Convex-compatible query APIs and embedded-only helpers such as `count()` or `fullTableScan()`.

Known aligned behavior:

- `undefined` mutation returns normalize to `null`.
- `ctx.db.patch(id, { field: undefined })` removes the field after local normalization.

### Schema API

Users keep normal Convex schema builders. Embedded adds field helpers only.

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { schema } from "@convex-dev/embedded/schema";

export default defineSchema({
  games: defineTable({
    name: v.string(),
    status: v.string(),
    log: schema.text(),
    score: schema.counter(),
    players: schema.list(v.id("users")),
    map: schema.tree(),
  }).index("by_status", ["status"]),
});
```

Plain Convex fields become Loro LWW map fields when edited by embedded clients. `schema.text`, `schema.counter`, `schema.list`, `schema.set`, and `schema.tree` opt into richer Loro containers.

There is no `embedded.table` and no `schema.merge`. Table identity comes from `defineTable`; LWW is the default scalar behavior for embedded clients.

### Writes

Normal Convex writes stay normal.

```ts
await ctx.db.patch(id, {
  name: "Skeld",
  status: "open",
});
```

Loro container edits use explicit operations.

```ts
import { op } from "@convex-dev/embedded";

await ctx.db.patch(id, {
  log: op.text.splice({ index: 0, delete: 0, insert: "started\n" }),
  score: op.counter.inc(1),
  players: op.list.insert({ index: 0, value: userId }),
});
```

Server-side or non-embedded writes are authoritative projection writes. Embedded clients adopt those rows as new branch roots on reconnect instead of replaying local edits over them.

### History

Every embedded document can keep multiple Loro branches. Branches preserve history across embedded edits, peer imports, remote imports, forks, restores, and normal Convex server writes.

```ts
const history = client.history("games", gameId);

const branches = await history.branches();
const current = await history.current();

await history.checkout(branchId);
const fork = await history.fork(branchId);
await history.restore(fork.id);

const diff = await history.diff(leftBranchId, rightBranchId);
```

Branch vocabulary stays small.

```ts
type BranchOrigin = "init" | "remote" | "peer" | "reset" | "fork" | "restore";
type BranchStatus = "current" | "archived";

type Branch = {
  id: string;
  table: string;
  document: string;
  origin: BranchOrigin;
  status: BranchStatus;
  parent?: string;
  head: string;
  createdAt: number;
};
```

`reset` means a normal Convex write replaced the projected row. The old branch remains archived and can be inspected, forked, or restored.

### Migrations

Embedded migrations should be a compatible extension of `@convex-dev/migrations`. Users change the import path, not the mental model.

```ts
import { Migrations } from "@convex-dev/embedded/migrations";
import type { DataModel } from "./_generated/dataModel";

export const migrations = new Migrations<DataModel>(components.migrations);

export const addStatus = migrations.define({
  table: "games",
  migrateOne: async (_ctx, game) => ({
    status: game.status ?? "open",
  }),
});

export const normalizeNames = migrations.define({
  table: "games",
  migrateOne: async (_ctx, game) => ({
    name: game.name.trim(),
  }),
});

export const runAll = migrations.runner([addStatus, normalizeNames]);
```

The ordered runner is the canonical migration sequence for embedded clients. The same definitions run on the server as normal Convex migrations, while the embedded bundler records a local manifest for Turso rows, Loro blobs, branch metadata, projections, and pending records.

### Peer

Peer replication has one data transport and three signaling paths.

```txt
local   -> BLE/local proximity signaling where available
remote  -> Convex-backed signaling
code    -> QR/copy/NFC signaling handoff

all paths
  -> WebRTC DataChannel
     -> embedded frames
        -> Loro bytes
```

Join a shared space.

```ts
await client.peer.join({
  via: "local",
  space: `game:${gameId}`,
  documents: [{ table: "games", id: gameId }],
  policy: "auto",
});
```

Use fallback paths.

```ts
await client.peer.join({
  via: ["local", "remote"],
  space: `game:${gameId}`,
  documents: [{ table: "games", id: gameId }],
});
```

Use a manual code handoff when no live signaling path exists.

```ts
const invite = await client.peer.invite({
  documents: [{ table: "docs", id: docId }],
});

const answer = await client.peer.accept({
  code: scannedInviteCode,
});

await invite.confirm({
  code: scannedAnswerCode,
});
```

React Native should treat `local` as a first-class mobile path. Browser support is capability-gated. `code` remains the universal offline fallback.

Internal peer frames use `kind` for discriminated unions.

```ts
type Frame =
  | { kind: "open"; peer: string; schema: string; epoch: number }
  | { kind: "head"; docs: Head[] }
  | { kind: "pull"; docs: Need[] }
  | { kind: "patch"; doc: DocKey; branch: string; data: Uint8Array; head: string }
  | { kind: "base"; doc: DocKey; branch: string; data: Uint8Array; head: string };
```

We reserve `type` for external data that already uses that field, such as Convex validator JSON.

### Client Targets

```ts
import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});
```

```ts
import { ConvexEmbeddedClient } from "@convex-dev/embedded/react-native";

const client = new ConvexEmbeddedClient({
  url: process.env.EXPO_PUBLIC_CONVEX_URL,
});
```

```ts
import { ConvexEmbeddedClient } from "@convex-dev/embedded/node";

const client = new ConvexEmbeddedClient({
  url: process.env.CONVEX_URL,
  storage: { path: "./app.db" },
});
```

If remote peer signaling or remote projection is enabled, the app installs embedded server support once.

```ts
import { defineApp } from "convex/server";
import embedded from "@convex-dev/embedded/convex.config";

const app = defineApp();
app.use(embedded);

export default app;
```

## Develop

```bash
vp install   # install dependencies
vp check     # format, lint, typecheck
vp test      # run tests
```
