import { describe, expect, test } from "vite-plus/test";

import {
  CHECKPOINT_IDLE_MS,
  CrashBreaker,
  REBUILD_MAX,
  REBUILD_WINDOW_MS,
  StoreRecovery,
  Watchdog,
  WATCHDOG_IDLE_MS,
  checkpointDue,
  classifyTrip,
  laneClassOf,
  rebuildIndeterminateMutationError,
  rejectMutationsForRebuild,
  type RecoveryHost,
  type RecoveryTimer,
} from "../../src/browser/recovery";
import { deferred } from "../../src/promise";
import { LeaderRuntime, type LeaderRecoveryHooks } from "../../src/browser/coordinator/leader";
import { WorkerCommand, WorkerEvent, type WorkerResponse } from "../../src/browser/protocol";
import {
  createRemoteTransport,
  ensureWorkerRemoteStarted,
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

  test("a disarmed lane never fires and stops the poller when idle", () => {
    const timer = new FakeTimer();
    const suspects: string[] = [];
    const watchdog = new Watchdog((lane) => suspects.push(lane), WATCHDOG_IDLE_MS, timer);

    const disarm = watchdog.arm("checkpoint");
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

describe("CrashBreaker", () => {
  test("tolerates REBUILD_MAX rebuilds and trips on the next inside the window", () => {
    const breaker = new CrashBreaker();
    for (let index = 0; index < REBUILD_MAX; index += 1) {
      expect(breaker.record(index * 1_000, "remote")).toBe(false);
    }
    expect(breaker.record(REBUILD_MAX * 1_000, "remote")).toBe(true);
  });

  test("prunes rebuilds older than the window so an old burst does not trip", () => {
    const breaker = new CrashBreaker();
    breaker.record(0, "remote");
    breaker.record(0, "remote");
    breaker.record(0, "remote");
    // The three-rebuild burst at t=0 ages out beyond the window; a fresh burst does not trip.
    expect(breaker.record(REBUILD_WINDOW_MS + 1, "remote")).toBe(false);
    expect(breaker.record(REBUILD_WINDOW_MS + 1, "remote")).toBe(false);
    expect(breaker.record(REBUILD_WINDOW_MS + 1, "remote")).toBe(false);
    expect(breaker.record(REBUILD_WINDOW_MS + 1, "remote")).toBe(true);
  });

  test("classifies a remote-only window with a healthy last rebuild as lane-only", () => {
    expect(classifyTrip(["remote", "remote", "remote", "remote"], true)).toBe("lane-only");
  });

  test("classifies any instance-lane fault as dead", () => {
    expect(classifyTrip(["remote", "instance", "remote", "remote"], true)).toBe("dead");
  });

  test("classifies a failed last rebuild as dead even for remote lanes", () => {
    expect(classifyTrip(["remote", "remote", "remote", "remote"], false)).toBe("dead");
  });

  test("maps only push and pull lanes to the remote class", () => {
    expect(laneClassOf("push")).toBe("remote");
    expect(laneClassOf("pull")).toBe("remote");
    expect(laneClassOf("remote-start")).toBe("instance");
    expect(laneClassOf("checkpoint")).toBe("instance");
  });
});

describe("checkpointDue", () => {
  const base = { lastActivityAt: 0, lastCheckpointAt: 0, now: 0, remoteBusy: false };

  test("fires after the idle window since drain and last checkpoint", () => {
    expect(checkpointDue({ ...base, now: CHECKPOINT_IDLE_MS })).toBe(true);
  });

  test("holds while the push queue or a pull is still in flight", () => {
    expect(checkpointDue({ ...base, now: CHECKPOINT_IDLE_MS, remoteBusy: true })).toBe(false);
  });

  test("holds until the store has been idle for the whole window", () => {
    expect(
      checkpointDue({ ...base, lastActivityAt: CHECKPOINT_IDLE_MS - 1, now: CHECKPOINT_IDLE_MS }),
    ).toBe(false);
  });

  test("holds until the window elapses since the last checkpoint", () => {
    expect(
      checkpointDue({ ...base, lastCheckpointAt: CHECKPOINT_IDLE_MS - 1, now: CHECKPOINT_IDLE_MS }),
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

/** A recording host that lets a test drive the controller's rebuild/trip/checkpoint outcomes. */
function recordingHost(timer: FakeTimer, overrides: Partial<RecoveryHost> = {}) {
  const calls: string[] = [];
  const host: RecoveryHost = {
    now: () => timer.now(),
    emitDegraded: () => calls.push("degraded"),
    emitReady: () => calls.push("ready"),
    emitRemoteError: () => calls.push("remote-error"),
    rebuild: async () => {
      calls.push("rebuild");
    },
    stopRemote: () => calls.push("stop-remote"),
    closeRemoteSocket: () => calls.push("close-socket"),
    deadInstance: () => calls.push("dead"),
    runCheckpoint: async () => {
      calls.push("checkpoint");
    },
    ...overrides,
  };
  return { calls, host };
}

describe("StoreRecovery", () => {
  test("a lane wedged behind a live transport emits degraded, rebuilds, then emits ready", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.transportActive();
    timer.advance(1);
    await drainMicrotasks();

    expect(calls).toEqual(["degraded", "rebuild", "ready"]);
    expect(calls).not.toContain("close-socket");
    recovery.dispose();
  });

  test("an offline transport-silent lane reconnects without a rebuild or breaker count", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, checkpointIdleMs: 10_000_000 });

    for (let attempt = 0; attempt <= REBUILD_MAX + 1; attempt += 1) {
      recovery.arm("pull");
      timer.advance(WATCHDOG_IDLE_MS);
      await drainMicrotasks();
    }

    expect(calls).toContain("remote-error");
    expect(calls).toContain("close-socket");
    expect(calls).not.toContain("rebuild");
    expect(calls).not.toContain("dead");
    expect(calls).not.toContain("stop-remote");
    expect(calls).not.toContain("degraded");
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
    expect(calls).not.toContain("rebuild");
    expect(calls).not.toContain("degraded");
    expect(calls).not.toContain("dead");
    recovery.dispose();
  });

  test("a store-side remote-start hang behind a live transport rebuilds", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    recovery.arm("remote-start");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.transportActive();
    timer.advance(1);
    await drainMicrotasks();

    expect(calls).toContain("rebuild");
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
    expect(calls).toContain("rebuild");
    recovery.dispose();
  });

  test("a stale-generation progress signal does not extend the fresh instance deadline", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });
    const staleGen = recovery.remoteGeneration;

    recovery.arm("pull");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.transportActive();
    timer.advance(1);
    await drainMicrotasks();
    expect(calls).toEqual(["degraded", "rebuild", "ready"]);
    expect(recovery.remoteGeneration).toBe(staleGen + 1);

    recovery.arm("checkpoint");
    timer.advance(WATCHDOG_IDLE_MS - 1);
    recovery.progress(staleGen);
    timer.advance(1);
    await drainMicrotasks();

    expect(calls.filter((call) => call === "rebuild").length).toBe(2);
    recovery.dispose();
  });

  test("watchdog reset runs before the rebuild so a lane armed mid-rebuild survives", async () => {
    const timer = new FakeTimer();
    const holder: { recovery?: StoreRecovery } = {};
    const { calls, host } = recordingHost(timer, {
      rebuild: async () => {
        calls.push("rebuild");
        holder.recovery!.arm("checkpoint");
      },
    });
    const recovery = new StoreRecovery(host, { timer });
    holder.recovery = recovery;

    recovery.arm("checkpoint");
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();
    timer.advance(WATCHDOG_IDLE_MS);
    await drainMicrotasks();

    expect(calls.filter((call) => call === "rebuild").length).toBe(2);
    recovery.dispose();
  });

  test("trips to a dead instance when a checkpoint lane keeps wedging", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer, { rebuild: async () => undefined });
    const recovery = new StoreRecovery(host, { timer });

    for (let attempt = 0; attempt <= REBUILD_MAX; attempt += 1) {
      recovery.arm("checkpoint");
      timer.advance(WATCHDOG_IDLE_MS);
      await drainMicrotasks();
      recovery.watchdog.reset();
    }

    expect(calls).toContain("dead");
    expect(calls).not.toContain("stop-remote");
    recovery.dispose();
  });

  test("trips to lane-only keep-last-good for a live-transport remote-lane crash loop", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer });

    for (let attempt = 0; attempt <= REBUILD_MAX; attempt += 1) {
      recovery.arm("pull");
      timer.advance(WATCHDOG_IDLE_MS - 1);
      recovery.transportActive();
      timer.advance(1);
      await drainMicrotasks();
      recovery.watchdog.reset();
    }

    expect(calls).toContain("stop-remote");
    expect(calls).toContain("remote-error");
    expect(calls).not.toContain("dead");
    recovery.dispose();
  });

  test("a push-only session clears remoteBusy so a checkpoint paces", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, checkpointPollMs: CHECKPOINT_IDLE_MS });

    recovery.onRemoteActive();
    timer.advance(CHECKPOINT_IDLE_MS * 2);
    await drainMicrotasks();
    expect(calls).not.toContain("checkpoint");

    recovery.onRemoteIdle();
    timer.advance(CHECKPOINT_IDLE_MS);
    await drainMicrotasks();
    expect(calls).toContain("checkpoint");
    recovery.dispose();
  });

  test("paces a checkpoint once the store has drained and gone idle", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, checkpointPollMs: CHECKPOINT_IDLE_MS });

    recovery.onRemoteIdle();
    timer.advance(CHECKPOINT_IDLE_MS);
    await drainMicrotasks();

    expect(calls).toContain("checkpoint");
    recovery.dispose();
  });

  test("does not checkpoint while remote work is in flight", async () => {
    const timer = new FakeTimer();
    const { calls, host } = recordingHost(timer);
    const recovery = new StoreRecovery(host, { timer, checkpointPollMs: CHECKPOINT_IDLE_MS });

    recovery.onRemoteActive();
    timer.advance(CHECKPOINT_IDLE_MS * 3);
    await drainMicrotasks();

    expect(calls).not.toContain("checkpoint");
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
    protocolVersion: 1,
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

  test("a stale continuation after a failed start neither closes the grafted remote nor schedules a retry", async () => {
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
});

describe("dead-instance fast-fail", () => {
  const idleHooks: LeaderRecoveryHooks = {
    abandonRemote: () => undefined,
    restartRemote: () => undefined,
    stopRemote: () => undefined,
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
      identity: { storageId: "documents" } as never,
      runtime,
      scope: "scope",
      storagePath: "documents.db",
    });
    const recovery = leader.enableRecovery(idleHooks);
    runtime.rebuild = async () => {
      throw new Error("emnapi pthread pool crashed");
    };
    recovery.reportThreadError();
    return { leader, ran, runtime };
  }

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
    expect(result?.error?.message).toBe("emnapi pthread pool crashed");
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
    expect(result?.error?.message).toBe("emnapi pthread pool crashed");
    expect(ran).not.toContain("mutation");
    await leader.close();
  });
});

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
