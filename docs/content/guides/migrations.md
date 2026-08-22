---
title: Schema changes and migrations
description: Upgrade package internals, hosted data, and device-originated records with the mechanism that owns each layer.
---

Embedded has three migration layers. Use the layer that owns the data being
changed.

| Change                                    | Migration mechanism                       |
| ----------------------------------------- | ----------------------------------------- |
| Embedded private SQLite layout and codecs | Automatic package upgrade during `open()` |
| Hosted fields and documents               | Convex widen-migrate-narrow               |
| Device-originated tables and overlays     | Optional internal local setup action      |

A hosted migration cannot enumerate private device records. Device setup cannot
change authoritative hosted rows. If a release changes both, coordinate two
separate migration phases.

## Package compatibility

Applications never migrate Embedded's private tables or record formats.
`open()` performs package-owned compatibility work and leaves the active store
unchanged when a safe upgrade cannot be proven.

Stores from unpublished development layouts may predate the public compatibility
baseline. Embedded preserves those stores and fails with
`EMBEDDED_PRE_BASELINE_STORE`; clear development-only app storage or choose a
new storage id.

## Hosted Convex data

Use the normal widen-migrate-narrow sequence:

1. Widen validators so old and new documents are accepted.
2. Deploy code that handles both shapes.
3. Backfill existing documents.
4. Verify completion.
5. Narrow validators and remove compatibility code.

For table-sized work, install and register `@convex-dev/migrations`, then use
Embedded's `remote.internalMutation` builder:

```ts
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

Dry-run one batch before starting the resumable migration:

```bash
npx convex run migrations:backfillArchived '{"dryRun":true}'
npx convex run migrations:backfillArchived
```

An ordinary `remote.internalMutation` is appropriate for one document or
another provably bounded change. Keep it idempotent. Never read an unbounded
table with `collect()` in one mutation.

Hosted migration results reach devices through normal pull replication.

## Device setup actions

Pass an imported internal local action to `open()` when current device-owned
data needs application-authored work:

```ts
// local/setup.ts
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
await client.open(setup);
```

The setup reference must be imported from the stamped local module graph. It
must accept `{}` and return `null`. Public actions, callbacks, strings, hosted
references, queries, and mutations are rejected before platform resources are
acquired.

Each `ctx.runMutation` is a separate durable batch. Setup must be idempotent,
paginate bounded work, and avoid non-idempotent external side effects. Setup
runs unauthenticated and does not receive hosted functions, scheduling, file
storage, or nested local actions.

## Read a removed local table

When the current schema removed a local table, setup can read the frozen
pre-cutover candidate ledger:

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
        await ctx.runMutation(preferencesCurrentWrite, {
          compact: preference.compact,
        });
        await ctx.ledger.delete({
          id: preference._id,
          table: "legacy_preferences",
        });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return null;
  },
});
```

`ctx.ledger` is available only while the action is running as setup. Validate
historical values explicitly and delete each old record only after its
replacement commits.

Keep the setup action in every build that may need to run or resume it. A later
release can return to plain `open()` after the supported device population has
completed the action. Pass a different setup action for later work; it must
handle every source shape still supported across skipped releases.
