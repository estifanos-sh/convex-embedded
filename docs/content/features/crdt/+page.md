---
title: CRDT fields
description: Declare collaborative text, count, and set fields and edit them through typed mutation intents.
---

# CRDT fields

Declare collaborative fields with the values entrypoint. Loro computation runs
in the local Rust or WASM runtime; Convex stores opaque payloads and ordinary
materialized values.

```ts
import { defineEmbeddedSchema, replicatedTable } from "@estifanos-sh/convex-embedded/schema";
import { e } from "@estifanos-sh/convex-embedded/values";
import { v } from "convex/values";

export default defineEmbeddedSchema({
  documents: replicatedTable({
    body: e.text(),
    owner: v.string(),
    reactions: e.count(),
    tags: e.set(v.string()),
  }).index("by_owner", ["owner"]),
});
```

Edit fields through typed database intents rather than replacing their
materialized value directly:

```ts
export const insertText = replicated.mutation({
  args: {
    id: v.id("documents"),
    index: v.number(),
    value: v.string(),
  },
  handler: async (ctx, { id, index, value }) => {
    await ctx.db.text.splice("documents", id, "body", {
      delete: 0,
      index,
      insert: value,
    });
  },
});
```

Text offsets use JavaScript UTF-16 indices and reject invalid scalar
boundaries. Multiple intents in one mutation observe the progressively updated
materialized value.

Use count intents for finite numeric deltas and set intents for validated set
membership changes. The schema validator determines the materialized value
visible to application queries.

CRDT payloads participate in revisions and bounded retention cleanup, but they
are not exposed as raw application records.
