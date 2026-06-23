import { describe, expect, test } from "vite-plus/test";

import {
  assertSameRuntimeIdentity,
  createRuntimeIdentity,
  runtimeScope,
  setEmbeddedIdentity,
} from "../../src/browser/identity";
import { WASM_API_VERSION } from "../../src/browser/artifact";
import { EMBEDDED_STORE_FORMAT_VERSION } from "../../src/abi";
import { getTimerTime } from "../../src/time";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import {
  WorkerCommand,
  WorkerEvent,
  type RuntimeIdentity,
  type WorkerResponse,
} from "../../src/browser/protocol";
import { createCoordinatorRuntime } from "../../src/browser/coordinator";
import {
  attachFollower,
  LeaderRuntime,
  type LeaderState,
} from "../../src/browser/coordinator/leader";
import type { WorkerState } from "../../src/browser/runtime";
import {
  controlChannelName,
  CoordinatorProtocol,
  PeerOp,
  RejectCode,
  type BroadcastChannelLike,
  type LockManagerLike,
  type PeerMessage,
  workerChannelName,
} from "../../src/browser/coordinator/protocol";

describe("browser deployment coordination", () => {
  test("failed identity negotiation resets replication before another remote turn", async () => {
    const responses: WorkerResponse[] = [];
    let resets = 0;
    const runtime = {
      opfs: { closeAll: () => undefined },
      remoteReset: async () => {
        resets += 1;
      },
      runner: {
        remote: {
          identity: { read: async () => Promise.reject(new Error("offline")) },
          scope: { write: async () => undefined },
        },
        subscribeEvents: () => () => undefined,
      },
      stops: new Map(),
      store: { close: async () => undefined, remote: { close: async () => undefined } },
    } as unknown as WorkerState;
    const leader = new LeaderRuntime({
      epoch: "leader",
      identity: identity(),
      runtime,
      scope: runtimeScope(identity()),
      storagePath: "documents.db",
    });
    const client = {
      activeMutations: 0,
      id: "client",
      post: (response: WorkerResponse) => responses.push(response),
      remoteConfigured: true,
      watches: new Map(),
      workerId: "worker",
    };

    await leader.handle(client, {
      clientId: "client",
      id: 1,
      op: WorkerCommand.RemoteIdentityRead,
    });

    expect(resets).toBe(1);
    expect(result(responses, 1)?.error?.message).toBe("offline");
    await leader.close();
  });

  test("acknowledges local readiness while remote startup remains pending", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const responses: WorkerResponse[] = [];
    let acceptInit: (() => void) | undefined;
    const initAccepted = new Promise<void>((resolve) => {
      acceptInit = resolve;
    });
    const runtime = createCoordinatorRuntime(
      {
        clientId: "client",
        id: 1,
        identity: identity(),
        op: WorkerCommand.Init,
        remote: {
          authFetchToken: false,
          clientId: "client",
          moduleGraphHash: "modules",
          protocolVersion: EMBEDDED_PROTOCOL_VERSION,
          schemaHash: "schema",
          url: "https://pending.convex.cloud",
        },
        storagePath: "documents.db",
      },
      {
        assertCapabilities: () => undefined,
        channels: { open: () => recordingChannel([]) },
        closeSelf: () => undefined,
        locks: {
          request: async (_name, callback) => await callback(),
        },
        openRuntime: async () => pendingRemoteRuntime(),
        postLocal: (response) => {
          responses.push(response);
          if (response.op === WorkerEvent.Result && response.id === 1) acceptInit?.();
        },
        randomId: (prefix) => `${prefix}-fixed`,
      },
    );

    const started = runtime.start();
    await initAccepted;

    expect(responses).toContainEqual({ id: 1, op: WorkerEvent.Result });
    await started;
    await runtime.close();
  });

  test("discovers every deployment that owns the same browser storage", () => {
    const oldIdentity = identity({ moduleGraphHash: "old", packageVersion: "1.0.0" });
    const newIdentity = identity({ moduleGraphHash: "new", packageVersion: "2.0.0" });

    expect(runtimeScope(oldIdentity)).not.toBe(runtimeScope(newIdentity));
    expect(controlChannelName(oldIdentity.storageId)).toBe(
      controlChannelName(newIdentity.storageId),
    );
  });

  test("runtime identity carries the local store format version", () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    expect(createRuntimeIdentity("documents").storeFormatVersion).toBe(
      EMBEDDED_STORE_FORMAT_VERSION,
    );
  });

  test("a store format version mismatch surfaces as a runtime identity mismatch", () => {
    expect(() =>
      assertSameRuntimeIdentity(identity({ storeFormatVersion: 40 }), identity()),
    ).toThrow(/store format/);
  });

  test("rejects a different deployment and notifies clients of the existing owner", () => {
    const oldIdentity = identity({ moduleGraphHash: "old" });
    const newIdentity = identity({ moduleGraphHash: "new" });
    const ownerMessages: WorkerResponse[] = [];
    const followerMessages: PeerMessage[] = [];
    const leader = {
      clients: new Map([
        [
          "owner",
          {
            activeMutations: 0,
            id: "owner",
            post: (message: WorkerResponse) => ownerMessages.push(message),
            remoteConfigured: false,
            watches: new Map(),
            workerId: "worker-old",
          },
        ],
      ]),
      followers: new Map(),
      identity: oldIdentity,
      leaderEpoch: "leader-old",
      scope: runtimeScope(oldIdentity),
      storagePath: "convex-embedded-documents.db",
    } as unknown as LeaderState;
    const channel = recordingChannel(followerMessages);
    let openedChannel: string | undefined;

    attachFollower(
      leader,
      {
        clientId: "client-new",
        identity: newIdentity,
        op: PeerOp.Attach,
        protocol: CoordinatorProtocol,
        scope: runtimeScope(newIdentity),
        storagePath: leader.storagePath,
        workerId: "worker-new",
      },
      (name) => {
        openedChannel = name;
        return channel;
      },
      () => undefined,
    );

    expect(followerMessages).toEqual([
      expect.objectContaining({
        code: RejectCode.DeploymentMismatch,
        error: expect.objectContaining({
          message: expect.stringContaining("Close or reload all tabs"),
          name: "ConvexEmbeddedDeploymentMismatchError",
        }),
        op: PeerOp.Rejected,
      }),
    ]);
    expect(openedChannel).toBe(workerChannelName(runtimeScope(newIdentity), "worker-new"));
    expect(ownerMessages).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          degradation: "deployment-mismatch",
          error: expect.stringContaining("different version"),
          type: "runtime",
        }),
      }),
    ]);
  });

  test("promotes one follower and replays an unresolved request after leader death", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const channels = new ChannelBus();
    const locks = new LockQueue();
    const opened: string[] = [];
    const closed: string[] = [];
    let firstQueries = 0;
    const firstQuery = deferred<unknown>();
    const firstClose = deferred<void>();
    const firstResponses: WorkerResponse[] = [];
    const secondResponses: WorkerResponse[] = [];

    const first = coordinator("first", firstResponses, {
      channels,
      locks,
      openRuntime: async () => {
        opened.push("first");
        return testRuntime(
          "first",
          closed,
          () => {
            firstQueries += 1;
            return firstQuery.promise;
          },
          undefined,
          firstClose.promise,
        );
      },
    });
    const second = coordinator("second", secondResponses, {
      channels,
      locks,
      openRuntime: async () => {
        opened.push("second");
        return testRuntime("second", closed, async () => "second-result");
      },
    });

    await first.start();
    await second.start();
    expect(opened).toEqual(["first"]);

    second.handle({
      args: {},
      clientId: "second",
      id: 2,
      name: "documents:get",
      op: WorkerCommand.Query,
    });
    await waitUntil(() => firstQueries === 1);
    expect(opened).toEqual(["first"]);

    const closeFirst = first.close();
    await Promise.resolve();
    expect(opened).toEqual(["first"]);
    firstClose.resolve();
    await closeFirst;
    await waitUntil(() => opened.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResponses).toContainEqual({
      id: 2,
      op: WorkerEvent.Result,
      result: "second-result",
    });
    expect(opened).toEqual(["first", "second"]);
    expect(closed).toEqual(["first"]);

    firstQuery.resolve("late-first-result");
    await Promise.resolve();
    expect(result(secondResponses, 2)?.result).toBe("second-result");
    expect(
      secondResponses.filter((response) => response.op === WorkerEvent.Result && response.id === 2),
    ).toHaveLength(1);

    await second.close();
    expect(closed).toEqual(["first", "second"]);
  });

  test("does not repeat a hosted action after leader death loses its result", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const channels = new ChannelBus();
    const locks = new LockQueue();
    const opened: string[] = [];
    const closed: string[] = [];
    const action = deferred<unknown>();
    let firstActions = 0;
    let secondActions = 0;
    const firstResponses: WorkerResponse[] = [];
    const secondResponses: WorkerResponse[] = [];
    const first = coordinator("first-action", firstResponses, {
      channels,
      locks,
      openRuntime: async () => {
        opened.push("first");
        return testRuntime(
          "first",
          closed,
          async () => null,
          () => {
            firstActions += 1;
            return action.promise;
          },
        );
      },
    });
    const second = coordinator("second-action", secondResponses, {
      channels,
      locks,
      openRuntime: async () => {
        opened.push("second");
        return testRuntime(
          "second",
          closed,
          async () => null,
          async () => {
            secondActions += 1;
            return null;
          },
        );
      },
    });

    await first.start();
    await second.start();
    second.handle({
      args: {},
      clientId: "second-action",
      id: 2,
      kind: "action",
      name: "email:send",
      op: WorkerCommand.Route,
    });
    await waitUntil(() => firstActions === 1);

    await first.close();
    await waitUntil(() => opened.length === 2);
    await waitUntil(() => result(secondResponses, 2)?.error !== undefined);
    expect(result(secondResponses, 2)?.error?.name).toBe(
      "ConvexEmbeddedOperationIndeterminateError",
    );
    expect(secondActions).toBe(0);

    action.resolve("late-action-result");
    await Promise.resolve();
    expect(secondActions).toBe(0);
    await second.close();
  });
});

function coordinator(
  workerId: string,
  responses: WorkerResponse[],
  options: {
    channels: ChannelBus;
    locks: LockQueue;
    openRuntime: () => Promise<WorkerState>;
  },
) {
  return createCoordinatorRuntime(
    {
      clientId: workerId,
      id: 1,
      identity: identity(),
      op: WorkerCommand.Init,
      storagePath: "documents.db",
    },
    {
      assertCapabilities: () => undefined,
      channels: { open: (name) => options.channels.open(name) },
      clearTimer: clearTimeout,
      closeSelf: () => undefined,
      locks: options.locks,
      openRuntime: options.openRuntime,
      postLocal: (response) => responses.push(response),
      randomId: (prefix) => `${prefix}-${workerId}`,
      setTimer: setTimeout,
      timeouts: {
        attachTimeoutMs: 100,
        forwardAckTimeoutMs: 100,
        helloIntervalMs: 1,
        leaderRecoveryTimeoutMs: 100,
      },
    },
  );
}

function testRuntime(
  name: string,
  closed: string[],
  runQuery: () => Promise<unknown>,
  route: () => Promise<unknown> = runQuery,
  closeReady: Promise<void> = Promise.resolve(),
): WorkerState {
  return {
    closed: false,
    opfs: { closeAll: () => undefined },
    runner: {
      runQuery,
      route,
      subscribeEvents: () => () => undefined,
    },
    stops: new Map(),
    store: {
      close: async () => {
        await closeReady;
        closed.push(name);
      },
    },
  } as unknown as WorkerState;
}

function result(
  responses: WorkerResponse[],
  id: number,
): Extract<WorkerResponse, { op: typeof WorkerEvent.Result }> | undefined {
  return responses.find(
    (response): response is Extract<WorkerResponse, { op: typeof WorkerEvent.Result }> =>
      response.op === WorkerEvent.Result && response.id === id,
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = getTimerTime() + 2_000;
  while (!predicate()) {
    if (getTimerTime() >= deadline) throw new Error("Timed out waiting for coordinator state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class ChannelBus {
  private readonly channels = new Map<string, Set<ChannelEndpoint>>();

  open(name: string): BroadcastChannelLike {
    const endpoint = new ChannelEndpoint(name, this);
    const channels = this.channels.get(name) ?? new Set();
    channels.add(endpoint);
    this.channels.set(name, channels);
    return endpoint;
  }

  close(endpoint: ChannelEndpoint): void {
    this.channels.get(endpoint.name)?.delete(endpoint);
  }

  send(sender: ChannelEndpoint, message: unknown): void {
    for (const endpoint of this.channels.get(sender.name) ?? []) {
      if (endpoint !== sender) endpoint.receive(message);
    }
  }
}

class ChannelEndpoint implements BroadcastChannelLike {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  constructor(
    readonly name: string,
    private readonly bus: ChannelBus,
  ) {}

  addEventListener(_type: "message", callback: (event: { data: unknown }) => void): void {
    this.listeners.add(callback);
  }

  close(): void {
    this.bus.close(this);
    this.listeners.clear();
  }

  postMessage(message: unknown): void {
    this.bus.send(this, message);
  }

  receive(message: unknown): void {
    for (const listener of this.listeners) listener({ data: message });
  }

  removeEventListener(_type: "message", callback: (event: { data: unknown }) => void): void {
    this.listeners.delete(callback);
  }
}

class LockQueue implements LockManagerLike {
  private readonly queues = new Map<
    string,
    Array<{
      callback: () => unknown;
      reject: (error: unknown) => void;
      resolve: (value: unknown) => void;
    }>
  >();

  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      queue.push({ callback, reject, resolve: resolve as (value: unknown) => void });
      this.queues.set(name, queue);
      if (queue.length === 1) void this.run(name, queue[0]!);
    });
  }

  private async run(
    name: string,
    entry: {
      callback: () => unknown;
      reject: (error: unknown) => void;
      resolve: (value: unknown) => void;
    },
  ): Promise<void> {
    try {
      entry.resolve(await entry.callback());
    } catch (error) {
      entry.reject(error);
    } finally {
      const queue = this.queues.get(name);
      queue?.shift();
      if (!queue?.length) this.queues.delete(name);
      else void this.run(name, queue[0]!);
    }
  }
}

function pendingRemoteRuntime(): WorkerState {
  return {
    opfs: { closeAll: () => undefined },
    remoteReady: new Promise<void>(() => undefined),
    runner: { subscribeEvents: () => () => undefined },
    stops: new Map(),
    store: {
      close: async () => undefined,
      remote: { close: async () => undefined },
    },
  } as unknown as WorkerState;
}

function identity(overrides: Partial<RuntimeIdentity> = {}): RuntimeIdentity {
  return {
    moduleGraphHash: "modules",
    packageVersion: "0.0.0",
    protocolVersion: EMBEDDED_PROTOCOL_VERSION,
    schemaHash: "schema",
    storageId: "documents",
    storeFormatVersion: EMBEDDED_STORE_FORMAT_VERSION,
    wasmAbiVersion: WASM_API_VERSION,
    ...overrides,
  };
}

function recordingChannel(messages: PeerMessage[]): BroadcastChannelLike {
  return {
    addEventListener: () => undefined,
    close: () => undefined,
    postMessage: (message) => messages.push(message as PeerMessage),
    removeEventListener: () => undefined,
  };
}
