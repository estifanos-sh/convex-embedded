---
title: Define the schema
description: Declare replicated, hosted-only, and device-only data in one typed Convex schema.
---

Use `defineEmbeddedSchema` instead of `defineSchema`, then mark the tables that
replicate or remain local:

```ts
// convex/schema.ts
import {
  defineEmbeddedSchema,
  localTable,
  replicatedTable,
} from "@estifanos-sh/convex-embedded/schema";
import { e } from "@estifanos-sh/convex-embedded/values";
import { v } from "convex/values";

export default defineEmbeddedSchema({
  documents: replicatedTable({
    owner: v.string(),
    body: e.text(),
    serverLabel: e.remote(v.optional(v.string())),
    expanded: e.local(v.boolean()),
  }).index("by_owner", ["owner"]),

  preferences: localTable({
    compact: v.boolean(),
  }),
});
```

`replicatedTable` documents exist on the hosted server, replication wire, and
device. A plain Convex `defineTable` inside `defineEmbeddedSchema` is hosted-only.
`localTable` documents exist only on the device.

Fields in a replicated table are replicated by default. Wrap a validator with
`e.remote()` to keep that field hosted-only or `e.local()` to store a device
overlay separately from its replicated row.

## Index rules

- An index containing only replicated fields exists on the server and device.
- An index containing an `e.remote` field is hosted-only.
- An index cannot contain an `e.local` field.
- Search, vector, and staged indexes on a replicated table must be hosted-only.

The embedded store does not implement search, vector, or staged index kinds.

## Generated contract

The configured bundler writes `convex/embedded.generated.ts`. It contains a
function manifest, schema and module-graph identity hashes, and schema-bound
local builders.

Treat it like other generated output: check it in when your project checks in
generated files, never edit it by hand, and run the configured bundler after
schema or function changes.
