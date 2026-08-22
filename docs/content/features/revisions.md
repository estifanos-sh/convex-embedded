---
title: Revisions
description: Retain conflict versions and explicit savepoints behind application authorization.
---

Revisions are retained document versions. They are not replication's
compare-and-swap mechanism and are not internal CRDT compaction checkpoints.

Optimistic validation decides whether a mutation still applies to current
hosted state. If concurrent work displaced a value, the component can retain it
as a conflict revision. Applications can also create explicit savepoints.

## Authorize revision access

Revision access always goes through an app-authored function. The wrapper
performs authorization before calling `components.embedded.rev.*`.

```ts
export const savepoint = replicated.mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, { id }) => {
    const document = await requireOwnedDocument(ctx, id);
    const { _id, _creationTime, ...value } = document;
    return await ctx.runMutation(components.embedded.rev.create, {
      deleted: false,
      rowId: id,
      table: "documents",
      value,
    });
  },
});
```

Restore a selected revision and update the live row in the same transaction:

```ts
export const restore = replicated.mutation({
  args: { id: v.id("documents"), revId: v.string() },
  handler: async (ctx, { id, revId }) => {
    await requireOwnedDocument(ctx, id);
    const revision = await ctx.runMutation(components.embedded.rev.restore, {
      revId,
      rowId: id,
      table: "documents",
    });
    if (revision.deleted) await ctx.db.delete(id);
    else await ctx.db.replace(id, revision.value);
  },
});
```

## Public component surface

- `create` makes an explicit savepoint.
- `get` reads one revision.
- `list` pages through a row's history or retention candidates.
- `restore` selects a revision for the app wrapper to apply.
- `delete` removes one non-active revision.

Deletion is bounded because one revision can reference many CRDT records. Pass
`numItems` and repeat the same call until it returns
`{ isDone: true, deleted }`. The active revision cannot be deleted.

Applications own retention policy by listing eligible revisions and scheduling
bounded deletes.
