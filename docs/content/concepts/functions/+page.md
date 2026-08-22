---
title: Local functions
description: Author device-only queries, mutations, and setup actions with generated schema-bound builders.
---

# Local functions

Device-only functions live in directories named by the bundler's `local`
option. They use the application-bound `local` builder generated from the
Embedded schema.

```ts
// local/preferences.ts
import { v } from "convex/values";
import { local } from "../convex/embedded.generated";

export const read = local.query({
  args: {},
  handler: async (ctx) => await ctx.db.query("preferences").first(),
});

export const setCompact = local.mutation({
  args: { compact: v.boolean() },
  handler: async (ctx, { compact }) => {
    const current = await ctx.db.query("preferences").first();
    if (current) await ctx.db.patch("preferences", current._id, { compact });
    else await ctx.db.insert("preferences", { compact });
  },
});
```

Import the typed registration directly in application code:

```ts
import { read, setCompact } from "../local/preferences";

await client.mutation(setCompact, { compact: true });
const preferences = await client.query(read, {});
```

## Configure local roots

There is no default local directory. Pass one path or a list of paths:

```ts
convexEmbedded({
  local: ["local", "device"],
  schema,
});
```

Every module under those roots is bundled into the device runtime and imported
at startup. Registration exports receive stable module names; constants,
helpers, and other exports remain ordinary TypeScript values.

Keep UI code outside local roots because the worker or native runtime loads the
entire graph. Modules under `convex/` cannot register local functions or import
from a local root, which keeps device-only code out of the hosted deployment.

## Supported context

Local queries and mutations use the device-visible data model. Local actions can
orchestrate internal local queries and mutations. They do not receive hosted
functions, Convex scheduling, hosted file storage, or arbitrary access to
private replication records.
