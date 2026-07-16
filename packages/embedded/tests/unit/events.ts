import { describe, expect, test } from "vite-plus/test";

import type {
  EmbeddedInternalEvent,
  EmbeddedOperationEvent,
  EmbeddedRemoteEvent,
  EmbeddedRuntimeEvent,
} from "../../src/events";
import { mapPublicEvent } from "../../src/events";

function remote(overrides: Partial<EmbeddedRemoteEvent>): EmbeddedRemoteEvent {
  return { at: 1, attempt: 0, status: "idle", type: "remote", ...overrides };
}

function runtime(overrides: Partial<EmbeddedRuntimeEvent>): EmbeddedRuntimeEvent {
  return { at: 1, type: "runtime", ...overrides };
}

function operation(overrides: Partial<EmbeddedOperationEvent>): EmbeddedOperationEvent {
  return {
    at: 1,
    id: 7,
    kind: "mutation",
    name: "todos:add",
    phase: "start",
    status: "pending",
    type: "operation",
    ...overrides,
  };
}

describe("public event mapping", () => {
  test("runtime phases collapse onto the V5 runtime union", () => {
    expect(mapPublicEvent(runtime({ phase: "opfs-register" }))).toEqual({
      at: 1,
      phase: "starting",
      type: "runtime",
    });
    expect(mapPublicEvent(runtime({ phase: "store-open" }))).toMatchObject({ phase: "store-open" });
    expect(mapPublicEvent(runtime({ phase: "store-setup" }))).toMatchObject({
      phase: "schema-ready",
    });
    expect(mapPublicEvent(runtime({ phase: "remote-attach" }))).toMatchObject({
      phase: "schema-ready",
    });
    expect(mapPublicEvent(runtime({ phase: "ready" }))).toMatchObject({ phase: "ready" });
    expect(mapPublicEvent(runtime({ degradation: "failed", error: "boom" }))).toEqual({
      at: 1,
      error: "boom",
      phase: "degraded",
      type: "runtime",
    });
  });

  test("a corrupt degradation maps to the V5 crdt-corrupt variant", () => {
    expect(mapPublicEvent(runtime({ degradation: "corrupt", error: "not a database" }))).toEqual({
      at: 1,
      field: "",
      rowId: "",
      state: "corrupt",
      table: "",
      type: "crdt",
    });
    expect(mapPublicEvent(runtime({ degradation: "failed", error: "boom" }))).toMatchObject({
      phase: "degraded",
      type: "runtime",
    });
  });

  test("remote status maps to the V5 remote union without tick detail", () => {
    const progress = mapPublicEvent(remote({ status: "tick", tick: undefined, attempt: 2 }));
    expect(progress).toEqual({ at: 1, attempt: 2, status: "connected", type: "remote" });
    expect(progress && "tick" in progress).toBe(false);
    expect(mapPublicEvent(remote({ status: "started" }))).toMatchObject({ status: "starting" });
    expect(mapPublicEvent(remote({ status: "connected" }))).toMatchObject({ status: "connected" });
    expect(mapPublicEvent(remote({ status: "idle" }))).toMatchObject({ status: "idle" });
    expect(mapPublicEvent(remote({ status: "offline" }))).toMatchObject({ status: "offline" });
    expect(mapPublicEvent(remote({ status: "closed" }))).toMatchObject({ status: "closed" });
    expect(mapPublicEvent(remote({ status: "error", error: "net", nextRunAt: 9 }))).toEqual({
      at: 1,
      attempt: 0,
      error: "net",
      nextRunAt: 9,
      status: "error",
      type: "remote",
    });
  });

  test("operation maps to stable public phases and drops non-public kinds", () => {
    expect(mapPublicEvent(operation({ phase: "start" }))).toEqual({
      at: 1,
      functionName: "todos:add",
      kind: "mutation",
      operationId: "7",
      phase: "local-start",
      type: "operation",
    });
    expect(mapPublicEvent(operation({ phase: "finish", status: "success" }))).toMatchObject({
      phase: "local-commit",
    });
    expect(
      mapPublicEvent(operation({ phase: "finish", status: "error", error: "rejected" })),
    ).toEqual({
      at: 1,
      error: "rejected",
      functionName: "todos:add",
      kind: "mutation",
      operationId: "7",
      phase: "error",
      type: "operation",
    });
    expect(mapPublicEvent(operation({ kind: "upload" }))).toBeNull();
    expect(mapPublicEvent(operation({ kind: "devtools" }))).toBeNull();
  });

  test("data carries only source and tables", () => {
    expect(
      mapPublicEvent({
        at: 1,
        changedTables: ["todos"],
        deletes: [],
        source: "remote",
        type: "data",
        docWrites: [],
      }),
    ).toEqual({ at: 1, source: "remote", tables: ["todos"], type: "data" });
    expect(
      mapPublicEvent({ at: 1, changedTables: ["todos"], deletes: [], type: "data", docWrites: [] }),
    ).toMatchObject({ source: "local" });
  });

  test("internal-only events are not surfaced publicly", () => {
    const internalOnly: EmbeddedInternalEvent[] = [
      { at: 1, deletes: [], type: "storage", docWrites: [] },
      { at: 1, deletes: [], type: "scheduler", docWrites: [] },
      { at: 1, id: "s", name: "span", phase: "start", type: "span" },
      { at: 1, conflicts: [{ id: "r", revId: "v", table: "todos" }], type: "conflict" },
    ];
    for (const event of internalOnly) expect(mapPublicEvent(event)).toBeNull();
  });

  test("mapping never mutates the rich internal event", () => {
    const rich = remote({ status: "tick", tick: undefined });
    const snapshot = JSON.stringify(rich);
    mapPublicEvent(rich);
    expect(JSON.stringify(rich)).toBe(snapshot);
  });
});
