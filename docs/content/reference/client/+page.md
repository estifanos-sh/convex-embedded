---
title: Client API
description: Reference the shared Embedded client lifecycle, function calls, watches, auth, state, settlements, and teardown.
---

# Client API

Browser, Expo, and Node clients share the following methods. Platform-specific
constructor options are listed in [Configuration](/reference/config).

## `open(setup?)`

```ts
await client.open();
await client.open(setup);
```

Opens storage and starts the runtime. The optional value must be a stamped
internal local action with `{}` arguments and a `null` result.

Construction is inert. Operations that require the runtime fail with
`EMBEDDED_NOT_OPEN` until open succeeds. An open failure is terminal for that
client instance.

## `query(reference, args?)`

Executes a one-shot hosted, replicated, or local query and returns its validated
result.

```ts
const documents = await client.query(api.documents.list, {});
```

A one-shot query does not populate a watcher cache.

## `mutation(reference, args?)`

Executes a hosted, replicated, or local mutation. Replicated mutations commit
optimistically and return their local result before hosted settlement.

```ts
const id = await client.mutation(api.documents.create, { body: "Hello" });
```

## `action(reference, args?)`

Executes an action through its eligible local or hosted surface. Local setup
actions are not invoked through this public method; pass them to `open()`.

## `watchQuery(reference, args?)`

Returns a lazy `Watch<T>` handle. Work starts when the first callback is
registered.

```ts
const watch = client.watchQuery(api.documents.list, {});
const stop = watch.onUpdate(() => {
  const value = watch.localQueryResult();
  const logs = watch.localQueryLogs();
});
```

`onUpdate()` returns an unsubscribe function. `localQueryResult()` is undefined
before the first result and throws the current query error when present.

## `setAuth(fetchToken, onChange?)`

Configures the normal Convex token fetcher for future hosted exchanges and
device identity selection. It may be called before `open()`.

## `clearAuth()`

Clears the token fetcher and immediately selects the unauthenticated local
identity partition. It may be called before `open()`.

## `connectionState()`

Returns a frozen snapshot with independent `local` and `replication` branches.
See [Client lifecycle](/concepts/lifecycle) for every state.

## `subscribeToConnectionState(callback)`

Observes future structural state changes. The live-only callback is coalesced
to the newest state in one microtask and returns an unsubscribe function.

## `subscribeToMutationSettlements(callback)`

Observes future durable terminal settlements:

```ts
const stop = client.subscribeToMutationSettlements((settlement) => {
  if (settlement.outcome === "conflict") {
    console.log(settlement.mutationId, settlement.retainedRevisions);
  }
});
```

The channel does not replay older settlements, internal rebases, or raw server
rejection details.

## `close()`

Stops watches and replication and releases the platform runtime. Close is
idempotent and suppresses cleanup failures after shutdown has begun.
