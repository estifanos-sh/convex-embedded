import { describe, expect, test } from "vite-plus/test";

import type { EmbeddedEvent } from "../../src/events";
import {
  rotateRetiredClient,
  startWorkerRemoteLoop,
  type WorkerState,
} from "../../src/browser/runtime";
import { remoteTickHasWork } from "../../src/rev";
import type { RemoteTick } from "../../src/storage/types";

const tick = (overrides: Partial<RemoteTick>): RemoteTick => ({
  changedResults: [],
  changedTables: [],
  pullAttempted: 1,
  pullDiagnostics: 0,
  pushAccepted: 0,
  pushAttempted: 0,
  pushConflicts: 0,
  pushRebases: 0,
  pushed: 0,
  pushFailed: 0,
  received: 0,
  reconnected: false,
  retainedRevisions: [],
  rowsApplied: 0,
  sent: 0,
  settlementsAcknowledged: 0,
  storeJobs: 0,
  ...overrides,
});

describe("remote tick activity", () => {
  test("continues draining after transport ingress", () => {
    expect(remoteTickHasWork(tick({ received: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ sent: 4, storeJobs: 6 }))).toBe(false);
  });

  test("keeps application and replication progress active", () => {
    expect(remoteTickHasWork(tick({ rowsApplied: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ pushAccepted: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ changedTables: ["documents"] }))).toBe(true);
  });

  test("waits for transport ingress after the actor owns a blocked backlog", async () => {
    let pushes = 0;
    const state = {
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return {
                state: "blocked",
                tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
              };
            },
          },
          pull: async () => tick({ pullAttempted: 0 }),
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(pushes).toBe(1);
  });

  test("gives a local mutation directly to the foreground push owner", async () => {
    let listener: ((event: EmbeddedEvent) => void) | undefined;
    let pulls = 0;
    let pushes = 0;
    const state = {
      runner: {
        subscribeEvents: (next: (event: EmbeddedEvent) => void) => {
          listener = next;
          return () => undefined;
        },
      },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return {
                state: "settled" as const,
                tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
              };
            },
          },
          pull: async () => {
            pulls += 1;
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pullsBeforeMutation = pulls;
    listener?.({
      at: 0,
      changedTables: ["documents"],
      commitSeq: 1,
      deletes: [],
      source: "local",
      type: "data",
      upserts: [{ id: "document", row: {}, table: "documents" }],
    });
    const deadline = Date.now() + 1_000;
    while (pushes < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(2);
    expect(pulls).toBe(pullsBeforeMutation);
  });

  test("replays a durable mutation envelope without row changes", async () => {
    let wakeRemote: (() => void) | undefined;
    let pushes = 0;
    const state = {
      runner: {
        remote: {
          wake: {
            subscribe: (listener: () => void) => {
              wakeRemote = listener;
              return () => undefined;
            },
          },
        },
        subscribeEvents: () => () => undefined,
      },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return {
                state: "settled" as const,
                tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
              };
            },
          },
          pull: async () => tick({ pullAttempted: 0 }),
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pushesBeforeWake = pushes;
    wakeRemote?.();
    const deadline = Date.now() + 1_000;
    while (pushes === pushesBeforeWake && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(pushesBeforeWake + 1);
  });

  test("sleeps while idle and wakes when the authorized query scope changes", async () => {
    let pulls = 0;
    const remote = {
      pull: async () => {
        pulls += 1;
        return tick({ pullAttempted: 0 });
      },
      scope: { write: async (_scope: { subscriptions: unknown[] }) => undefined },
    };
    const state = {
      runner: { subscribeEvents: () => () => undefined },
      store: { remote },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const idlePulls = pulls;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(pulls).toBe(idlePulls);

    await remote.scope.write({ subscriptions: [] });
    const deadline = Date.now() + 1_000;
    while (pulls === idlePulls && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toBe(idlePulls + 1);
  });

  test("keeps polling while a sent response is outstanding and sleeps once it arrives", async () => {
    let pulls = 0;
    let responded = false;
    const state = {
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            return responded
              ? tick({ pullAttempted: 0, received: 1 })
              : tick({ pullAttempted: 0, sent: 1 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const awaitingDeadline = Date.now() + 2_000;
    while (pulls < 3 && Date.now() < awaitingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pulls).toBeGreaterThanOrEqual(3);

    responded = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const idlePulls = pulls;
    await new Promise((resolve) => setTimeout(resolve, 800));
    stop();

    expect(pulls).toBe(idlePulls);
  });

  test("does not turn drained websocket ingress into a pull poll", async () => {
    const pulls: Array<boolean | undefined> = [];
    const state = {
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async (localProgress?: boolean) => {
            pulls.push(localProgress);
            return tick({ pullAttempted: 0, received: 1 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulls).toEqual([true]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulls).toEqual([true]);

    state.remoteWake?.();
    const deadline = Date.now() + 1_000;
    while (pulls.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toEqual([true, false]);
  });

  test("probes durable uploads only after local upload progress", async () => {
    let listener: ((event: EmbeddedEvent) => void) | undefined;
    const pulls: Array<boolean | undefined> = [];
    const state = {
      runner: {
        subscribeEvents: (next: (event: EmbeddedEvent) => void) => {
          listener = next;
          return () => undefined;
        },
      },
      store: {
        remote: {
          pull: async (localProgress?: boolean) => {
            pulls.push(localProgress);
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    listener?.({
      at: 0,
      changedTables: ["_storage", "_pending_uploads", "_id_mappings"],
      deletes: [],
      source: "local",
      type: "data",
      upserts: [],
    });
    const deadline = Date.now() + 1_000;
    while (pulls.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toEqual([true, true]);
  });

  test("rotates a retired client instead of backing off forever", async () => {
    const events: EmbeddedEvent[] = [];
    let pushes = 0;
    let retirements = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              throw new Error(
                "remote client retired: embedded:push failed: Embedded remote client has been permanently retired.",
              );
            },
          },
          pull: async () => tick({ pullAttempted: 0 }),
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state, undefined, () => {
      retirements += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();

    expect(pushes).toBe(1);
    expect(retirements).toBe(1);
    expect(state.remoteWake).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("retired"),
        status: "error",
        type: "remote",
      }),
    );
  });

  test("rotation mints a fresh author and re-pushes retained work after a complete restart", async () => {
    const starts: string[] = [];
    const pushAuthors: string[] = [];
    let activeClient = "";
    const remoteApi = {
      close: async () => undefined,
      doc: {
        push: async () => {
          pushAuthors.push(activeClient);
          return {
            state: "settled" as const,
            tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
          };
        },
      },
      identity: async () => undefined,
      pull: async () => tick({ pullAttempted: 0 }),
      scope: { write: async () => undefined },
      start: async (options: { clientId: string }) => {
        activeClient = options.clientId;
        starts.push(options.clientId);
      },
    };
    const state = {
      runner: {
        remote: { scope: { write: async () => undefined } },
        subscribeEvents: () => () => undefined,
      },
      store: { remote: remoteApi },
    } as unknown as WorkerState;
    const remote = {
      authFetchToken: false,
      clientId: "client_retired",
      moduleGraphHash: "modules",
      protocolVersion: 5,
      schemaHash: "schema",
      url: "wss://example.test",
    };

    await rotateRetiredClient(state, remote, false, () => undefined);
    const deadline = Date.now() + 1_000;
    while (pushAuthors.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    state.remoteStop?.();

    expect(remote.clientId).not.toBe("client_retired");
    expect(starts).toEqual([remote.clientId]);
    expect(pushAuthors).toContain(remote.clientId);
  });

  test("stops rotating after the breaker trips and surfaces the terminal retirement signal", async () => {
    const events: EmbeddedEvent[] = [];
    const starts: string[] = [];
    const remoteApi = {
      close: async () => undefined,
      doc: {
        push: async () => ({
          state: "settled" as const,
          tick: tick({ pullAttempted: 0 }),
        }),
      },
      identity: async () => undefined,
      pull: async () => tick({ pullAttempted: 0 }),
      scope: { write: async () => undefined },
      start: async (options: { clientId: string }) => {
        starts.push(options.clientId);
      },
    };
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      runner: {
        remote: { scope: { write: async () => undefined } },
        subscribeEvents: () => () => undefined,
      },
      store: { remote: remoteApi },
    } as unknown as WorkerState;
    const remote = {
      authFetchToken: false,
      clientId: "client_0",
      moduleGraphHash: "modules",
      protocolVersion: 5,
      schemaHash: "schema",
      url: "wss://example.test",
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await rotateRetiredClient(state, remote, false, () => undefined);
    }
    state.remoteStop?.();

    expect(starts).toHaveLength(3);
    expect(state.remoteStop).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ degradation: "retired", type: "runtime" }),
    );
  });

  test("stops pulling after a deployment mismatch while leaving the local runtime open", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    let eventSubscriptionStopped = false;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      runner: {
        subscribeEvents: () => () => {
          eventSubscriptionStopped = true;
        },
      },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            throw new Error(
              "remote deployment mismatch: embedded:pull failed: Embedded protocol 5 is not supported.",
            );
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pulls).toBe(1);
    expect(eventSubscriptionStopped).toBe(true);
    expect(state.remoteWake).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        degradation: "deployment-mismatch",
        type: "runtime",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        nextRunAt: undefined,
        status: "error",
        type: "remote",
      }),
    );

    stop();
  });
});
