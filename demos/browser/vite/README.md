# @convex-dev/embedded · browser · vite demo

A multi-tab todos app demonstrating `@convex-dev/embedded/browser` — the local-first Convex execution engine running entirely in the browser via SharedWorker + OPFS.

## Run

```sh
# from repo root (canonical)
pnpm dev:browser:vite
pnpm build:browser:vite     # production build
pnpm preview:browser:vite   # preview the production build

# or from this directory
vp dev
```

## Try it

1. Open the printed URL in **two tabs side by side**.
2. Add a todo in tab A — it appears in tab B within milliseconds.
3. Toggle / delete from either tab; the other follows.
4. Hard-reload either tab — the list persists (OPFS).
5. Open DevTools → Application → Shared Workers to see the per-origin runtime.
6. Open the Network tab — there are **no** outbound requests. Everything is local.

## What's in here

- `src/lib/client.ts` — the `ConvexEmbeddedClient` singleton (zero-arg).
- `src/lib/watch.ts` — ~30-line helper over `client.watchQuery()` that drives a render callback.
- `src/ui.ts` — dashboard chrome and DOM event wiring.
- `src/todos.ts` — the todos panel; subscribes once, renders into a DOM list on each update.
- `vite.config.ts` — `tailwindcss()` + `convexEmbedded({ convexDir })`. The latter handles COOP/COEP for you.

## Shared Convex folder

The schema and functions live at the **workspace root** in `convex/` so every demo (this one, the future `demos/browser/nextjs/`, etc.) consumes the same backend. `vite.config.ts` points `convexEmbedded()` at `../../../convex`, and the TypeScript `~convex/*` path alias resolves there too.

The Vite plugin bundles function modules into a virtual registry and emits a stable identity hash so the SharedWorker only attaches to clients with the same schema.
