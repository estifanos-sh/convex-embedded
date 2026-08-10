# @estifanos-sh/convex-embedded · browser · vite demo

A document editor demonstrating `@estifanos-sh/convex-embedded/browser`: local-first Convex execution in the browser with BlockNote editing, OPFS persistence, optional remote sync, and a Notion-style revision history panel.

## Run

```sh
# from repo root
pnpm build:browser:vite
pnpm preview:browser:vite

# dev server is normally started by the workspace owner
pnpm dev:browser:vite
```

## Try it

1. Edit the document body.
2. Open the same URL in another tab and watch the local document settle there too.
3. Click **Snapshot** to save a revision.
4. Select a revision in the history panel and restore it.
5. Hard-reload the page; the document and revisions are still available from browser storage.

## What's in here

- `src/app.tsx` — BlockNote editor, local draft writes, revision history, and restore controls.
- `src/lib/client.ts` — `ConvexEmbeddedClient` setup and optional remote configuration.
- `vite.config.ts` — React, Tailwind, the shared deployment/generated paths, and embedded devtools.

The schema and functions live at the workspace root in `convex/`. The Vite plugin rewrites the
`convex/embedded.generated.ts` contract, inlines the device schema into its virtual
registry, bundles device functions into the browser worker, and emits a stable identity hash so
compatible tabs attach to the same local runtime. The `_generated` directory keeps the contract out
of deployment discovery, and `convex dev` never replaces it.
