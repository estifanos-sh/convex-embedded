---
title: Compose local and replicated data
description: Combine device state with replicated query results without creating invalid local subscriptions.
---

Device state and replicated data compose in one direction. A replicated
function cannot read a `localTable` or `e.local` overlay, and `ctx.runQuery`
does not cross placements.

## Presentation-only state

If device state changes only how rows are displayed—pinned rows, collapsed
sections, or local highlights—watch the replicated query and local query
separately, then combine their results in view code.

## State that changes retention

If device state changes which rows the device must keep, pass a bounded value to
a second replicated query:

```ts
// convex/documents.ts
export const byIds = replicated.query({
  args: { ids: v.array(v.id("documents")) },
  returns: v.array(documentValidator),
  handler: async (ctx, { ids }) => {
    const documents = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return documents.filter((document) => document !== null);
  },
});
```

```ts
const pinned = client.watchQuery(pinnedIds, {});
const documents = client.watchQuery(api.documents.byIds, {
  ids: [...(pinned.localQueryResult() ?? [])].sort(),
});
```

Arguments identify a subscription. Sort set-like arrays, keep them bounded, and
avoid creating a new argument value when the logical set did not change.

## What not to do

Do not recreate a replicated query inside a local query. The local query sees
only rows another subscription already delivered, publishes no subscription of
its own, and is not served from the hosted query's retained answer. It can show
a list the server never returned and cannot safely implement remote paging.
