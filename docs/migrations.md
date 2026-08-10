# Embedded Store Upgrades And Startup Setup

## Decision

Device startup has one public lifecycle entry point:

```ts
await client.open(setup);
```

`setup` is optional. When present, it is an imported internal local action with `{}` arguments and
a `null` result. It is ordinary local Convex code: the action composes internal local queries and
mutations through `ctx.runQuery` and `ctx.runMutation`. There is no migration registry, migration
folder, string function name, raw-record callback, or `@estifanos-sh/convex-embedded/migrations` export.

The optional action does not enable the store migration mechanism. Every `open()` runs the same
package-owned candidate-generation protocol. Package layout and codec upgrades therefore remain
automatic when no app setup action is needed. Supplying an action adds one app-authored phase to
that protocol before the candidate is published.

This design separates three kinds of evolution:

| Data owner                               | Mechanism                                                          |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Embedded SQLite layout and record codecs | Automatic package upgrade during `open()`                          |
| Hosted Convex documents                  | Hosted widen-migrate-narrow, usually with `@convex-dev/migrations` |
| Device-originated application data       | Optional internal local action passed to `open(setup)`             |

These mechanisms do not cross ownership boundaries. Hosted migration code cannot enumerate every
device's private rows, and device setup cannot rewrite authoritative hosted data.

## Public Authoring Model

An app writes normal local functions in the local roots it already gives the bundler:

```ts
// local/setup.ts
import { v } from "convex/values";

import { local } from "../convex/embedded.generated";
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

Application startup imports the typed value and passes it directly:

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";
import { setup } from "../local/setup";

const client = new ConvexEmbeddedClient({ url });
await client.open(setup);
```

There is no special filename. The action may live in any configured local root and may import
helpers or other local functions normally. Discovery and identity come from the existing local
module graph, so authors never type a function path string.

### Why the setup value is an action

A query cannot write. A mutation provides one atomic transaction, which is the wrong unit for a
large migration and cannot safely contain an unbounded scan. An action is the normal Convex
orchestration primitive: it can call bounded internal queries and mutations, and each mutation
commits independently to the unpublished candidate.

The setup action is deliberately narrower than an arbitrary client callback:

- it must be an internal local action;
- its argument validator must accept `{}`;
- its return validator must accept `null`;
- it must be imported from the stamped local module graph;
- public actions, local queries, local mutations, hosted references, callbacks, and strings are
  rejected by `open()`;
- it runs unauthenticated and receives no scheduler, file storage, raw ledger, or nested-action
  surface.

The handler remains JavaScript and may call imported helpers or platform globals that exist in its
runtime. Embedded cannot roll back an external side effect such as `fetch()`. Setup code must not
depend on non-idempotent external effects because a crash can cause it to run again.

### Author obligations

Each migration mutation must be idempotent and bounded. Large tables use an explicit cursor and one
mutation per page. An action that calls `collect()` across an unbounded table is invalid operational
design even if it type-checks.

The current setup action must understand every source shape the app still supports. A device may
skip releases; Embedded does not assume that it ran each historical app build.

Once setup succeeds, a later release may return to plain `open()`. The store remembers the last
completed setup identity even when its executable hook is retired, so an older build cannot treat
that action as new work and rerun it. Passing a different setup action replaces the remembered
identity through a new candidate.

For a dropped table or an old shape that is no longer part of the target schema, setup reads the
candidate ledger. It is a bounded, frozen pre-cutover view and is never part of the active schema.

Use the generated `local` value directly; no migration registry or folder is introduced:

```ts
// local/setup.ts
import { v } from "convex/values";

import { local } from "../convex/embedded.generated";

export const preferencesCurrentWrite = local.internalMutation({
  args: { compact: v.boolean() },
  handler: async (ctx, { compact }) => {
    if ((await ctx.db.query("preferences").first()) === null) {
      await ctx.db.insert("preferences", { compact });
    }
  },
});

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
        await ctx.runMutation(preferencesCurrentWrite, { compact: preference.compact });
        await ctx.ledger.delete({ id: preference._id, table: "legacy_preferences" });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return null;
  },
});
```

`ctx.ledger` reads only historical `localTable` records. `ctx.ledger.read` validates each
historical value with the supplied Convex validator.
`ctx.ledger.delete` consumes one historical record only after its replacement has committed. It is
a readonly context property and rejects outside the running setup action; TypeScript cannot
specialize an ordinary action handler from a later `open(setup)` call. Keep setup and its target-schema helpers idempotent so a resumed
candidate can safely run them again.

## Explicit Client Lifecycle

Constructors are inert. Creating a public browser, Expo, or Node client does not acquire a storage
lease, create a worker or native store, start a scheduler, or connect to Convex. Those resources are
created only by `open()`.

Operations that need the runtime fail with `EMBEDDED_NOT_OPEN` before `open()`. Calls to `setAuth`,
connection-state subscription, and mutation-settlement subscription may configure the client before
opening without starting it.

Concurrent calls obey these rules:

- calls with the same semantic setup identity share one open operation;
- a call with a different identity fails with `EMBEDDED_OPEN_MISMATCH`;
- an invalid setup value is rejected before platform resources are acquired;
- `close()` is idempotent and prevents new work;
- a failed open leaves the durable active generation unchanged.

The semantic setup identity is the stamped function reference plus the generated local-module graph
hash. It is not `Function.prototype.toString()`, object identity, or an app-provided version string.
Browser and Expo builds receive this stamp from their build integration. Node setup inputs must also
come from generated/stamped build output; a hand-assembled, unstamped loader map remains valid for
ordinary local functions but fails closed as a setup identity.

## Store Contract

The public store contract includes the application storage schema hash, the frozen kernel
fingerprint, the rebuildable generation-layout fingerprint, the current origin-record writer
fingerprint, the bootstrap version, and the package epoch. The completed setup identity is stored
beside the active contract, rather than changing that contract's physical format.

The kernel fingerprint covers only the append-only bootstrap, active pointer, originated ledger,
and content-addressed payload locating plane. A candidate never repairs or replaces that plane.
The generation fingerprint covers only tables and indexes that can be recreated in an unpublished
generation. Codec identities are keyed by permanent `(OriginKind, codec)` numbers. The writer hash
contains only current encoders; reader coverage contains every retained decoder. Adding a reader
does not itself rewrite a store. Changing a generation layout or current writer without advancing
the package epoch fails closed.

The application schema hash includes validators, table placement, fields, columns, CRDT fields, and
indexes. A same-schema backfill is detected through the stamped setup identity.

Durable epoch 1 / format 1 is the first public compatibility baseline. It is a store-layout
admission marker, not a negotiated wire version: wire, storage-binding, and coordinator
compatibility use their own computed hashes. A store from an unpublished
development build, a newer unsupported epoch, or a missing active contract fails closed and remains
untouched. There is no reader or automatic repair path for unreleased layouts. A future package
change that needs a physical-store transition must add and test its explicit forward bridge before
raising the epoch; an application never needs to author that bridge.

Candidate finalization treats the frozen origin ledger as the authoritative rebuild source. A
retry after an interrupted finalization drops and recreates every unpublished generation table,
including system projections, before replaying from the beginning. Resetting only the replay cursor
is invalid because insert-only projections such as the mutation table may already contain a partial
prefix.

The current durable baseline epoch is 1. The commit-timestamp floor remains a lazy key in the frozen kernel,
so stores that never use `ctx.db.vars.commitTs` pay no setup write.

Every release job resolves the requested ref once, and every qualification and assembly job checks
out that exact SHA. Only after common native, WASM, crash, stress, memory, and complete-package
assembly gates succeed may the workflow create the requested release tag at that SHA. Publication
depends on a tag-target equality check against the validated SHA.

## Physical Model

One SQLite database contains a frozen bootstrap plane and numbered generations.

The bootstrap plane stores only data needed to locate and select generations:

- bootstrap format version;
- active generation pointer;
- next and candidate generation ids;
- active and candidate contracts;
- candidate source generation;
- durable candidate phase and cursor records; and
- the frozen originated-record ledger and content-addressed payloads.

Its physical layout is stable enough that a future runtime can locate old records before it knows
how to decode their payloads. Versioned codecs solve decoding; the frozen ledger solves locating.

Generation-scoped tables contain materialized documents, indexes, queues, caches, and other runtime
state. The active pointer is the sole visibility boundary. A candidate may be partially built for
many process lifetimes without becoming visible to normal app operations.

Cutover is one transaction in the same database that changes the active-generation pointer and its
contract metadata. Filesystem rename is not the atomicity primitive: OPFS has no suitable atomic
rename contract, and SQLite state spans database, WAL, and shared-memory files.

## Record Ownership Policy

The store treats data by semantic ownership rather than by physical table.

| Record                                  | Policy during candidate construction                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localTable` document                   | Copy as originated state; app setup must rewrite or delete it if the target rejects it                                                                               |
| Local-field overlay                     | Validate from the origin ledger even without a base row; materialize compatible fields and retain removed or invalid orphan overlays dormant                         |
| Pending mutation and push envelope      | Preserve a compatible prefix; if one envelope conflicts with the target contract, quarantine its exact bytes and the identity's causal suffix before materialization |
| Scheduled local job                     | Preserve independent jobs; quarantine jobs created by a quarantined queue suffix; normal scheduler execution marks other missing or rejected functions as failed     |
| Revision and CRDT state                 | Preserve through the versioned record codec and content-addressed payloads                                                                                           |
| Identity metadata and local id mappings | Preserve with their identity partition through registered origin codecs                                                                                              |
| Clean pulled projection                 | Carry its exact server row and projection head as a versioned origin record                                                                                          |
| Subscription membership edge            | Carry each edge after its projection; deletion removes the edge origin atomically                                                                                    |
| Retained remote answer                  | Carry its exact skeleton, paths, runtime hashes, and clock after its disclosed projections                                                                           |
| Pull cursor                             | Carry last, with a digest of its membership and projection dependencies; reject materialization on any mismatch                                                      |
| SQL indexes, query cache, commit cache  | Recreate from the target contract                                                                                                                                    |

The compatibility contract includes the exact offline-visible authoritative view. Projection,
membership, result, and cursor origins are maintained in the same transaction as their generation
tables. Materialization order is projection, membership, result, then cursor. The cursor record
contains a dependency digest recomputed in the candidate, so an old cursor can never publish over
an empty or different projection. A later network pull refreshes this already-consistent view; it is
not required to reconstruct it after a package-only upgrade.

Originated state is never silently dropped. An app deletes its own obsolete `localTable` data
through an explicit setup mutation. Local-field origins are scanned independently of document
pages because an overlay may remain after its pulled base projection has been evicted. A removed
field, or an invalid orphan overlay with no normal `ctx.db` migration path, is retained in the
ledger but omitted from the active projection. Function-graph compatibility is deliberately not
guessed during store migration: the Rust store cannot soundly decide whether hosted application
code still accepts a function call. Target table, document, and CRDT compatibility is decidable,
however. TypeScript evaluates queued after-images with the complete target validators before any
candidate projection is built. It persists causal thresholds page by page. Rust then advances
bounded, cursor-backed association, disposition, and cleanup pages: the first incompatible envelope
and every causally later envelope for that identity are quarantined together with their derived CRDT
effects, schedules, local-id mappings, local overlays on canceled inserts, and revision checkpoints.
Each page is atomic and restartable, and cutover remains blocked until the whole policy is complete.
The committed mutation result remains as the durable idempotency cache, while exact prior queue
bytes remain in the ledger; no partial optimistic bundle is published or sent. Package records whose
versioned codec cannot be interpreted safely block cutover and leave the old generation active.
Internal retention/quarantine policy is not exposed as a public raw-record migration API.

## Candidate State Machine

Every open follows the same high-level protocol.

### 1. Inspect

Open the database under the platform's single-writer ownership mechanism. Read the active pointer,
active contract, target contract, and any existing candidate. Reject a newer epoch, corrupt
bootstrap state, divergent immutable package history, or a contract change that lacks the required
package transition.

### 2. Select or create a candidate

If the target contract equals the active contract, validate the physical schema and continue.
Otherwise resume the matching candidate or allocate a new generation. A stale candidate for a
different target is reclaimable only after proving it is not active or otherwise reachable.

### 3. Copy originated records

Read the active generation's originated ledger with a durable cursor. For every record, verify its
checksum, decode through the registered `(OriginKind, codec)` reader, apply every package adapter
whose introduction epoch is in the source/target interval, and re-encode with the current writer
before writing the candidate. Unknown kinds, codecs, flags, or corrupt payloads fail closed. Source
rows are never updated. Rebuildable physical rows are not copied; durable semantic remote state is
copied through its registered projection, membership, result, and cursor origins. Copy completion is
its own durable phase; later setup work never changes it back to pending.

This phase separation is load-bearing. Retrying setup must not recopy an old source record over a
record that a prior setup attempt transformed or deleted.

Before any setup workspace is materialized, validate queued envelopes against the target table,
document, and CRDT contract. Persist the first incompatible sequence for each identity, then apply
its causal-suffix bundle policy in bounded restartable pages. The setup runner has no remote lane and
therefore cannot append new push envelopes after this policy phase.

### 4. Materialize a setup workspace

Build a private setup workspace from:

1. the stored source physical schema;
2. the current target schema.

The store persists the source tables, placement, columns, indexes, CRDT fields, and local-field
names. Setup supplies a Convex validator only for the historical record shape it reads through
`ctx.ledger.read`; it never registers a second schema. Target definitions own every public name.
Conflicting source columns and
indexes receive deterministic, content-derived private `setup_*` aliases that remain unique and
within the physical identifier limit across several skipped shapes. Source-only device tables remain
readable through the candidate ledger so a skipped release can migrate data out of a table the
target removed.

The workspace is never a publishable contract.

### 5. Run optional app setup

Bind ordinary local database operations to the candidate generation and run the setup action with
empty arguments and an unauthenticated context. Each `ctx.runMutation` commits to the candidate.
Queries observe candidate state, including changes committed by earlier migration batches.

If the action throws, unbind and close. The active pointer does not change. That client instance is
terminal: close it, construct a new client, then open with the same setup identity to resume the
candidate and rerun the idempotent action.

If no action is supplied, this phase is skipped. Compatible package and schema upgrades still
continue automatically.

### 6. Validate and rebuild under the target contract

Bind the candidate to the target schema and scan every target document. Independently scan every
local-field origin, including overlays whose pulled base row is absent. Application validators
execute in the JavaScript runtime; the Rust record layer does not guess at their semantics. Invalid
fields attached to a visible document abort finalization so app setup can migrate them normally.
Removed fields and invalid orphan overlays are retained dormant because no ordinary document is
available to app code. Any remaining originated application document that violates the target
aborts finalization. That is how an omitted app migration is caught: the old generation remains
readable instead of silently publishing invalid data.

Then drop the candidate's temporary document projection, recreate only target tables and indexes,
and rematerialize from the candidate's originated ledger. This prevents compatibility columns or
source-only tables from leaking through cutover.

### 7. Validate package state and cut over

Validate checksums, record codecs, target schema, package layout, candidate reachability, and phase
completion. Then one SQLite transaction publishes the candidate generation and its contract.

Only after publication may normal local operations, the scheduler, remote replication, or a refresh
pull begin. The carried remote view is already internally consistent and available offline. A
post-cutover refresh may fail without rolling back or corrupting the completed local migration.

### 8. Retire

Old generations remain intact through cutover and until the replacement normal runtime reports
ready. Browser coordination and native store ownership ensure that no second writer can still use
the old generation at that point. Cleanup is bounded and restartable; content-addressed payload
garbage collection separately proves that no retained origin in any remaining generation references
a payload before deleting it.

## Crash And Failure Semantics

| Failure point                            | Required result                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Before candidate allocation              | Active generation unchanged                                                 |
| During origin copy                       | Resume from copy cursor; do not expose candidate                            |
| During compatibility materialization     | Resume materialization; do not expose candidate                             |
| During a setup mutation                  | That mutation rolls back; earlier candidate batches remain durable          |
| After setup transformed/deleted a record | Retry must not recopy the active source over it                             |
| During target rebuild                    | Rebuild resumes or restarts from candidate origins; active remains readable |
| During pointer transaction               | SQLite exposes either old or new pointer, never a half-cutover              |
| During post-cutover pull                 | New generation stays active and pull retries normally                       |

Power loss, worker termination, tab close, process death, and ordinary thrown errors follow the same
model. `synchronous=NORMAL` is not treated as a cross-file cutover guarantee; the single-database
pointer transaction is the guarantee.

## Cross-Tab And Cross-Process Rules

Only one runtime owns a physical store for writes at a time. Browser ownership uses the existing
page-level lock/coordinator protocol; native platforms use their store ownership primitive.

Runtime identity includes schema, module graph, setup action, package, protocol, ABI, epoch, and
physical storage id. A second tab with a different setup identity cannot join or replace the first
runtime. Identity validation happens before worker creation or storage acquisition, and a rejected
open cannot mutate the configuration used by a later valid open.

An older runtime that encounters a newer bootstrap or package epoch preserves the bytes and fails
closed. It never attempts a backward rebuild.

## Hosted Coordination

Hosted changes continue to use widen-migrate-narrow:

1. widen validators and deploy code that understands old and new hosted shapes;
2. backfill with `@convex-dev/migrations` or a bounded internal mutation;
3. verify completion;
4. ship device setup when private device data also needs rewriting; and
5. narrow only after the supported client population can read the final shape.

The device candidate contains no network dependency. Startup does not connect or pull until local
cutover has completed. This keeps a hosted outage from making a local migration non-atomic.

## Public Surface And Non-Goals

The public migration-related surface is only:

```ts
client.open(setup?);
local.internalAction(...);
ctx.ledger.read(...);
ctx.ledger.delete(...);
ctx.runQuery(...);
ctx.runMutation(...);
```

There is intentionally no public `carry`, `deviceMigration`, `defineDeviceMigrations`, migration
manifest, raw-record kind, quarantine exporter, or migration event payload. `ctx.ledger` is the one
bounded, validator-checked reader for historical `localTable` records; package upgrade details otherwise stay
private so the storage team can evolve codecs and recovery without freezing a second application ABI.

The setup action is not a general application bootstrap callback. It is contract-triggered,
restartable candidate work. Routine per-launch tasks belong in ordinary application code after
`open()`.

## Required Validation

The implementation is not complete unless automated tests cover:

- constructors are inert on browser, Expo, and Node;
- every runtime-dependent method fails before `open()`;
- same-identity concurrent opens coalesce and different identities reject;
- invalid setup values acquire no platform resources;
- automatic package/compatible schema upgrades work with plain `open()`;
- a same-schema setup graph change creates a candidate;
- first-install setup runs against an unpublished candidate;
- a thrown setup leaves the old generation active;
- a crash after a transformed or deleted record never recopies the source record;
- skipped releases can read and empty a dropped source table through the workspace;
- target validators, columns, indexes, CRDT fields, and local fields win public names;
- orphan overlays are independently validated and incompatible ones remain retained but dormant;
- a validator-, table-, or CRDT-incompatible queued envelope and its causal suffix are fully
  quarantined before materialization, while an unaffected prefix remains pushable;
- queue-policy threshold, association, disposition, and cleanup pages resume without unbounded
  memory or transaction growth;
- reopening an interrupted candidate does not partially restore a quarantined queue bundle;
- final rebuild removes every workspace-only table, column, and index;
- an unmigrated incompatible originated record blocks cutover;
- clean projections, memberships, retained results, and cursors survive package-only cutover
  offline, while a cursor whose dependency digest does not match is never published;
- package layout and codec changes participate in the contract;
- ABI mismatches reject stale Node, WASM, Android, and iOS artifacts;
- cross-tab/process setup mismatches reject before ownership transfer;
- older runtimes preserve newer stores;
- cutover survives termination at every durable phase; and
- retired-generation cleanup cannot remove reachable payloads.

## Implementation Map

- `packages/embedded/src/client.ts`: explicit lifecycle, setup validation, candidate orchestration
- `convex/embedded.generated.ts`: generated schema-bound `local` authoring contract
- `packages/embedded/src/local.ts`: public local function types
- `packages/embedded/src/local/internal.ts`: private builders, stamps, and setup identity markers
- `packages/embedded/src/storage/workspace.ts`: private source/target compatibility schema
- `packages/embedded/src/migrations.ts`: internal candidate and authoritative-origin validation
- `packages/embedded/src/browser/runtime.ts`: worker-owned candidate execution
- `crates/storage/src/store/mod.rs`: durable phases, binding, target rebuild, pointer cutover
- `crates/storage/src/types/migration.rs`: persisted store contract and candidate metadata
- `README.md`: app-facing package, hosted, and device migration guidance
