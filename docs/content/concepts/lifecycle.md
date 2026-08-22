---
title: Client lifecycle and authentication
description: Open, authenticate, observe, recover, and close an Embedded client safely.
---

Every platform client follows one explicit lifecycle.

## Construction and open

Constructors record configuration without acquiring storage or starting work.
`await client.open()` acquires the platform runtime, opens or upgrades the
store, imports local modules, starts scheduling, and begins replication when a
deployment URL is configured.

Operations that require the runtime fail with `EMBEDDED_NOT_OPEN` before open.
Concurrent calls with the same setup identity share one open operation; a
different identity fails with `EMBEDDED_OPEN_MISMATCH`.

An open failure is terminal for that client instance. Close it, construct a new
client, and open again with the same setup action to resume a durable candidate.

## Authentication

Use the normal Convex token fetcher:

```ts
client.setAuth(async ({ forceRefreshToken }) => {
  return await getToken({ refresh: forceRefreshToken });
});
```

`setAuth()` and `clearAuth()` may be called before open without starting the
runtime. Authentication selects the device identity partition and configures
future hosted exchanges. `clearAuth()` immediately switches local execution to
the unauthenticated partition.

## Connection state

`connectionState()` returns independent local and replication branches:

- local: `idle`, `starting`, `ready`, `failed`, or `closed`
- replication: `disabled`, `starting`, `offline`, `online`, `error`, or `closed`

A ready local branch reports `durable` or `temporary` persistence. An online
replication branch reports whether durable work is `pending` or `idle`.

```ts
const stop = client.subscribeToConnectionState((state) => {
  console.log(state.local, state.replication);
});
```

The subscription is live-only and coalesces a burst of changes into the latest
snapshot.

## Close

`close()` is idempotent, releases the platform runtime, and prevents new work.
Calling configuration or function methods after shutdown begins fails with
`EMBEDDED_CLOSED`.
