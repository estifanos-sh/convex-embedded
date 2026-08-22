---
title: Node
description: Configure modules, local functions, a database path, and optional replication for the Node client.
---

Node executes Convex functions in the current JavaScript process and stores
data through the packaged Rust/N-API backend.

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/node";
import schema from "./convex/schema.js";

const modules = {
  documents: () => import("./convex/documents.js"),
  embedded: () => import("./convex/embedded.js"),
};

const local = {
  preferences: () => import("./local/preferences.js"),
};

const client = new ConvexEmbeddedClient({
  local,
  modules,
  path: ".convex-embedded/app.sqlite3",
  schema,
  url: process.env.CONVEX_URL,
});

await client.open();
```

| Option    | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `schema`  | Default export from the application's Embedded schema           |
| `modules` | Convex modules keyed by module path                             |
| `local`   | Optional device modules keyed relative to the local root        |
| `path`    | Writable SQLite database path                                   |
| `url`     | Optional Convex deployment URL for replication and hosted calls |

The Node entry does not require a browser bundler plugin or cross-origin
isolation.

## Native artifacts

The package loads the native artifact for the current operating system and
architecture when `open()` runs. To use an explicitly built artifact, set
`CONVEX_EMBEDDED_NATIVE` to an absolute `.node` path.

Set `CONVEX_EMBEDDED_NATIVE_TRACE=1` to print artifact resolution diagnostics.

## Setup actions

Hand-assembled local loader maps support normal local queries and mutations. A
setup action passed to `open(setup)` must come from source transformed by an
Embedded bundler adapter so it carries a trusted module name and graph hash.
Unstamped setup references fail closed.
