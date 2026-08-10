import { describe, expect, test } from "vite-plus/test";

import {
  WAL_WRITE_IDLE_MS,
  StoreRecovery,
  Watchdog,
  WATCHDOG_IDLE_MS,
  walWriteDue,
  rebuildIndeterminateMutationError,
  rejectMutationsForRebuild,
  type RecoveryHost,
  type RecoveryTimer,
} from "../../src/browser/recovery";
import { deferred } from "../../src/promise";
import type { DiagnosticEvent as EmbeddedEvent } from "../../src/events";
import { LeaderRuntime, type LeaderRecoveryHooks } from "../../src/browser/coordinator/leader";
import { WorkerCommand, WorkerEvent, type WorkerResponse } from "../../src/browser/protocol";
import {
  abandonWorkerRemote,
  createRemoteTransport,
  ensureWorkerRemoteStarted,
  handleWorkerRemoteAuthResult,
  type WorkerState,
} from "../../src/browser/runtime";

/** Controllable clock + interval registry driven by hand, matching the outbox test style. */
class FakeTimer implements RecoveryTimer {
  private clock = 0;
  private nextHandle = 1;
  private readonly intervals = new Map<number, { callback: () => void; ms: number }>();

  now(): number {
    return this.clock;
  }

  setInterval(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.intervals.set(handle, { callback, ms });
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  /** Advances the clock and fires every registered interval once per elapsed period. */
  advance(ms: number): void {
    this.clock += ms;
    this.fireIntervals();
  }

  /** Fires all registered intervals without moving the clock. */
  tick(): void {
    this.fireIntervals();
  }

  private fireIntervals(): void {
    for (const interval of Array.from(this.intervals.values())) interval.callback();
  }

  get activeIntervals(): number {
    return this.intervals.size;
  }
}

describe("Watchdog", () => {
  test("abandons a lane after the idle deadline with no progress", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    watchdog.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    expect(suspects).toEqual([]);
    timer.advance(1);

    expect(suspects).toEqual(["pull"]);
    expect(watchdog.isSuspect).toBe(true);
  });

  test("progress resets the deadline for an armed lane", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    watchdog.arm("push");
    timer.advance(WATCHDOG_IDLE_MS - 1_000);
    watchdog.progress();
    timer.advance(WATCHDOG_IDLE_MS - 1_000);
    expect(suspects).toEqual([]);

    timer.advance(1_000);
    expect(suspects).toEqual(["push"]);
  });

  test("progress in one lane cannot mask another wedged lane", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    watchdog.arm("pull");
    watchdog.arm("push");
    timer.advance(WATCHDOG_IDLE_MS - 1_000);
    watchdog.progress("push");
    timer.advance(1_000);

    expect(suspects).toEqual(["pull"]);
  });

  test("a disarmed lane never fires and stops the poller when idle", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    const disarm = watchdog.arm("wal-write");
    expect(timer.activeIntervals).toBe(1);
    disarm();
    expect(timer.activeIntervals).toBe(0);
    timer.advance(WATCHDOG_IDLE_MS * 2);

    expect(suspects).toEqual([]);
  });

  test("latches so a single wedge fires once until reset", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    watchdog.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS);
    timer.tick();
    timer.tick();
    expect(suspects).toEqual(["pull"]);

    watchdog.reset();
    expect(watchdog.isSuspect).toBe(false);
    watchdog.arm("push");
    timer.advance(WATCHDOG_IDLE_MS);
    expect(suspects).toEqual(["pull", "push"]);
  });

  test("late disarm after a reset is a harmless no-op", () => {
    const timer = new FakeTimer();
    const watchdog = new Watchdog(() => undefined, WATCHDOG_IDLE_MS, timer);
    const disarm = watchdog.arm("pull");
    watchdog.reset();
    expect(() => disarm()).not.toThrow();
  });
});

describe("walWriteDue", () => {
  const base = { lastActivityAt: 0, lastWalWriteAt: 0, now: 0, remoteBusy: false };

  test("fires after the idle window since drain and last WAL write", () => {
    expect(walWriteDue({ ...base, now: WAL_WRITE_IDLE_MS })).toBe(true);
  });

  test("holds while the push queue or a pull is still in flight", () => {
    expect(walWriteDue({ ...base, now: WAL_WRITE_IDLE_MS, remoteBusy: true })).toBe(false);
  });

  test("holds until the store has been idle for the whole window", () => {
    expect(
      walWriteDue({ ...base, lastActivityAt: WAL_WRITE_IDLE_MS - 1, now: WAL_WRITE_IDLE_MS }),
    ).toBe(false);
  });

  test("holds until the window elapses since the last WAL write", () => {
    expect(
      walWriteDue({ ...base, lastWalWriteAt: WAL_WRITE_IDLE_MS - 1, now: WAL_WRITE_IDLE_MS }),
    ).toBe(false);
  });
});

describe("rejectMutationsForRebuild", () => {
  test("rejects every in-flight mutation with the indeterminate identity and clears the map", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const mutations = new Map([
      ["m1", { reject: (error: unknown) => first.reject(error) }],
      ["m2", { reject: (error: unknown) => second.reject(error) }],
    ]);

    rejectMutationsForRebuild(mutations);

    expect(mutations.size).toBe(0);
    for (const settled of [first.promise, second.promise]) {
      await expect(settled).rejects.toThrow(/indeterminate/i);
      await settled.catch((error: Error) => {
        expect(error.name).toBe("ConvexEmbeddedMutationIndeterminateError");
      });
    }
  });

  test("the shared error name matches the outbox/proxy crash semantics", () => {
    expect(rebuildIndeterminateMutationError().name).toBe(
      "ConvexEmbeddedMutationIndeterminateError",
    );
  });
});

/** A recording host that lets a test drive terminal, reconnect, and WAL-write outcomes. */
function recordingHost(timer: FakeTimer, overrides: Partial<RecoveryHost> = {}) {
  const calls: string[] = [];
  const host: RecoveryHost = {
    now: () => timer.now(),
    emitDegraded: () => calls.push("degraded"),
    emitRemoteError: () => calls.push("remote-error"),
    closeRemoteSocket: () => calls.push("close-socket"),
    deadInstance: () => calls.push("dead"),
    walWrite: async () => {
      calls.push("wal-write");
    },
    ...overrides,
  };
  return { calls, host };
}

describe("StoreRecovery", () => {
  test("a wedged lane terminates instead of opening a second store in the same worker", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.transportActive();
    timer.advance(1);
    await drainMicrotasks();

    expect(calls).toEqual(["degraded", "dead"]);
    expect(calls).not.toContain("close-socket");
    recovery.dispose();
  });

  test("an offline transport-silent lane is still supervised after reconnect interruption", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, walWriteIdleMs: 10_000_000 });

    recovery.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();

    expect(calls).toContain("remote-error");
    expect(calls).toContain("close-socket");
    expect(calls).not.toContain("degraded");
    expect(calls).not.toContain("dead");

    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();
    expect(calls).toContain("degraded");
    expect(calls).toContain("dead");
    recovery.dispose();
  });

  test("an offline remote-start hang reconnects instead of rebuilding", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("remote-start");
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();

    expect(calls).toContain("close-socket");
    expect(calls).toContain("remote-error");
    expect(calls).not.toContain("degraded");
    expect(calls).not.toContain("dead");
    recovery.dispose();
  });

  test("a store-side remote-start hang behind a live transport is terminal", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("remote-start");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.transportActive();
    timer.advance(1);
    await drainMicrotasks();

    expect(calls).toContain("dead");
    expect(calls).not.toContain("close-socket");
    recovery.dispose();
  });

  test("a stale-generation thread error from a terminated pool is ignored", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.reportThreadError(recovery.remoteGeneration + 1);
    await drainMicrotasks();
    expect(calls).toEqual([]);

    recovery.reportThreadError(recovery.remoteGeneration);
    await drainMicrotasks();
    expect(calls).toContain("dead");
    recovery.dispose();
  });

  test("a terminal instance ignores later watchdog activity", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("wal-write");
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();
    recovery.reportThreadError();
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();

    expect(calls.filter((call) => call === "dead")).toHaveLength(1);
    recovery.dispose();
  });

  test("a push-only session clears remoteBusy so a WAL write paces", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, walWritePollMs: WAL_WRITE_IDLE_MS });

    recovery.onRemoteActive();
    timer.advance(WAL_WRITE_IDLE_MS * 2);
    await drainMicrotasks();
    expect(calls).not.toContain("wal-write");

    recovery.onRemoteIdle();
    timer.advance(WAL_WRITE_IDLE_MS);
    await drainMicrotasks();
    expect(calls).toContain("wal-write");
    recovery.dispose();
  });

  test("paces a WAL write once the store has drained and gone idle", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, walWritePollMs: WAL_WRITE_IDLE_MS });

    recovery.onRemoteIdle();
    timer.advance(WAL_WRITE_IDLE_MS);
    await drainMicrotasks();

    expect(calls).toContain("wal-write");
    recovery.dispose();
  });

  test("does not write the WAL while remote work is in flight", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, walWritePollMs: WAL_WRITE_IDLE_MS });

    recovery.onRemoteActive();
    timer.advance(WAL_WRITE_IDLE_MS * 3);
    await drainMicrotasks();

    expect(calls).not.toContain("wal-write");
    recovery.dispose();
  });
});

describe("remote transport connect lifecycle", () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    onclose: ((event: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    onopen: (() => void) | null = null;
    readyState = 0;
    close(): void {}
  }

  test("close during a pending connect settles the connect promise", async () => {
    const scope = globalThis as { WebSocket?: unknown };
    const original = scope.WebSocket;
    scope.WebSocket = FakeWebSocket;
    try {
      const transport = createRemoteTransport(
        30_000,
        () => undefined,
        () => undefined,
        async () => ({ storageId: "" }),
      );
      const connecting = transport.connect({ url: "wss://example.convex.cloud" });
      await transport.close();
      await expect(connecting).rejects.toThrow(/closed during connect/);
      await expect(transport.receive({ timeoutMs: 0 })).resolves.toMatchObject({
        kind: "closed",
      });
    } finally {
      scope.WebSocket = original;
    }
  });

  test("a superseding connect settles the previous pending connect", async () => {
    const scope = globalThis as { WebSocket?: unknown };
    const original = scope.WebSocket;
    scope.WebSocket = FakeWebSocket;
    try {
      const transport = createRemoteTransport(
        30_000,
        () => undefined,
        () => undefined,
        async () => ({ storageId: "" }),
      );
      const first = transport.connect({ url: "wss://example.convex.cloud" });
      const second = transport.connect({ url: "wss://example.convex.cloud" });
      await expect(first).rejects.toThrow(/superseded/);
      second.catch(() => undefined);
      await transport.close();
      await expect(second).rejects.toThrow(/closed during connect/);
    } finally {
      scope.WebSocket = original;
    }
  });
});

describe("stale-generation start continuation", () => {
  const remoteOptions = {
    authFetchToken: false,
    moduleGraphHash: "modules",
    contractId: "sha256:test-contract",
    schemaHash: "schema",
    url: "https://example.convex.cloud",
  };

  function fakeRecovery(): { recovery: StoreRecovery; bump: () => void } {
    let generation = 0;
    const recovery = {
      get remoteGeneration() {
        return generation;
      },
      arm: () => () => undefined,
      onLocalCommit: () => undefined,
      onRemoteActive: () => undefined,
      onRemoteIdle: () => undefined,
      progress: () => undefined,
      reportThreadError: () => undefined,
      transportActive: () => undefined,
    } as unknown as StoreRecovery;
    return { bump: () => (generation += 1), recovery };
  }

  function remoteStartState(calls: string[], startGate: Promise<void>): WorkerState {
    return {
      opfs: { closeAll: () => undefined },
      runner: {
        handleUpload: async () => ({ storageId: "" }),
        subscribeEvents: () => () => undefined,
      },
      stops: new Map(),
      store: {
        remote: {
          close: async () => {
            calls.push("close");
          },
          identity: async () => {
            calls.push("identity");
          },
          pull: async () => {
            calls.push("pull");
          },
          start: async () => {
            calls.push("start");
            await startGate;
          },
        },
      },
    } as unknown as WorkerState;
  }

  test("a stale continuation after a successful start does not start a second loop", async () => {
    const calls: string[] = [];
    const gate = deferred<void>();
    const { bump, recovery } = fakeRecovery();
    const state = remoteStartState(calls, gate.promise);
    state.recovery = recovery;

    const ready = ensureWorkerRemoteStarted(state, remoteOptions, false, () => undefined);
    bump();
    gate.resolve();
    await ready;

    expect(calls).toEqual(["start"]);
    expect(state.remoteStop).toBeUndefined();
  });

  test("an abandoned startup cannot install identity or a remote loop in the next event generation", async () => {
    const calls: string[] = [];
    const events: unknown[] = [];
    const gate = deferred<void>();
    const state = remoteStartState(calls, gate.promise);
    state.emit = (event) => events.push(event);

    const ready = ensureWorkerRemoteStarted(state, remoteOptions, false, () => undefined);
    expect(state.remoteEventGeneration).toBe(1);
    abandonWorkerRemote(state);
    expect(state.remoteEventGeneration).toBe(2);
    const eventsAfterAbandon = events.length;
    gate.resolve();
    await ready;

    expect(calls).toEqual(["start"]);
    expect(events).toHaveLength(eventsAfterAbandon);
    expect(state.remoteStop).toBeUndefined();
  });

  test("a stale continuation after a failed start neither closes the replacement remote nor schedules a retry", async () => {
    const calls: string[] = [];
    const gate = deferred<void>();
    gate.promise.catch(() => undefined);
    const { bump, recovery } = fakeRecovery();
    const state = remoteStartState(calls, gate.promise);
    state.recovery = recovery;

    const ready = ensureWorkerRemoteStarted(state, remoteOptions, false, () => undefined);
    bump();
    gate.reject(new Error("wedged instance"));
    await ready;

    expect(calls).not.toContain("close");
    expect(state.remoteStartTimer).toBeUndefined();
  });

  test("a retryable startup failure reports connecting backoff instead of terminal error", async () => {
    const calls: string[] = [];
    const events: EmbeddedEvent[] = [];
    const gate = deferred<void>();
    gate.promise.catch(() => undefined);
    const state = remoteStartState(calls, gate.promise);
    state.emit = (event) => events.push(event);

    const ready = ensureWorkerRemoteStarted(state, remoteOptions, false, () => undefined);
    gate.reject(new Error("network unavailable"));
    await ready;

    expect(events).toContainEqual(
      expect.objectContaining({
        error: "network unavailable",
        nextRunAt: expect.any(Number),
        status: "starting",
        type: "remote",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ error: "network unavailable", status: "error", type: "remote" }),
    );
    expect(state.remoteStartTimer).toBeDefined();
    abandonWorkerRemote(state);
  });

  test("a retired auth response cannot satisfy the next remote generation", async () => {
    const requests: number[] = [];
    const tokens: Array<string | null> = [];
    const state = remoteStartState([], Promise.resolve());
    state.store.remote!.start = async (options) => {
      tokens.push((await options.auth?.({ forceRefreshToken: false })) ?? null);
    };
    const options = { ...remoteOptions, authFetchToken: true };
    const post = (message: WorkerResponse) => {
      if (message.op === WorkerEvent.AuthTokenRequest) requests.push(message.authRequestId);
    };

    const first = ensureWorkerRemoteStarted(state, options, false, post);
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    abandonWorkerRemote(state);
    await first;

    const second = ensureWorkerRemoteStarted(state, options, false, post);
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBeGreaterThan(requests[0]!);

    handleWorkerRemoteAuthResult(state, {
      authRequestId: requests[0]!,
      id: 1,
      op: WorkerCommand.AuthTokenResult,
      token: "stale",
    });
    expect(state.remoteAuthPending?.has(requests[1]!)).toBe(true);
    handleWorkerRemoteAuthResult(state, {
      authRequestId: requests[1]!,
      id: 2,
      op: WorkerCommand.AuthTokenResult,
      token: "fresh",
    });
    await second;

    expect(tokens).toEqual(["fresh"]);
    abandonWorkerRemote(state);
  });
});

describe("dead-instance fast-fail", () => {
  const idleHooks: LeaderRecoveryHooks = {
    closeRemoteSocket: () => undefined,
    onDeadInstance: () => undefined,
  };

  function deadLeader(): { leader: LeaderRuntime; runtime: WorkerState; ran: string[] } {
    const ran: string[] = [];
    const runtime = {
      opfs: { closeAll: () => undefined },
      runner: {
        runQuery: async () => {
          ran.push("query");
          return null;
        },
        runMutation: async () => {
          ran.push("mutation");
          return null;
        },
        subscribeEvents: () => () => undefined,
      },
      stops: new Map(),
      store: { close: async () => undefined },
    } as unknown as WorkerState;
    const leader = new LeaderRuntime({
      epoch: "leader",
      fence: "1",
      identity: { storageId: "documents" } as never,
      runtime,
      scope: "scope",
      storagePath: "documents.db",
    });
    const recovery = leader.enableRecovery(idleHooks);
    recovery.reportThreadError();
    return { leader, ran, runtime };
  }

  test("publishes degraded runtime state before asking the page to dispose", async () => {
    const order: string[] = [];
    const runtime = {
      opfs: { closeAll: () => undefined },
      runner: { subscribeEvents: () => () => undefined },
      stops: new Map(),
      store: { close: async () => undefined },
    } as unknown as WorkerState;
    const leader = new LeaderRuntime({
      epoch: "leader",
      fence: "1",
      identity: { storageId: "documents" } as never,
      runtime,
      scope: "scope",
      storagePath: "documents.db",
    });
    leader.addLocalClient({
      activeMutations: 0,
      id: "client",
      post: (response) => {
        if (response.op === WorkerEvent.Event && response.event.type === "runtime") {
          order.push(`runtime:${response.event.degradation ?? response.event.phase}`);
        }
      },
      remoteConfigured: true,
      watches: new Map(),
      workerId: "worker",
    });
    const recovery = leader.enableRecovery({
      ...idleHooks,
      onDeadInstance: () => order.push("page-dispose"),
    });

    recovery.reportThreadError();
    await drainMicrotasks();

    expect(order.at(-1)).toBe("page-dispose");
    expect(order.slice(0, -1)).toContain("runtime:failed");
    await leader.close();
  });

  test("rejects a fresh query promptly with the sticky root error, never running it", async () => {
    const { leader, ran, runtime } = deadLeader();
    await drainMicrotasks();
    expect(runtime.abandoned).toBe(true);

    const responses: WorkerResponse[] = [];
    const client = {
      activeMutations: 0,
      id: "client",
      post: (response: WorkerResponse) => responses.push(response),
      remoteConfigured: true,
      watches: new Map(),
      workerId: "worker",
    };
    await leader.handle(client, {
      args: {},
      clientId: "client",
      id: 1,
      name: "docs:list",
      op: WorkerCommand.Query,
    } as never);

    const result = responses.find(
      (response) => response.op === WorkerEvent.Result && response.id === 1,
    ) as Extract<WorkerResponse, { op: typeof WorkerEvent.Result }> | undefined;
    expect(result?.error?.message).toBe("embedded store instance wedged on wal-write lane");
    expect(ran).not.toContain("query");
    await leader.close();
  });

  test("rejects a fresh mutation promptly with the sticky root error, never running it", async () => {
    const { leader, ran, runtime } = deadLeader();
    await drainMicrotasks();
    expect(runtime.abandoned).toBe(true);

    const responses: WorkerResponse[] = [];
    const client = {
      activeMutations: 0,
      id: "client",
      post: (response: WorkerResponse) => responses.push(response),
      remoteConfigured: true,
      watches: new Map(),
      workerId: "worker",
    };
    await leader.handle(client, {
      args: {},
      clientId: "client",
      id: 2,
      mutationId: "m1",
      name: "docs:add",
      op: WorkerCommand.Mutation,
    } as never);

    const result = responses.find(
      (response) => response.op === WorkerEvent.Result && response.id === 2,
    ) as Extract<WorkerResponse, { op: typeof WorkerEvent.Result }> | undefined;
    expect(result?.error?.message).toBe("embedded store instance wedged on wal-write lane");
    expect(ran).not.toContain("mutation");
    await leader.close();
  });
});

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
