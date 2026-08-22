---
title: Architecture
description: Understand ownership boundaries across application code, hosted Convex, the component, and the device runtime.
---

Convex Embedded extends the Convex programming model instead of introducing a
second application backend.

## Application-owned layer

The application owns schema and placement declarations, hosted and local
functions, authorization, revision wrappers, migration code, and client
lifecycle.

Generated Convex references remain the normal application API. Device-only
references are generated from the same schema and imported as typed values.

## Hosted layer

Hosted Convex remains authoritative for replicated and remote data. The
installed component owns private replication metadata, client state, mutation
settlement, retained revisions, and protocol endpoints.

Application code does not query private component records directly.

## Device layer

The Rust, native, or WASM runtime owns:

- SQLite storage and indexes
- the authorized device projection
- local query and mutation execution
- optimistic replicated mutations
- scheduling state for local-capable work
- Loro CRDT computation
- push, pull, and settlement persistence

Browser JavaScript communicates with this runtime through a module worker.
Expo and Node use native storage and the Rust protocol driver.

## Build contract

The bundler analyzes the live schema and function graph. It generates a small
checked-in contract and a virtual runtime registry containing:

- function placement and visibility
- schema and manifest identities
- a complete device module-graph hash
- schema-bound local function builders
- the literal runtime storage schema

This contract prevents stale placement data and setup references from silently
entering a build.

## Compatibility

Wire, storage-binding, coordinator, and durable-store compatibility have
separate computed contracts. Incompatible combinations fail closed and preserve
durable data rather than attempting an unsafe repair.
