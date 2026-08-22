---
title: Error and settlement codes
description: Handle stable thrown errors separately from durable replicated-mutation outcomes.
---

# Error and settlement codes

Thrown application-visible Embedded failures use `EmbeddedError`. Durable
terminal mutation outcomes are reported as settlement data instead of thrown
errors.

```ts
import { EMBEDDED_ERROR_CODES, isEmbeddedError } from "@estifanos-sh/convex-embedded/browser";

try {
  await client.query(api.documents.list, {});
} catch (error) {
  if (isEmbeddedError(error, "EMBEDDED_NOT_OPEN")) {
    await client.open();
  }
}
```

## Stable thrown codes

| Code                          | Meaning                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `EMBEDDED_NOT_OPEN`           | A runtime method was called before `open()`                     |
| `EMBEDDED_OPEN_MISMATCH`      | Concurrent or repeated open used a different setup action       |
| `EMBEDDED_CLOSED`             | Work was requested after shutdown began                         |
| `EMBEDDED_OFFLINE`            | Hosted-only work has no reachable deployment                    |
| `EMBEDDED_DEPENDENCY_FAILED`  | A required insert, upload, or schedule producer cannot apply    |
| `EMBEDDED_CLIENT_RETIRED`     | The client incarnation was retired and needs fresh pull state   |
| `EMBEDDED_PROTOCOL_MISMATCH`  | Client and deployment wire contracts differ                     |
| `EMBEDDED_STORAGE`            | Local durable storage could not open or commit                  |
| `EMBEDDED_PRE_BASELINE_STORE` | The store predates the supported public migration baseline      |
| `EMBEDDED_UNSUPPORTED`        | Local-capable code used a primitive the server cannot reproduce |

Messages include useful identifiers but do not expose auth tokens, opaque
payload bytes, or private component state.

## Settlement codes

| Code                  | Outcome    | Meaning                                             |
| --------------------- | ---------- | --------------------------------------------------- |
| `EMBEDDED_CONFLICT`   | `conflict` | A plain point, range, or target witness moved       |
| `EMBEDDED_REJECTED`   | `rejected` | Hosted application code rejected the local mutation |
| `EMBEDDED_DIVERGENCE` | `rejected` | Normalized local and hosted execution differed      |

Listen with `subscribeToMutationSettlements()`. A successful terminal outcome
uses `outcome: "applied"` and no error code.
