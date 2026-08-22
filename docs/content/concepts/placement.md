---
title: Placement model
description: Understand exactly where each table, field, index, and function can execute or persist.
---

Embedded uses the same three placements for schema and function definitions.

| Schema declaration                 | Hosted server | Replication wire | Device           |
| ---------------------------------- | ------------- | ---------------- | ---------------- |
| `replicatedTable({...})`           | Yes           | Yes              | Yes              |
| Plain `defineTable({...})`         | Yes           | No               | No               |
| `localTable({...})`                | No            | No               | Yes              |
| Normal field in a replicated table | Yes           | Yes              | Yes              |
| `e.remote(validator)`              | Yes           | No               | No               |
| `e.local(validator)`               | No            | No               | Optional overlay |

| Function builder                                          | Execution and visibility                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `replicated.query`                                        | Local when eligible, with a hosted retained answer and pull subscription |
| `replicated.mutation`                                     | Optimistic local commit followed by authoritative hosted replay          |
| `remote.query`, `remote.mutation`, `remote.action`        | Hosted Convex only                                                       |
| Generated `local.query`, `local.mutation`, `local.action` | Device only                                                              |

## Local overlays

An `e.local` field is stored separately from its replicated document. Pull,
membership exit, and hosted deletion do not erase the overlay. If the row
returns, its device overlay is visible again.

A local mutation clears an overlay by patching the field to `undefined`. Local
functions can patch overlays but cannot insert, replace, or delete the
replicated row. Device reads merge the overlay into the visible row, so return
validators must include local fields or return only the fields the function
needs.

## Local tables

A `localTable` owns complete device-only documents. They are durable local
state, change only through local functions, and never push, pull, or deploy to
Convex.

## Security boundary

Placement is not an authorization shortcut. Replicated and remote application
functions still perform normal Convex authentication and authorization. Local
data is isolated to the device identity selected by the client's auth state.
