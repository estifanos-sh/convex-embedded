---
title: Replication
description: Follow a replicated query or mutation from local execution to hosted Convex authority.
---

# Replication

Embedded keeps hosted Convex authoritative while allowing selected functions to
execute against a device projection.

## Queries

A watched replicated query establishes a hosted subscription and maintains the
authorized rows needed for its local result. The device executes the same
application query against its projection and updates subscribers as local or
pulled changes affect the result.

A local query cannot create a hosted subscription. It sees only replicated rows
that another subscription already delivered plus local tables and overlays.

## Mutations

A replicated mutation commits optimistically on the device. Embedded records
the reads and writes needed for authoritative replay, assigns a mutation id,
and pushes the mutation through the installed component.

Hosted replay runs the application function again against current Convex state:

- **Applied** means authoritative replay committed.
- **Conflict** means a point, range, or target witness moved; displaced values
  may be retained as revisions.
- **Rejected** means authoritative application code rejected the optimistic
  mutation.
- **Divergence** means normalized local and hosted execution differed, so hosted
  writes rolled back.

Internal rebases are retry mechanics and are not exposed as terminal client
settlements.

## Offline operation

Local-capable queries and mutations continue against the device store while
replication is offline. Hosted-only work fails with `EMBEDDED_OFFLINE` when no
deployment is reachable.

The replication connection state reports whether durable work is pending after
the network returns. Application code can observe terminal mutation settlements
without parsing private protocol errors.

## Protocol compatibility

Client and deployment builds carry computed wire contracts. A mismatch fails
closed with `EMBEDDED_PROTOCOL_MISMATCH`; the client does not attempt to guess
across incompatible protocol versions.
