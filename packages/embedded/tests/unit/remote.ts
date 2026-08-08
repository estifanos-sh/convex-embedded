import { describe, expect, test } from "vite-plus/test";

import type { DiagnosticEvent as EmbeddedEvent } from "../../src/events";
import {
  assembleTransitionChunk,
  createRemoteTransport,
  decideWorkerRemoteTurn,
  rotateRetiredClient,
  startWorkerRemoteLoop,
  writeWorkerRemoteConnection,
  writeWorkerRemoteNetwork,
  type WorkerState,
  type RemoteTransportLimits,
} from "../../src/browser/runtime";
import { mergeRemoteTicks, remotePendingIsEmpty, remoteTickHasWork } from "../../src/rev";
import type { RemoteTick } from "../../src/storage/types";
import { getTimerTime } from "../../src/time";

const tick = (overrides: Partial<RemoteTick>): RemoteTick => ({
  changedResults: [],
  changedTables: [],
  pullAttempted: 1,
  pullDiagnostics: 0,
  pullChangesApplied: 0,
  pullSnapshots: 0,
  pending: {
    checkpoints: 0,
    inflight: 0,
    mutations: 0,
    scope: 0,
    settlements: 0,
    uploads: 0,
  },
  pushAccepted: 0,
  pushAttempted: 0,
  pushConflicts: 0,
  pushRebases: 0,
  pushed: 0,
  pushFailed: 0,
  received: 0,
  reconnected: false,
  retainedRevisions: [],
  settlements: [],
  rowsApplied: 0,
  sent: 0,
  receiptsPushed: 0,
  storeJobs: 0,
  ...overrides,
});

const chunkFrame = (
  chunk: string,
  partNumber: number,
  totalParts: number,
  transitionId: string,
): string =>
  JSON.stringify({ chunk, partNumber, totalParts, transitionId, type: "TransitionChunk" });

function transportLimits(overrides: Partial<RemoteTransportLimits> = {}): RemoteTransportLimits {
  return {
    inboxBytes: 1_024,
    inboxCount: 8,
    messageBytes: 1_024,
    totalParts: 8,
    ...overrides,
  };
}

class TransportSocket {
  static readonly OPEN = 1;
  static instances: TransportSocket[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;

  constructor(_url: string) {
    TransportSocket.instances.push(this);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  open(): void {
    this.readyState = TransportSocket.OPEN;
    this.onopen?.();
  }

  send(_message: string): void {}
}

function createTestTransport(limits: RemoteTransportLimits) {
  return createRemoteTransport(
    30_000,
    () => undefined,
    () => undefined,
    async () => ({ storageId: "" }),
    () => undefined,
    () => undefined,
    () => undefined,
    limits,
  );
}

async function withTransportSocket(run: () => Promise<void>): Promise<void> {
  const scope = globalThis as { WebSocket?: unknown };
  const original = scope.WebSocket;
  TransportSocket.instances = [];
  scope.WebSocket = TransportSocket;
  try {
    await run();
  } finally {
    scope.WebSocket = original;
    TransportSocket.instances = [];
  }
}

describe("transition chunk reassembly", () => {
  test("passes a whole server message straight through", () => {
    const raw = '{"type":"Transition","modifications":[]}';
    const step = assembleTransitionChunk(undefined, raw);
    expect(step.message).toBe(raw);
    expect(step.buffer).toBeUndefined();
  });

  test("joins ordered chunks into the full transition the actor expects", () => {
    const full = '{"type":"Transition","modifications":[{"queryId":1}]}';
    const parts = [full.slice(0, 15), full.slice(15, 34), full.slice(34)];
    const step0 = assembleTransitionChunk(undefined, chunkFrame(parts[0], 0, 3, "t1"));
    expect(step0.message).toBeUndefined();
    const step1 = assembleTransitionChunk(step0.buffer, chunkFrame(parts[1], 1, 3, "t1"));
    expect(step1.message).toBeUndefined();
    const step2 = assembleTransitionChunk(step1.buffer, chunkFrame(parts[2], 2, 3, "t1"));
    expect(step2.message).toBe(full);
    expect(step2.buffer).toBeUndefined();
  });

  test("rejects a chunk that arrives out of order", () => {
    const step0 = assembleTransitionChunk(undefined, chunkFrame("a", 0, 2, "t1"));
    expect(() => assembleTransitionChunk(step0.buffer, chunkFrame("c", 2, 2, "t1"))).toThrow();
  });

  test("clears an incomplete chunk sequence when a whole message arrives", () => {
    const step0 = assembleTransitionChunk(undefined, chunkFrame("a", 0, 2, "t1"));
    const raw = '{"type":"Ping","note":"TransitionChunk"}';
    const step1 = assembleTransitionChunk(step0.buffer, raw);
    expect(step1).toEqual({ buffer: undefined, message: raw });
  });

  test("rejects chunks that do not assemble to a Transition", () => {
    expect(() =>
      assembleTransitionChunk(undefined, chunkFrame('{"type":"Ping"}', 0, 1, "t1")),
    ).toThrow(/expected Transition/);
  });

  test("rejects excessive chunk counts before retaining parts", () => {
    const limits = transportLimits({ messageBytes: 1_024, totalParts: 2 });
    expect(() => assembleTransitionChunk(undefined, chunkFrame("a", 0, 3, "t1"), limits)).toThrow(
      /input limit/,
    );
  });

  test("rejects a chunk sequence whose assembled bytes exceed the message ceiling", () => {
    const limits = transportLimits({ messageBytes: 180, totalParts: 4 });
    const step0 = assembleTransitionChunk(
      undefined,
      chunkFrame("a".repeat(70), 0, 4, "t1"),
      limits,
    );
    const step1 = assembleTransitionChunk(
      step0.buffer,
      chunkFrame("b".repeat(70), 1, 4, "t1"),
      limits,
    );
    expect(() =>
      assembleTransitionChunk(step1.buffer, chunkFrame("c".repeat(70), 2, 4, "t1"), limits),
    ).toThrow(/input limit/);
  });
});

describe("remote transport input limits", () => {
  test("closes on an inbox-byte burst before retaining the overflowing message", async () => {
    await withTransportSocket(async () => {
      const transport = createTestTransport(transportLimits({ inboxBytes: 80, inboxCount: 4 }));
      const connected = transport.connect({ url: "wss://example.convex.cloud" });
      const socket = TransportSocket.instances.at(-1)!;
      socket.open();
      await connected;
      const message = JSON.stringify({ payload: "x".repeat(45), type: "Ping" });

      socket.message(message);
      socket.message(message);

      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "closed",
        reason: "websocket transport input limit exceeded",
      });
      expect(socket.closed).toEqual({ code: 1009, reason: "invalid server message" });
    });
  });

  test("closes on an inbox-count burst and reconnects with empty accounting", async () => {
    await withTransportSocket(async () => {
      const transport = createTestTransport(transportLimits({ inboxCount: 2 }));
      const connected = transport.connect({ url: "wss://example.convex.cloud" });
      const socket = TransportSocket.instances.at(-1)!;
      socket.open();
      await connected;

      socket.message('{"type":"Ping","n":1}');
      socket.message('{"type":"Ping","n":2}');
      socket.message('{"type":"Ping","n":3}');

      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "closed",
        reason: "websocket transport input limit exceeded",
      });
      expect(socket.closed).toEqual({ code: 1009, reason: "invalid server message" });

      const reconnected = transport.connect({ url: "wss://example.convex.cloud" });
      const replacement = TransportSocket.instances.at(-1)!;
      replacement.open();
      await reconnected;
      const message = '{"type":"Ping","n":4}';
      replacement.message(message);
      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "message",
        message,
      });
      await transport.close();
    });
  });

  test("releases inbox bytes when messages are received", async () => {
    await withTransportSocket(async () => {
      const limits = transportLimits({ inboxBytes: 80, inboxCount: 4 });
      const transport = createTestTransport(limits);
      const connected = transport.connect({ url: "wss://example.convex.cloud" });
      const socket = TransportSocket.instances.at(-1)!;
      socket.open();
      await connected;
      const message = JSON.stringify({ payload: "x".repeat(45), type: "Ping" });

      socket.message(message);
      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "message",
        message,
      });
      socket.message(message);
      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "message",
        message,
      });
      expect(socket.closed).toBeUndefined();
      await transport.close();
    });
  });

  test("drops a partial chunk buffer after overflow before reconnecting", async () => {
    await withTransportSocket(async () => {
      const limits = transportLimits({ messageBytes: 180, totalParts: 4 });
      const transport = createTestTransport(limits);
      const connected = transport.connect({ url: "wss://example.convex.cloud" });
      const socket = TransportSocket.instances.at(-1)!;
      socket.open();
      await connected;

      socket.message(chunkFrame("a".repeat(70), 0, 4, "old"));
      socket.message(chunkFrame("b".repeat(70), 1, 4, "old"));
      socket.message(chunkFrame("c".repeat(70), 2, 4, "old"));

      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "closed",
        reason: "websocket transport input limit exceeded",
      });
      expect(socket.closed).toEqual({ code: 1009, reason: "invalid server message" });

      const reconnected = transport.connect({ url: "wss://example.convex.cloud" });
      const replacement = TransportSocket.instances.at(-1)!;
      replacement.open();
      await reconnected;
      const message = '{"type":"Transition","modifications":[]}';
      replacement.message(message);
      await expect(transport.receive({ timeoutMs: 0 })).resolves.toEqual({
        kind: "message",
        message,
      });
      await transport.close();
    });
  });
});

describe("remote tick activity", () => {
  test("derives post-turn response fences, idle state, status, and scheduling", () => {
    const empty = tick({}).pending!;
    const pending = { ...empty, scope: 1 };
    const cases: Array<{
      name: string;
      input: Parameters<typeof decideWorkerRemoteTurn>[0];
      expected: ReturnType<typeof decideWorkerRemoteTurn>;
    }> = [
      {
        name: "sleeps after a connected, drained turn",
        input: {
          active: false,
          awaitingResponse: false,
          connected: true,
          networkOnline: true,
          pending: empty,
          pullAttempted: 0,
          pushPending: false,
          pushUnblocked: false,
          sent: 0,
          wakePending: false,
        },
        expected: { awaitingResponse: false, idle: true, nextDelay: undefined, status: "idle" },
      },
      {
        name: "keeps a sent response alive while work remains",
        input: {
          active: false,
          awaitingResponse: false,
          connected: true,
          networkOnline: true,
          pending,
          pullAttempted: 0,
          pushPending: false,
          pushUnblocked: false,
          sent: 1,
          wakePending: false,
        },
        expected: { awaitingResponse: true, idle: false, nextDelay: 500, status: "tick" },
      },
      {
        name: "clears the response fence when an authoritative pull completes",
        input: {
          active: true,
          awaitingResponse: true,
          connected: true,
          networkOnline: true,
          pending,
          pullAttempted: 1,
          pushPending: false,
          pushUnblocked: false,
          sent: 1,
          wakePending: false,
        },
        expected: { awaitingResponse: false, idle: false, nextDelay: undefined, status: "tick" },
      },
      {
        name: "runs immediately for a queued wake",
        input: {
          active: false,
          awaitingResponse: false,
          connected: true,
          networkOnline: true,
          pending,
          pullAttempted: 0,
          pushPending: true,
          pushUnblocked: false,
          sent: 0,
          wakePending: true,
        },
        expected: { awaitingResponse: false, idle: false, nextDelay: 0, status: "tick" },
      },
      {
        name: "runs an unblocked retained push immediately",
        input: {
          active: false,
          awaitingResponse: false,
          connected: false,
          networkOnline: true,
          pending,
          pullAttempted: 0,
          pushPending: true,
          pushUnblocked: true,
          sent: 0,
          wakePending: false,
        },
        expected: { awaitingResponse: false, idle: false, nextDelay: 0, status: "starting" },
      },
    ];

    for (const { name, input, expected } of cases) {
      expect(decideWorkerRemoteTurn(input), name).toEqual(expected);
    }
  });

  test("every authoritative pending lane blocks convergence", () => {
    const empty = tick({}).pending!;
    expect(remotePendingIsEmpty(empty)).toBe(true);
    expect(remotePendingIsEmpty(undefined)).toBe(false);
    for (const lane of Object.keys(empty) as Array<keyof typeof empty>) {
      expect(remotePendingIsEmpty({ ...empty, [lane]: 1 })).toBe(false);
    }
  });

  test("late socket events cannot mutate a newer remote generation", () => {
    const events: EmbeddedEvent[] = [];
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      remoteEventGeneration: 2,
      remoteEventSequence: 0,
    } as unknown as WorkerState;

    writeWorkerRemoteConnection(state, false, 1);
    expect(state.remoteConnected).toBe(true);
    expect(events).toEqual([]);

    writeWorkerRemoteConnection(state, false, 2);
    expect(state.remoteConnected).toBe(false);
    expect(events.at(-1)).toMatchObject({ generation: 2, sequence: 1, status: "offline" });
  });

  test("a failed actor turn always clears the recovery in-flight fence", async () => {
    const lifecycle: string[] = [];
    const state = {
      recovery: {
        arm: () => () => undefined,
        get remoteGeneration() {
          return 0;
        },
        onRemoteActive: () => lifecycle.push("active"),
        onRemoteIdle: () => lifecycle.push("idle"),
        onRemoteSettled: () => lifecycle.push("settled"),
        progress: () => undefined,
      },
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => Promise.reject(new Error("network turn failed")),
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();

    expect(lifecycle).toEqual(["active", "settled"]);
  });

  test("network loss invalidates and breaks the active socket before reconnect wake", () => {
    const events: EmbeddedEvent[] = [];
    let closes = 0;
    const wakes: boolean[] = [];
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      remoteNetworkOnline: true,
      remoteTransport: { close: async () => void (closes += 1) },
      remoteWake: (immediate: boolean) => void wakes.push(immediate),
    } as unknown as WorkerState;

    writeWorkerRemoteNetwork(state, false);
    writeWorkerRemoteNetwork(state, true);

    expect(closes).toBe(1);
    expect(state.remoteConnected).toBe(false);
    expect(wakes).toEqual([false, true]);
    expect(events).toEqual([
      expect.objectContaining({ status: "offline", type: "remote" }),
      expect.objectContaining({ status: "starting", type: "remote" }),
    ]);
  });

  test("defers a startup transport break until the actor wake exists", () => {
    const events: EmbeddedEvent[] = [];
    let closes = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteTransport: { close: async () => void (closes += 1) },
    } as unknown as WorkerState;

    writeWorkerRemoteNetwork(state, false);
    writeWorkerRemoteNetwork(state, true);

    expect(closes).toBe(0);
    expect(state.remoteReconnectRequired).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: "starting", type: "remote" });
  });

  test("offline then online cannot idle until a fresh generation connects", async () => {
    const events: EmbeddedEvent[] = [];
    let closes = 0;
    let releaseFirstPull!: () => void;
    let pulls = 0;
    const firstPull = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      remoteEventGeneration: 7,
      remoteEventSequence: 0,
      remoteNetworkOnline: true,
      remoteTransport: { close: async () => void (closes += 1) },
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            if (pulls === 1) await firstPull;
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(
      state,
      () => undefined,
      () => undefined,
      7,
    );
    await Promise.resolve();
    writeWorkerRemoteNetwork(state, false);
    writeWorkerRemoteNetwork(state, true);
    releaseFirstPull();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(closes).toBe(1);
    expect(state.remoteConnected).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ status: "offline" }));
    expect(events).toContainEqual(expect.objectContaining({ status: "starting" }));
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle" }));

    writeWorkerRemoteConnection(state, true, 6);
    state.remoteWake?.(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.remoteConnected).toBe(false);
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle" }));

    writeWorkerRemoteConnection(state, true, 7);
    state.remoteWake?.(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(events).toContainEqual(expect.objectContaining({ status: "connected" }));
    expect(events).toContainEqual(expect.objectContaining({ status: "idle" }));
  });

  test("an online hint clears a failed pull backoff immediately", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: false,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            if (pulls === 1) throw new Error("network unavailable");
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const failedDeadline = getTimerTime() + 1_000;
    while (
      !events.some(
        (event) =>
          event.type === "remote" &&
          event.status === "starting" &&
          event.error === "network unavailable",
      )
    ) {
      if (getTimerTime() >= failedDeadline) throw new Error("first pull did not fail");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    writeWorkerRemoteNetwork(state, true);
    const reconnectDeadline = getTimerTime() + 250;
    while (pulls < 2 && getTimerTime() < reconnectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toBe(2);
  });

  test("never reports idle while the transport is disconnected", async () => {
    const events: EmbeddedEvent[] = [];
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: false,
      runner: { subscribeEvents: () => () => undefined },
      store: { remote: { pull: async () => tick({ pullAttempted: 0 }) } },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(events).toContainEqual(expect.objectContaining({ status: "starting", type: "remote" }));
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("the remote scheduler makes no attempts while offline and resumes on the online wake", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      remoteNetworkOnline: false,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.remoteWake?.(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pulls).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));

    writeWorkerRemoteNetwork(state, true);
    const resumedDeadline = getTimerTime() + 250;
    while (pulls === 0 && getTimerTime() < resumedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toBe(1);
  });

  test("a turn that fails after an offline hint stays dormant and publicly offline", async () => {
    const events: EmbeddedEvent[] = [];
    let rejectPull: ((error: Error) => void) | undefined;
    let pulls = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      remoteNetworkOnline: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            if (pulls > 1) return tick({ pullAttempted: 0 });
            return await new Promise<RemoteTick>((_resolve, reject) => {
              rejectPull = reject;
            });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    while (pulls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    writeWorkerRemoteNetwork(state, false);
    const offlineEventIndex = events.length - 1;
    rejectPull?.(new Error("network unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pulls).toBe(1);
    expect(events.at(-1)).toMatchObject({
      error: "network unavailable",
      status: "offline",
      type: "remote",
    });
    expect(
      events
        .slice(offlineEventIndex)
        .some((event) => event.type === "remote" && event.status === "starting"),
    ).toBe(false);

    writeWorkerRemoteNetwork(state, true);
    const resumedDeadline = getTimerTime() + 250;
    while (pulls < 2 && getTimerTime() < resumedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toBe(2);
  });

  test("repeated stale connection callbacks do not churn socket close while offline", () => {
    let closes = 0;
    const state = {
      remoteEventGeneration: 4,
      remoteNetworkOnline: true,
      remoteTransport: { close: async () => void (closes += 1) },
      remoteWake: () => undefined,
    } as unknown as WorkerState;

    writeWorkerRemoteNetwork(state, false);
    writeWorkerRemoteConnection(state, true, 4);
    writeWorkerRemoteConnection(state, true, 4);

    expect(closes).toBe(1);
    expect(state.remoteConnected).toBe(false);
    expect(state.remoteReconnectRequired).toBe(true);
  });

  test("does not report synced after a permanent pull diagnostic", async () => {
    const events: EmbeddedEvent[] = [];
    let pull = 0;
    let wake: (() => void) | undefined;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: {
        remote: {
          wake: {
            subscribe: (listener: () => void) => {
              wake = listener;
              return () => undefined;
            },
          },
        },
        subscribeEvents: () => () => undefined,
      },
      store: {
        remote: {
          pull: async () => {
            pull += 1;
            if (pull === 1)
              return tick({ connected: true, pullDiagnostics: 1, pullError: "apply failed" });
            if (pull === 2) return tick({ pullAttempted: 0 });
            if (pull === 3) return tick({ pullSnapshots: 1 });
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const firstDeadline = getTimerTime() + 1_000;
    while (!events.some((event) => event.type === "remote" && event.status === "error")) {
      if (getTimerTime() >= firstDeadline) throw new Error("pull diagnostic was not surfaced");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    wake?.();
    while (
      events.filter((event) => event.type === "remote" && event.status === "error").length < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events.at(-1)).toMatchObject({ status: "error", type: "remote" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    wake?.();
    const snapshotDeadline = getTimerTime() + 1_000;
    while (!events.some((event) => event.type === "remote" && event.status === "tick")) {
      if (getTimerTime() >= snapshotDeadline) throw new Error("successful snapshot did not apply");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();
  });

  test("serializes push before pull and reports idle only after the whole turn", async () => {
    const events: EmbeddedEvent[] = [];
    let finishPull: ((value: RemoteTick) => void) | undefined;
    let firstPull = true;
    let pushes = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
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
            if (!firstPull) return tick({ pullAttempted: 0 });
            firstPull = false;
            return await new Promise<RemoteTick>((resolve) => {
              finishPull = resolve;
            });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const pushDeadline = getTimerTime() + 1_000;
    while (pushes < 1 && getTimerTime() < pushDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pushes).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));

    finishPull?.(tick({ pullAttempted: 0 }));
    const idleDeadline = getTimerTime() + 1_000;
    while (!events.some((event) => event.type === "remote" && event.status === "idle")) {
      if (getTimerTime() >= idleDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("continues draining after transport ingress", () => {
    expect(remoteTickHasWork(tick({ received: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ sent: 4, storeJobs: 6 }))).toBe(true);
  });

  test("keeps the latest explicit connectivity transition when ticks merge", () => {
    expect(mergeRemoteTicks(tick({ connected: true }), tick({ connected: false })).connected).toBe(
      false,
    );
    expect(mergeRemoteTicks(tick({ connected: false }), tick({})).connected).toBe(false);
  });

  test("keeps application and replication progress active", () => {
    expect(remoteTickHasWork(tick({ rowsApplied: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ pushAccepted: 1 }))).toBe(true);
    expect(remoteTickHasWork(tick({ changedTables: ["documents"] }))).toBe(true);
  });

  test("waits for transport ingress after the actor owns a blocked backlog", async () => {
    const events: EmbeddedEvent[] = [];
    let pushes = 0;
    const blocked = {
      checkpoints: 0,
      inflight: 1,
      mutations: 1,
      scope: 0,
      settlements: 0,
      uploads: 0,
    };
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return {
                state: "blocked",
                tick: tick({
                  pending: blocked,
                  pullAttempted: 0,
                  pushAccepted: 1,
                  pushAttempted: 1,
                }),
              };
            },
          },
          pull: async () => tick({ pending: blocked, pullAttempted: 0 }),
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(pushes).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("retains a blocked offline replay without polling non-progress ingress", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    let pushes = 0;
    const blocked = {
      checkpoints: 0,
      inflight: 0,
      mutations: 1,
      scope: 0,
      settlements: 0,
      uploads: 0,
    };
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return pushes === 1
                ? {
                    state: "blocked" as const,
                    tick: tick({ pending: blocked, pullAttempted: 0 }),
                  }
                : {
                    state: "settled" as const,
                    tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
                  };
            },
          },
          pull: async () => {
            pulls += 1;
            return pulls === 1
              ? tick({ pending: blocked, pullAttempted: 0, received: 1 })
              : tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(pushes).toBe(1);
    expect(pulls).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));

    state.remoteWake?.();
    const deadline = getTimerTime() + 1_000;
    while (pushes < 2 && getTimerTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(2);
    expect(pulls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("clears a retained blocked backlog after every pending lane drains", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    let pushes = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          doc: {
            push: async () => {
              pushes += 1;
              return {
                state: "blocked" as const,
                tick: tick({
                  pending: {
                    checkpoints: 0,
                    inflight: 1,
                    mutations: 1,
                    scope: 0,
                    settlements: 0,
                    uploads: 0,
                  },
                  pullAttempted: 0,
                  pushAttempted: 1,
                }),
              };
            },
          },
          pull: async () => {
            pulls += 1;
            return tick({ pullAttempted: 0, received: 1, rowsApplied: 1 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const deadline = getTimerTime() + 1_000;
    while (!events.some((event) => event.type === "remote" && event.status === "idle")) {
      if (getTimerTime() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(1);
    expect(pulls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("does not clear a concrete local push token with an older drained snapshot", async () => {
    const events: EmbeddedEvent[] = [];
    let listener: ((event: EmbeddedEvent) => void) | undefined;
    let finishFirstPull: ((tick: RemoteTick) => void) | undefined;
    let pulls = 0;
    let pushes = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
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
                state: pushes === 1 ? ("blocked" as const) : ("settled" as const),
                tick: tick({ pullAttempted: 0 }),
              };
            },
          },
          pull: async () => {
            pulls += 1;
            if (pulls > 1) return tick({ pullAttempted: 0 });
            return await new Promise<RemoteTick>((resolve) => {
              finishFirstPull = resolve;
            });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const firstPullDeadline = getTimerTime() + 1_000;
    while (!finishFirstPull && getTimerTime() < firstPullDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    listener?.({
      at: 0,
      changedTables: ["documents"],
      commitSeq: 2,
      deletes: [],
      source: "local",
      type: "data",
      docWrites: [{ id: "row", row: {}, table: "documents" }],
    });
    finishFirstPull?.(tick({ pullAttempted: 0 }));
    const retryDeadline = getTimerTime() + 1_000;
    while (pushes < 2 && getTimerTime() < retryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(2);
    expect(pulls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("gives a local mutation directly to the foreground push owner", async () => {
    let listener: ((event: EmbeddedEvent) => void) | undefined;
    let pulls = 0;
    let pushes = 0;
    const turns: string[] = [];
    const state = {
      remoteConnected: true,
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
              turns.push("push");
              return {
                state: "settled" as const,
                tick: tick({ pullAttempted: 0, pushAccepted: 1, pushAttempted: 1 }),
              };
            },
          },
          pull: async () => {
            pulls += 1;
            turns.push("pull");
            return tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pullsBeforeMutation = pulls;
    const turnsBeforeMutation = turns.length;
    listener?.({
      at: 0,
      changedTables: ["documents"],
      commitSeq: 1,
      deletes: [],
      source: "local",
      type: "data",
      docWrites: [{ id: "document", row: {}, table: "documents" }],
    });
    const deadline = getTimerTime() + 1_000;
    while ((pushes < 2 || pulls <= pullsBeforeMutation) && getTimerTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pushes).toBe(2);
    expect(pulls).toBe(pullsBeforeMutation + 1);
    expect(turns.slice(turnsBeforeMutation)).toEqual(["push", "pull"]);
  });

  test("replays a durable mutation envelope without row changes", async () => {
    let wakeRemote: (() => void) | undefined;
    let pushes = 0;
    const state = {
      remoteConnected: true,
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
    const deadline = getTimerTime() + 1_000;
    while (pushes === pushesBeforeWake && getTimerTime() < deadline) {
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
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: { remote },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const idlePulls = pulls;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(pulls).toBe(idlePulls);

    await remote.scope.write({ subscriptions: [] });
    const deadline = getTimerTime() + 1_000;
    while (pulls === idlePulls && getTimerTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toBe(idlePulls + 1);
  });

  test("keeps polling while a sent response is outstanding and sleeps once it arrives", async () => {
    let pulls = 0;
    let responded = false;
    const state = {
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            return responded
              ? tick({ pullAttempted: 0, received: 1 })
              : tick({
                  pending: {
                    checkpoints: 0,
                    inflight: 0,
                    mutations: 0,
                    scope: 1,
                    settlements: 0,
                    uploads: 0,
                  },
                  pullAttempted: 0,
                  sent: 1,
                });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const awaitingDeadline = getTimerTime() + 2_000;
    while (pulls < 3 && getTimerTime() < awaitingDeadline) {
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

  test("settles when subscription send and authoritative pull complete in one actor turn", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            return pulls === 1
              ? tick({ pullAttempted: 1, received: 1, sent: 1 })
              : tick({ pullAttempted: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 800));
    stop();

    expect(pulls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("an empty pending snapshot clears an obsolete response keepalive", async () => {
    const events: EmbeddedEvent[] = [];
    let pulls = 0;
    const state = {
      emit: (event: EmbeddedEvent) => events.push(event),
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async () => {
            pulls += 1;
            return tick({ pullAttempted: 0, sent: 1 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    await new Promise((resolve) => setTimeout(resolve, 800));
    stop();

    expect(pulls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ status: "idle", type: "remote" }));
  });

  test("does not turn drained websocket ingress into a pull poll", async () => {
    const pulls: Array<boolean | undefined> = [];
    const state = {
      remoteConnected: true,
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
    const deadline = getTimerTime() + 1_000;
    while (pulls.length < 2 && getTimerTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();

    expect(pulls).toEqual([true, false]);
  });

  test("keeps polling while a multi-page checkpoint response stays outstanding", async () => {
    const pulls: Array<boolean | undefined> = [];
    let remaining = 2;
    const state = {
      remoteConnected: true,
      runner: { subscribeEvents: () => () => undefined },
      store: {
        remote: {
          pull: async (localProgress?: boolean) => {
            pulls.push(localProgress);
            if (remaining > 0) {
              remaining -= 1;
              return tick({
                pending: {
                  checkpoints: 0,
                  inflight: 0,
                  mutations: 0,
                  scope: 1,
                  settlements: 0,
                  uploads: 0,
                },
                pullAttempted: 0,
                received: 1,
                sent: 1,
              });
            }
            return tick({ pullAttempted: 0, received: 1, sent: 0 });
          },
        },
      },
    } as unknown as WorkerState;

    const stop = startWorkerRemoteLoop(state);
    const deadline = getTimerTime() + 3_000;
    while (pulls.length < 3 && getTimerTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const settled = pulls.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    stop();

    expect(settled).toBe(3);
    expect(pulls).toEqual([true, false, false]);
    expect(pulls.length).toBe(settled);
  });

  test("probes durable uploads only after local upload progress", async () => {
    let listener: ((event: EmbeddedEvent) => void) | undefined;
    const pulls: Array<boolean | undefined> = [];
    const state = {
      remoteConnected: true,
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
      docWrites: [],
    });
    const deadline = getTimerTime() + 1_000;
    while (pulls.length < 2 && getTimerTime() < deadline) {
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
      remoteConnected: true,
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
      remoteConnected: true,
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
    const deadline = getTimerTime() + 1_000;
    while (pushAuthors.length < 1 && getTimerTime() < deadline) {
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
      remoteConnected: true,
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
      remoteConnected: true,
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
