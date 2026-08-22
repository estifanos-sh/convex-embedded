---
title: Production readiness
description: Validate hosting, storage, replication, authentication, migrations, and observability before launch.
---

Production readiness is more than a successful page render. Verify the platform
runtime, storage mode, protocol, and application behavior together.

## Browser headers

Every production HTML response for an Embedded browser application must include:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite adds these headers only to development and preview servers. Your deployed
host must configure them independently.

Serve worker and WASM assets from the same origin when possible. Cross-origin
resources need compatible CORS or `Cross-Origin-Resource-Policy` behavior.

## Deployment smoke test

Verify the production artifact, not only the development server:

- `crossOriginIsolated === true`
- the Embedded worker starts
- SQLite WASM and pthread worker requests succeed
- `client.open()` reaches local `ready`
- connection state reports the expected durable or temporary persistence
- one local query completes
- one authenticated replicated mutation reaches a terminal settlement
- reconnecting drains pending durable work

Inspect worker-console errors and network requests. The page can remain
responsive while its local runtime has failed.

## Authentication and data isolation

- Set auth with the application's normal Convex token fetcher.
- Confirm sign-out switches to the unauthenticated local partition.
- Authorize every replicated and remote function normally.
- Keep revision access behind app-owned authorization wrappers.
- Confirm server-only fields never enter the device projection.

## Schema rollout

Use widen-migrate-narrow for hosted data. Keep device setup actions idempotent
and compatible with skipped releases. Test opening existing durable fixtures,
not only empty stores.

## Browser storage expectations

Decide whether temporary persistence is acceptable. Safari or Firefox private
browsing can deny OPFS. A remote deployment can repopulate authoritative data
but cannot recover an offline mutation erased with temporary storage.

## Observability

Observe connection state and terminal mutation settlements. Do not parse private
replication logs or expose auth tokens, raw payloads, or component metadata in
application diagnostics.
