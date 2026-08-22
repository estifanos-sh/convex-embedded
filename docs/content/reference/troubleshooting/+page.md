---
title: Troubleshooting
description: Diagnose generated-registry, worker, WASM, native artifact, isolation, storage, and protocol failures.
---

# Troubleshooting

## Browser builds

| Symptom                                     | Likely cause                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Cannot resolve `virtual:convex-embedded`    | The Vite or Unplugin adapter is missing from that build graph               |
| Page loads but `open()` never becomes ready | The worker lacks the adapter or required assets                             |
| Worker or WASM request returns 404          | The bundler rewrote or omitted package-relative URLs                        |
| `crossOriginIsolated` is false              | Production HTML lacks COOP/COEP or a resource violates them                 |
| Function unexpectedly runs hosted-only      | It uses `"use node"`, is a system file, or is excluded from local execution |
| Persistence is temporary                    | OPFS was denied and the in-memory backend is active                         |

Inspect the worker console and network panel as well as the page console.

## Generated contract

If schema or function changes are not reflected locally, rerun the configured
Vite, Metro, or Unplugin build and inspect `convex/embedded.generated.ts`. Never
patch that file manually. Restart Metro after any device graph change.

## Node artifacts

If Node cannot load storage, confirm the operating system and architecture are
supported. Set `CONVEX_EMBEDDED_NATIVE` to an absolute compatible `.node` file
for source-built artifacts. Use `CONVEX_EMBEDDED_NATIVE_TRACE=1` for resolution
diagnostics.

## Lifecycle failures

- `EMBEDDED_NOT_OPEN`: await `client.open()` first.
- `EMBEDDED_OPEN_MISMATCH`: reuse exactly the same setup action or construct a
  separate client.
- failed open: close the instance, construct another, and retry with the same
  setup identity.
- `EMBEDDED_PROTOCOL_MISMATCH`: deploy client and component builds produced from
  compatible package versions.
- `EMBEDDED_PRE_BASELINE_STORE`: preserve or export anything needed, then clear
  development-only storage or choose a new storage id.

## Replication failures

Observe `connectionState()` for offline or error details and
`subscribeToMutationSettlements()` for terminal mutation outcomes. Do not treat
an internal rebase as an application failure; it is intentionally not exposed
as a terminal settlement.
