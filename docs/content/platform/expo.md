---
title: Expo and Metro
description: Configure Metro and run the native Embedded store in iOS and Android builds.
---

Expo development and release builds use the native store exposed by
`@estifanos-sh/convex-embedded/expo`. Expo Go cannot load this native module.

Install Expo's supported TypeScript configuration hook:

```bash
npx expo install tsx -- --dev
```

Use a JavaScript shim so Metro can load a TypeScript configuration that imports
the application schema:

```js
// metro.config.js
require("tsx/cjs");
module.exports = require("./metro.config.ts");
```

```ts
// metro.config.ts
import { withConvexEmbedded } from "@estifanos-sh/convex-embedded/metro";
import { getDefaultConfig } from "expo/metro-config";
import schema from "./convex/schema";

module.exports = withConvexEmbedded(getDefaultConfig(__dirname), {
  local: "local",
  schema,
});
```

Metro analyzes the schema, rewrites `convex/embedded.generated.ts`, and
materializes its registry in the project cache. Existing custom resolvers are
preserved for unrelated imports.

Restart Metro after changing the schema or any device-function source because
the registry is built when configuration loads.

## Create the client

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/expo";

const client = new ConvexEmbeddedClient({
  url: process.env.EXPO_PUBLIC_CONVEX_URL,
});
await client.open();
```

The native remote uses the same Rust protocol driver as Node. Omit `url` for a
local-only runtime.

## Native project requirements

Use an Expo development build or prebuild so iOS pods and Android native
libraries are included. Rebuild the native application after changing the
installed Embedded package version or native configuration.
