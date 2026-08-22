---
title: Browser and Vite
description: Build the Embedded worker, SQLite WASM runtime, generated registry, and isolation headers with Vite.
---

The browser entry is a worker-backed runtime. A valid build must discover local
functions, build the module worker, emit SQLite WASM and pthread assets, and
serve isolated HTML.

Vite is the first-class, end-to-end tested integration:

```ts
// vite.config.ts
import { convexEmbedded } from "@estifanos-sh/convex-embedded/vite";
import { defineConfig } from "vite";
import schema from "./convex/schema";

export default defineConfig({
  plugins: [convexEmbedded({ schema })],
});
```

Vite+ builds through Vite and uses the same plugin.

## Plugin options

Paths are relative to the Vite project root:

```ts
convexEmbedded({
  convexDir: "convex",
  generatedPath: "embedded.generated.ts",
  local: "local",
  schema,
  schemaPath: "schema.ts",
});
```

`schema` is required. `convexDir`, `generatedPath`, and `schemaPath` above are
the defaults. `local` has no default and accepts one path or an array.

Files in `convex/` with a top-level `"use node"` directive remain hosted-only
and are excluded from the device registry.

## Create the client

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";

const client = new ConvexEmbeddedClient({
  url: import.meta.env.VITE_CONVEX_URL,
});
await client.open();
```

Omit `url` for local-only execution.

## Browser persistence

The client attempts a real SQLite open in OPFS. It does not infer durability
from user-agent strings or the presence of `navigator.storage.getDirectory`.

If OPFS is denied, Embedded opens the same schema in memory and reports
`persistence: "temporary"`. Current Safari and Firefox private browsing can
take this path. Chromium may provide an in-memory incognito filesystem that is
deleted when the profile closes.

Temporary storage can disappear on reload, tab discard, browser exit, or
private-session close. Pull can recover authoritative hosted data, but cannot
recover an offline mutation erased before push.

`localStorage` is only used for a small storage selector. It is not a database
fallback.
