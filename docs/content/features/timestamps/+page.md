---
title: Commit timestamps
description: Persist and return Convex commit timestamps from local and replicated mutations.
---

# Commit timestamps

Embedded implements Convex 1.43's `ctx.db.vars.commitTs` in local and
replicated mutations. Declare persisted and returned timestamps with
`v.commitTs()`.

```ts
// convex/schema.ts
export default defineEmbeddedSchema({
  events: replicatedTable({
    committedAt: v.commitTs(),
    name: v.string(),
  }).index("by_committed_at", ["committedAt"]),
});
```

```ts
// convex/events.ts
export const create = replicated.mutation({
  args: { name: v.string() },
  returns: v.commitTs(),
  handler: async (ctx, { name }) => {
    const committedAt = ctx.db.vars.commitTs;
    await ctx.db.insert("events", { committedAt, name });

    await ctx.db
      .query("events")
      .withIndex("by_committed_at", (q) => q.eq("committedAt", committedAt))
      .unique();

    return committedAt;
  },
});
```

The value is logical while the transaction runs. Staged reads can compare and
index it. At commit, Embedded atomically replaces every persisted occurrence
and the returned value with one device commit timestamp.

## Where the placeholder can travel

The pending value cannot escape through a top-level query or action, scheduled
function arguments, CRDT set members, or durable storage without resolution. A
nested query called by the same mutation may receive and return it because it
shares the transaction.

During authoritative replay, the same logical value binds to hosted Convex's
`ctx.db.vars.commitTs`. The hosted physical timestamp may differ from the device
timestamp. Result verification hashes the logical value rather than either
physical timestamp.
