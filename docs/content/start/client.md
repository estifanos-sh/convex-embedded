---
title: Create a client
description: Open a platform client, run Convex functions, subscribe to local results, and close cleanly.
---

Create the client from the entrypoint for your runtime. Browser applications
use the browser entry from client-only code:

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";

import { api } from "../convex/_generated/api";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});

await client.open();
```

Construction is inert. No worker, native store, scheduler, storage lease, or
remote connection starts until `open()`.

## Call functions

Use generated Convex references for hosted or replicated functions and imported
local references for device-only functions:

```ts
const documents = await client.query(api.documents.list, {});
const id = await client.mutation(api.documents.create, { body: "Hello" });

import { setCompact } from "../local/preferences";
await client.mutation(setCompact, { compact: true });
```

`query()` performs a one-shot read. `mutation()` commits locally before a
replicated mutation settles against hosted authority. `action()` executes the
appropriate hosted or local action surface.

## Watch a query

```ts
const watch = client.watchQuery(api.documents.list, {});
const unsubscribe = watch.onUpdate(() => {
  console.log(watch.localQueryResult());
});
```

`localQueryResult()` returns `undefined` until the first value is available and
throws the current query error when the watcher is in an error state.

## Shut down

Unsubscribe application listeners and close the client during teardown:

```ts
unsubscribe();
await client.close();
```

`close()` is idempotent. New operations fail with `EMBEDDED_CLOSED` after
shutdown begins.
