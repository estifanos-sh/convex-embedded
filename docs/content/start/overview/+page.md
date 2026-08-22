---
title: Overview
description: Build local-first Convex applications without replacing the Convex programming model.
---

# Overview

Convex Embedded is a local-first runtime for Convex. It runs selected Convex
queries and mutations against a durable SQLite projection on the device, then
replicates authorized changes through an installed Convex component.

Your application still owns ordinary Convex code:

- schemas and validators
- queries, mutations, and actions
- authentication and authorization
- generated function references
- hosted deployment and file storage

Embedded adds explicit data placement, device-only functions, optimistic local
execution, native and WASM storage, and a private replication protocol. Loro
CRDT computation stays in the local Rust or WASM runtime; hosted Convex stores
opaque CRDT payloads and materialized values.

## One application, three placements

Embedded makes placement explicit instead of treating an entire database as
offline or online:

- **Replicated** tables and functions exist on Convex and on authorized devices.
- **Remote** tables, fields, indexes, and functions remain hosted-only.
- **Local** tables, field overlays, and functions remain on one device.

This lets a document replicate while a server-only moderation field stays out
of the wire format and a device-only UI preference stays out of Convex.

## Supported runtimes

The public clients share one lifecycle and function API:

- browsers through a worker-backed WASM runtime and SQLite in OPFS
- Expo development and release builds through the native mobile store
- Node.js through the packaged Rust/N-API store

Vite is the first-class browser integration. Metro is the native Expo
integration. Unplugin adapters are available for Rollup, Rolldown, Webpack,
Rspack, and esbuild, with additional application-owned configuration.

## How to start

1. [Install the package](/start/installation).
2. [Configure the Convex component and protocol](/start/convex).
3. [Declare an Embedded schema](/start/schema).
4. Configure a [browser](/platform/browser), [Expo](/platform/expo), or
   [Node](/platform/node) runtime.
5. [Create and open a client](/start/client).
