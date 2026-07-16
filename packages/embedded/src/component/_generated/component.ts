/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  crdt: {
    checkpoint: {
      write: FunctionReference<
        "mutation",
        "internal",
        { field: string; rowId: string; table: string },
        { checkpointId: string; state: "requested" | "ready" },
        Name
      >;
    };
    clear: FunctionReference<
      "mutation",
      "internal",
      { expectedEpoch: number; fieldId: string; numItems: number },
      { deleted: number; isDone: boolean },
      Name
    >;
    field: {
      get: FunctionReference<
        "query",
        "internal",
        { field: string; rowId: string; table: string },
        {
          checkpoint?: {
            bytes?: number;
            createdAt: number;
            id: string;
            state: "requested" | "ready";
            throughSeq: number;
          };
          detached: boolean;
          epoch: number;
          field: string;
          headSeq: number;
          id: string;
          kind: "text" | "count" | "set";
          payloadBytes: number;
          payloads: number;
          projectionHash: string;
          rowId: string;
          table: string;
        } | null,
        Name
      >;
      read: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          table?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            checkpoint?: {
              bytes?: number;
              createdAt: number;
              id: string;
              state: "requested" | "ready";
              throughSeq: number;
            };
            detached: boolean;
            epoch: number;
            field: string;
            headSeq: number;
            id: string;
            kind: "text" | "count" | "set";
            payloadBytes: number;
            payloads: number;
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
        },
        Name
      >;
    };
    payload: {
      delete: FunctionReference<
        "mutation",
        "internal",
        { checkpointId: string; numItems: number },
        { deleted: number; isDone: boolean },
        Name
      >;
    };
  };
  file: {
    delete: FunctionReference<
      "mutation",
      "internal",
      { expectedVersion: number; storageId: string },
      | { deletion: "deleted" }
      | { deletion: "missing" }
      | { deletion: "referenced" }
      | { deletion: "changed" },
      Name
    >;
    read: FunctionReference<
      "query",
      "internal",
      {
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        state?: "referenced" | "unreferenced";
        updatedBefore?: number;
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          references: number;
          storageId: string;
          updatedAt: number;
          version: number;
        }>;
      },
      Name
    >;
  };
  mutation: {
    delete: FunctionReference<
      "mutation",
      "internal",
      {
        clientId?: string;
        identity?: { tokenIdentifier: string } | { identityKey: string };
        numItems: number;
        settledBefore: number;
      },
      { deleted: number; isDone: boolean },
      Name
    >;
    read: FunctionReference<
      "query",
      "internal",
      {
        acknowledged?: boolean;
        identity?: { tokenIdentifier: string } | { identityKey: string };
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        settledBefore?: number;
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          acknowledged: boolean;
          clientId: string;
          identity?: string;
          mutationId: string;
          outcome: "applied" | "conflict" | "rejected";
          settledAt: number;
        }>;
      },
      Name
    >;
  };
  protocol: {
    acknowledge: FunctionReference<
      "mutation",
      "internal",
      { clientId: string; identity?: string; mutationId: string },
      null,
      Name
    >;
    blobWrite: FunctionReference<
      "mutation",
      "internal",
      {
        bytes: number;
        chunk: ArrayBuffer;
        chunkHash: string;
        chunks: number;
        hash: string;
        ordinal: number;
      },
      { blobId: string; ready: boolean },
      Name
    >;
    checkpointRead: FunctionReference<
      "query",
      "internal",
      {
        checkpointId: string;
        cursor: string | null;
        epoch: number;
        field: string;
        headSeq: number;
        rowId: string;
        table: string;
      },
      | { kind: "stale" }
      | {
          checkpoint: {
            bytes: number;
            hash: string;
            id: string;
            seq: number;
          };
          chunks: Array<{
            bytes: ArrayBuffer;
            hash: string;
            ordinal: number;
          }>;
          continueCursor: string | null;
          headSeq: number;
          isDone: boolean;
          payloads: Array<{ bytes: ArrayBuffer; hash: string; seq: number }>;
        },
      Name
    >;
    checkpointWrite: FunctionReference<
      "mutation",
      "internal",
      {
        checkpointId: string;
        content:
          | { bytes: ArrayBuffer; hash: string; kind: "inline" }
          | { blobId: string; bytes: number; hash: string; kind: "staged" };
        projectionHash: string;
        responseToken: string;
        throughSeq: number;
      },
      null,
      Name
    >;
    commit: FunctionReference<
      "mutation",
      "internal",
      {
        request:
          | {
              acknowledgeMutationId?: string;
              changes: Array<
                | {
                    contentHash: string;
                    fields: any;
                    op: "put";
                    rowId: string;
                    table: string;
                  }
                | {
                    contentHash: string;
                    op: "del";
                    rowId: string;
                    table: string;
                  }
              >;
              clientId: string;
              crdt: Array<{
                baseSeq: number;
                checkpoint?: {
                  content:
                    | { bytes: ArrayBuffer; hash: string; kind: "inline" }
                    | {
                        blobId: string;
                        bytes: number;
                        hash: string;
                        kind: "staged";
                      };
                  throughSeq: number;
                };
                field: string;
                kind: "text" | "count" | "set";
                payload: ArrayBuffer;
                projection: any;
                projectionHash: string;
                rowId: string;
                table: string;
              }>;
              files: Array<{ delta: number; storageId: string }>;
              fingerprint: string;
              identity?: string;
              kind: "apply";
              runtime: {
                moduleGraphHash: string;
                protocolVersion: number;
                schemaHash: string;
              };
              settlement: {
                inserts: Array<{
                  id: string;
                  ordinal: number;
                  table: string;
                }>;
                mutationId: string;
                outcome: "applied";
                result: any;
                revisions: Array<{
                  revId: string;
                  rowId: string;
                  table: string;
                }>;
                schedules: Array<{ id: string; ordinal: number }>;
                uploads: Array<{ ordinal: number; url: string }>;
              };
              verification:
                | {
                    kind: "ready";
                    witnesses: Array<{
                      epoch: number;
                      field: string;
                      genesis: boolean;
                      headSeq: number;
                      projectionHash: string;
                      rowId: string;
                      table: string;
                    }>;
                  }
                | {
                    kind: "conflict";
                    targets: Array<{ rowId: string; table: string }>;
                  }
                | { kind: "unsupported" };
            }
          | {
              acknowledgeMutationId?: string;
              changes: Array<
                | {
                    contentHash: string;
                    fields: any;
                    op: "put";
                    rowId: string;
                    table: string;
                  }
                | {
                    contentHash: string;
                    op: "del";
                    rowId: string;
                    table: string;
                  }
              >;
              clientId: string;
              fingerprint: string;
              identity?: string;
              kind: "failure";
              revisions: Array<
                | {
                    content: "value";
                    rowId: string;
                    table: string;
                    value: any;
                  }
                | { content: "deleted"; rowId: string; table: string }
              >;
              runtime: {
                moduleGraphHash: string;
                protocolVersion: number;
                schemaHash: string;
              };
              settlement:
                | {
                    error: any;
                    inserts: Array<{
                      id: string;
                      ordinal: number;
                      table: string;
                    }>;
                    mutationId: string;
                    outcome: "conflict";
                    revisions: Array<{
                      revId: string;
                      rowId: string;
                      table: string;
                    }>;
                    schedules: Array<{ id: string; ordinal: number }>;
                    uploads: Array<{ ordinal: number; url: string }>;
                  }
                | {
                    error: any;
                    inserts: Array<{
                      id: string;
                      ordinal: number;
                      table: string;
                    }>;
                    mutationId: string;
                    outcome: "rejected";
                    revisions: Array<{
                      revId: string;
                      rowId: string;
                      table: string;
                    }>;
                    schedules: Array<{ id: string; ordinal: number }>;
                    uploads: Array<{ ordinal: number; url: string }>;
                  }
                | {
                    error: any;
                    inserts: Array<{
                      id: string;
                      ordinal: number;
                      table: string;
                    }>;
                    mutationId: string;
                    outcome: "rebase";
                    revisions: Array<{
                      revId: string;
                      rowId: string;
                      table: string;
                    }>;
                    schedules: Array<{ id: string; ordinal: number }>;
                    uploads: Array<{ ordinal: number; url: string }>;
                  };
            };
      },
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "applied";
          result: any;
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "conflict";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "rejected";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "rebase";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        },
      Name
    >;
    installation: FunctionReference<"query", "internal", {}, string, Name>;
    pull: FunctionReference<
      "query",
      "internal",
      {
        rows: Array<{
          crdtFields: Array<string>;
          fields: any;
          rowId: string;
          table: string;
        }>;
        runtime: {
          moduleGraphHash: string;
          protocolVersion: number;
          schemaHash: string;
        };
      },
      {
        changes: Array<
          | {
              fields: any;
              op: "put";
              plainHash: string;
              rowId: string;
              table: string;
            }
          | { op: "del"; plainHash: string; rowId: string; table: string }
        >;
        crdt: Array<{
          checkpoint: {
            bytes: number;
            hash: string;
            id: string;
            seq: number;
          };
          checkpointRequest?: {
            checkpointId: string;
            projectionHash: string;
            responseToken: string;
            throughSeq: number;
          };
          epoch: number;
          field: string;
          headSeq: number;
          kind: "text" | "count" | "set";
          payload?: { bytes: ArrayBuffer; hash: string; seq: number };
          projectionHash: string;
          rowId: string;
          table: string;
        }>;
        members: Array<{ rowId: string; table: string }>;
      },
      Name
    >;
    replayConsume: FunctionReference<
      "mutation",
      "internal",
      { functionName: string; requestId: string },
      {
        acknowledgeMutationId?: string;
        clientId: string;
        crdt: Array<{
          baseSeq: number;
          checkpoint?: {
            content:
              | { bytes: ArrayBuffer; hash: string; kind: "inline" }
              | {
                  blobId: string;
                  bytes: number;
                  hash: string;
                  kind: "staged";
                };
            throughSeq: number;
          };
          field: string;
          kind: "text" | "count" | "set";
          payload: ArrayBuffer;
          projection: any;
          projectionHash: string;
          rowId: string;
          table: string;
        }>;
        fingerprint: string;
        inserts: Array<{
          mutationId: string;
          ordinal: number;
          table: string;
        }>;
        kind: "push";
        mutationId: string;
        mutationTime: number;
        randomSeed: string;
        reads: Array<
          | {
              crdt: Array<{
                epoch: number;
                field: string;
                headSeq: number;
                projectionHash: string;
              }>;
              kind: "point";
              plainHash: string;
              rowId: string;
              table: string;
            }
          | {
              equality: Array<{ field: string; value: any }>;
              index?: string;
              kind: "range";
              limit?: number;
              lower?: { field: string; inclusive: boolean; value: any };
              membersHash: string;
              order: "asc" | "desc";
              table: string;
              upper?: { field: string; inclusive: boolean; value: any };
            }
        >;
        resultHash: string;
        revisionCheckpoints: Array<{
          operation: "create" | "retain";
          ordinal: number;
          snapshots: Array<{
            bytes: ArrayBuffer;
            field: string;
            hash: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
          }>;
          table: string;
        }>;
        runtime: {
          moduleGraphHash: string;
          protocolVersion: number;
          schemaHash: string;
        };
        schedules: Array<{ mutationId: string; ordinal: number }>;
        uploads: Array<{ mutationId: string; ordinal: number }>;
      } | null,
      Name
    >;
    replayWrite: FunctionReference<
      "mutation",
      "internal",
      {
        acknowledgeMutationId?: string;
        clientId: string;
        crdt: Array<{
          baseSeq: number;
          checkpoint?: {
            content:
              | { bytes: ArrayBuffer; hash: string; kind: "inline" }
              | {
                  blobId: string;
                  bytes: number;
                  hash: string;
                  kind: "staged";
                };
            throughSeq: number;
          };
          field: string;
          kind: "text" | "count" | "set";
          payload: ArrayBuffer;
          projection: any;
          projectionHash: string;
          rowId: string;
          table: string;
        }>;
        expiresAt: number;
        fingerprint: string;
        functionName: string;
        identity?: string;
        inserts: Array<{
          mutationId: string;
          ordinal: number;
          table: string;
        }>;
        kind: "push";
        mutationId: string;
        mutationTime: number;
        randomSeed: string;
        reads: Array<
          | {
              crdt: Array<{
                epoch: number;
                field: string;
                headSeq: number;
                projectionHash: string;
              }>;
              kind: "point";
              plainHash: string;
              rowId: string;
              table: string;
            }
          | {
              equality: Array<{ field: string; value: any }>;
              index?: string;
              kind: "range";
              limit?: number;
              lower?: { field: string; inclusive: boolean; value: any };
              membersHash: string;
              order: "asc" | "desc";
              table: string;
              upper?: { field: string; inclusive: boolean; value: any };
            }
        >;
        requestId: string;
        resultHash: string;
        revisionCheckpoints: Array<{
          operation: "create" | "retain";
          ordinal: number;
          snapshots: Array<{
            bytes: ArrayBuffer;
            field: string;
            hash: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
          }>;
          table: string;
        }>;
        runtime: {
          moduleGraphHash: string;
          protocolVersion: number;
          schemaHash: string;
        };
        schedules: Array<{ mutationId: string; ordinal: number }>;
        tokenHash: string;
        uploads: Array<{ mutationId: string; ordinal: number }>;
      },
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "applied";
          result: any;
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "conflict";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "rejected";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | {
          authoritative: Array<
            | {
                fields: any;
                op: "put";
                plainHash: string;
                rowId: string;
                table: string;
              }
            | { op: "del"; plainHash: string; rowId: string; table: string }
          >;
          crdt: Array<{
            field: string;
            headSeq: number;
            kind: "text" | "count" | "set";
            projectionHash: string;
            rowId: string;
            table: string;
          }>;
          error: any;
          inserts: Array<{ id: string; ordinal: number; table: string }>;
          mutationId: string;
          outcome: "rebase";
          revisions: Array<{ revId: string; rowId: string; table: string }>;
          schedules: Array<{ id: string; ordinal: number }>;
          uploads: Array<{ ordinal: number; url: string }>;
        }
      | null,
      Name
    >;
    settlementRead: FunctionReference<
      "query",
      "internal",
      { clientId: string; mutationId: string },
      {
        fingerprint: string;
        settlement:
          | {
              authoritative: Array<
                | {
                    fields: any;
                    op: "put";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
                | {
                    op: "del";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
              >;
              crdt: Array<{
                field: string;
                headSeq: number;
                kind: "text" | "count" | "set";
                projectionHash: string;
                rowId: string;
                table: string;
              }>;
              inserts: Array<{ id: string; ordinal: number; table: string }>;
              mutationId: string;
              outcome: "applied";
              result: any;
              revisions: Array<{
                revId: string;
                rowId: string;
                table: string;
              }>;
              schedules: Array<{ id: string; ordinal: number }>;
              uploads: Array<{ ordinal: number; url: string }>;
            }
          | {
              authoritative: Array<
                | {
                    fields: any;
                    op: "put";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
                | {
                    op: "del";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
              >;
              crdt: Array<{
                field: string;
                headSeq: number;
                kind: "text" | "count" | "set";
                projectionHash: string;
                rowId: string;
                table: string;
              }>;
              error: any;
              inserts: Array<{ id: string; ordinal: number; table: string }>;
              mutationId: string;
              outcome: "conflict";
              revisions: Array<{
                revId: string;
                rowId: string;
                table: string;
              }>;
              schedules: Array<{ id: string; ordinal: number }>;
              uploads: Array<{ ordinal: number; url: string }>;
            }
          | {
              authoritative: Array<
                | {
                    fields: any;
                    op: "put";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
                | {
                    op: "del";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
              >;
              crdt: Array<{
                field: string;
                headSeq: number;
                kind: "text" | "count" | "set";
                projectionHash: string;
                rowId: string;
                table: string;
              }>;
              error: any;
              inserts: Array<{ id: string; ordinal: number; table: string }>;
              mutationId: string;
              outcome: "rejected";
              revisions: Array<{
                revId: string;
                rowId: string;
                table: string;
              }>;
              schedules: Array<{ id: string; ordinal: number }>;
              uploads: Array<{ ordinal: number; url: string }>;
            }
          | {
              authoritative: Array<
                | {
                    fields: any;
                    op: "put";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
                | {
                    op: "del";
                    plainHash: string;
                    rowId: string;
                    table: string;
                  }
              >;
              crdt: Array<{
                field: string;
                headSeq: number;
                kind: "text" | "count" | "set";
                projectionHash: string;
                rowId: string;
                table: string;
              }>;
              error: any;
              inserts: Array<{ id: string; ordinal: number; table: string }>;
              mutationId: string;
              outcome: "rebase";
              revisions: Array<{
                revId: string;
                rowId: string;
                table: string;
              }>;
              schedules: Array<{ id: string; ordinal: number }>;
              uploads: Array<{ ordinal: number; url: string }>;
            };
      } | null,
      Name
    >;
    witnessRead: FunctionReference<
      "query",
      "internal",
      { rows: Array<{ rowId: string; table: string }> },
      Array<{
        crdt: Array<{
          epoch: number;
          field: string;
          headSeq: number;
          projectionHash: string;
        }>;
        rowId: string;
        table: string;
      }>,
      Name
    >;
  };
  remote: {
    client: {
      read: FunctionReference<
        "query",
        "internal",
        {
          identity?: { tokenIdentifier: string } | { identityKey: string };
          lastSeenBefore?: number;
          moduleGraphHash?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          protocolVersion?: number;
          retired?: boolean;
          schemaHash?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            acknowledgedThrough?: number;
            clientId: string;
            identity?: string;
            lastPushAt?: number;
            lastSeenAt: number;
            moduleGraphHash: string;
            protocolVersion: number;
            retired: boolean;
            schemaHash: string;
          }>;
        },
        Name
      >;
      retire: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          expectedIdentity?: string;
          expectedLastSeenAt: number;
        },
        { retirement: "retired" } | { retirement: "missing" },
        Name
      >;
    };
  };
  rev: {
    checkpointWrite: FunctionReference<
      "mutation",
      "internal",
      {
        rowId: string;
        snapshots: Array<{
          bytes: ArrayBuffer;
          field: string;
          hash: string;
          headSeq: number;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        table: string;
      },
      null,
      Name
    >;
    create: FunctionReference<
      "mutation",
      "internal",
      { deleted: boolean; rowId: string; table: string; value?: any },
      {
        crdt: Array<{
          field: string;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        createdAt: number;
        deleted: boolean;
        groupId: string;
        origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        parentRevId?: string;
        revId: string;
        rowId: string;
        status: "active" | "retained";
        table: string;
        value?: any;
      },
      Name
    >;
    createReplay: FunctionReference<
      "mutation",
      "internal",
      {
        deleted: boolean;
        replay: { createdAt: number; mutationId: string; ordinal: number };
        rowId: string;
        snapshots?: Array<{
          bytes: ArrayBuffer;
          field: string;
          hash: string;
          headSeq: number;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        table: string;
        value?: any;
      },
      {
        crdt: Array<{
          field: string;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        createdAt: number;
        deleted: boolean;
        groupId: string;
        origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        parentRevId?: string;
        revId: string;
        rowId: string;
        status: "active" | "retained";
        table: string;
        value?: any;
      },
      Name
    >;
    delete: FunctionReference<
      "mutation",
      "internal",
      { numItems: number; revId: string; rowId: string; table: string },
      { deleted: number; isDone: boolean },
      Name
    >;
    get: FunctionReference<
      "query",
      "internal",
      { revId: string; rowId: string; table: string },
      {
        crdt: Array<{
          field: string;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        createdAt: number;
        deleted: boolean;
        groupId: string;
        origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        parentRevId?: string;
        revId: string;
        rowId: string;
        status: "active" | "retained";
        table: string;
        value?: any;
      } | null,
      Name
    >;
    list: FunctionReference<
      "query",
      "internal",
      {
        createdBefore?: number;
        origin?: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        rowId?: string;
        status?: "active" | "retained";
        table?: string;
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          crdt: Array<{
            field: string;
            kind: "text" | "count" | "set";
            projectionHash: string;
          }>;
          createdAt: number;
          deleted: boolean;
          groupId: string;
          origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
          parentRevId?: string;
          revId: string;
          rowId: string;
          status: "active" | "retained";
          table: string;
          value?: any;
        }>;
      },
      Name
    >;
    restore: FunctionReference<
      "mutation",
      "internal",
      { revId: string; rowId: string; table: string },
      {
        crdt: Array<{
          field: string;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        createdAt: number;
        deleted: boolean;
        groupId: string;
        origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        parentRevId?: string;
        revId: string;
        rowId: string;
        status: "active" | "retained";
        table: string;
        value?: any;
      },
      Name
    >;
    retain: FunctionReference<
      "mutation",
      "internal",
      {
        deleted: boolean;
        origin: "conflict" | "rejected" | "displaced" | "delete";
        rowId: string;
        table: string;
        value?: any;
      },
      {
        crdt: Array<{
          field: string;
          kind: "text" | "count" | "set";
          projectionHash: string;
        }>;
        createdAt: number;
        deleted: boolean;
        groupId: string;
        origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
        parentRevId?: string;
        revId: string;
        rowId: string;
        status: "active" | "retained";
        table: string;
        value?: any;
      },
      Name
    >;
  };
};
