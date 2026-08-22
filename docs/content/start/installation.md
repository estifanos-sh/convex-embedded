---
title: Installation
description: Install Convex Embedded and verify the runtime requirements for your target platform.
---

Install Convex Embedded beside Convex in an existing application:

```bash
npm install @estifanos-sh/convex-embedded convex
```

The package is published independently as
`@estifanos-sh/convex-embedded`. Its import paths, generated modules, and
bundler configuration all use that package identity.

## Requirements

| Target                  | Requirement                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| All applications        | `convex` 1.43.0 or newer                                                          |
| Node and package tools  | Node.js 20.19 or newer                                                            |
| Browser                 | Dedicated workers, WebAssembly, and cross-origin isolation                        |
| Durable browser storage | OPFS access; Embedded falls back to temporary memory when unavailable             |
| Expo                    | Expo 54+, React Native 0.81+, Expo Crypto 15+, and a development or release build |

Expo Go cannot load the required native module.

Prebuilt Node artifacts support Apple Silicon macOS, Linux x64 and ARM64, and
Windows x64. Intel macOS requires an explicitly supplied source-built artifact.

## Import entrypoints

Convex Embedded intentionally has no catch-all package-root entrypoint. Import
from the surface that owns the work:

```ts
import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/browser";
import { defineEmbeddedSchema } from "@estifanos-sh/convex-embedded/schema";
import { e } from "@estifanos-sh/convex-embedded/values";
import { defineEmbedded } from "@estifanos-sh/convex-embedded/server";
```

Platform clients live at `/browser`, `/expo`, and `/node`. Build adapters live
at `/vite`, `/metro`, and `/unplugin`.

## Test releases

Pull requests labeled `package preview` publish an ephemeral package assembled
from JavaScript, WASM, supported Node targets, Apple XCFramework slices, and
Android ABIs. That artifact is a GitHub release asset, not an npm publication.

Install a published prerelease or release by exact version:

```bash
npm install @estifanos-sh/convex-embedded@<version> convex
```
