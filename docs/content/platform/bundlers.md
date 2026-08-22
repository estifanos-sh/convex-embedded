---
title: Other bundlers and SSR
description: Use Unplugin adapters and supply the worker, asset, browser flag, and hosting pieces outside Vite.
---

The Unplugin entrypoint provides registry adapters for Rollup, Rolldown,
Webpack, Rspack, and esbuild:

```ts
import { convexEmbeddedUnplugin } from "@estifanos-sh/convex-embedded/unplugin";
import schema from "./convex/schema";

export default {
  plugins: [convexEmbeddedUnplugin.rollup({ schema })],
};
```

Select the adapter for the build system:

```ts
convexEmbeddedUnplugin.rolldown({ schema });
convexEmbeddedUnplugin.webpack({ schema });
convexEmbeddedUnplugin.rspack({ schema });
convexEmbeddedUnplugin.esbuild({ schema });
```

These adapters discover functions and provide the virtual registry. They do not
reproduce Vite's complete runtime integration. A non-Vite application must:

1. Apply the adapter to the worker build when workers have a separate pipeline.
2. Process module workers and package-relative `new URL(..., import.meta.url)` assets.
3. Emit the browser runtime, SQLite WASM, and pthread worker without breaking URLs.
4. Set `window.__convexAllowFunctionsInBrowser = true` before application imports.
5. Configure cross-origin isolation in production.
6. Smoke-test a production build by opening the client and running a local query.

| Build system       | Integration level                                                    |
| ------------------ | -------------------------------------------------------------------- |
| Vite / Vite+       | Full adapter; end-to-end tested                                      |
| Rollup / Rolldown  | Registry adapter; worker, assets, flag, and headers remain app-owned |
| Webpack / Rspack   | Registry adapter; worker, assets, flag, and headers remain app-owned |
| esbuild            | Registry adapter; worker, assets, flag, and headers remain app-owned |
| Metro              | Native Expo adapter                                                  |
| Turbopack / Parcel | No adapter currently provided                                        |

## Server rendering

Import `@estifanos-sh/convex-embedded/browser` only from client-side code. It
creates a Web Worker and reads browser storage, so it cannot execute during SSR.

In frameworks with separate server and client graphs, construct the client
behind the framework's client-only boundary or a guarded dynamic import. The
schema and server entrypoints remain safe in their intended build environments.
