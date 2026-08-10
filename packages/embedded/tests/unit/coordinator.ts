import { describe, expect, test } from "vite-plus/test";

import {
  assertSameRuntimeIdentity,
  createRuntimeIdentity,
  runtimeScope,
  setEmbeddedIdentity,
} from "../../src/browser/identity";
import { CURRENT_STORAGE_BINDING_CONTRACT_ID } from "../../src/storage/contract";
import { EMBEDDED_STORE_EPOCH } from "../../src/abi";
import { getTimerTime } from "../../src/time";
import { EmbeddedClient } from "../../src/client";
import type { DiagnosticEvent as EmbeddedEvent } from "../../src/events";
import { CURRENT_WIRE_CONTRACT_ID } from "../../src/protocol";
import type { Runner } from "../../src/runtime/runner";
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
  ControlOp,
  BrowserCoordinationContractId,
  isForeignCoordinationFrame,
  PeerOp,
  RejectCode,
  type BroadcastChannelLike,
  type LockManagerLike,
  type PeerMessage,
  workerChannelName,
} from "../../src/browser/coordinator/protocol";

describe("browser deployment coordination", () => {
  test("fails closed for any private coordination operation without this contract", () => {
    for (const op of [...Object.values(ControlOp), ...Object.values(PeerOp)]) {
      expect(isForeignCoordinationFrame({ op })).toBe(true);
      expect(isForeignCoordinationFrame({ coordinationId: "sha256:old", op })).toBe(true);
      expect(isForeignCoordinationFrame({ coordinationId: 1, op })).toBe(true);
    }
    expect(isForeignCoordinationFrame({ op: 999 })).toBe(true);
    expect(isForeignCoordinationFrame({ type: "unrelated" })).toBe(false);
    expect(
      isForeignCoordinationFrame({
        coordinationId: BrowserCoordinationContractId,
        op: PeerOp.Attach,
      }),
    ).toBe(false);
  });

  test("opens storage only after the page grants ownership", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const responses: WorkerResponse[] = [];
    let opens = 0;
    const runtime = createCoordinatorRuntime(
      {
        clientId: "follower",
        id: 1,
        identity: identity(),
        op: WorkerCommand.Init,
        storagePath: "documents.db",
        storageOwner: false,
      },
      {
        assertCapabilities: () => undefined,
        channels: { open: () => recordingChannel([]) },
        closeSelf: () => undefined,
        locks: {
          request: async (_name, callback) => await callback(),
        },
        openRuntime: async () => {
          opens += 1;
          return pendingRemoteRuntime();
        },
        postLocal: (response) => responses.push(response),
        randomId: (prefix) => `${prefix}-follower`,
      },
    );

    const started = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opens).toBe(0);
    runtime.handle({ id: 2, op: WorkerCommand.StorageOwnerWrite });
    await started;

    expect(result(responses, 1)).toEqual({ id: 1, op: WorkerEvent.Result });
    await waitUntil(() => result(responses, 2) !== undefined);
    expect(result(responses, 2)).toEqual({ id: 2, op: WorkerEvent.Result });
    expect(opens).toBe(1);
    await runtime.close();
  });

  test("cleans an opened runtime when durable fence allocation fails", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const responses: WorkerResponse[] = [];
    const closed: string[] = [];
    const runtime = createCoordinatorRuntime(
      {
        clientId: "owner",
        id: 1,
        identity: identity(),
        op: WorkerCommand.Init,
        storagePath: "documents.db",
        storageOwner: true,
      },
      {
        assertCapabilities: () => undefined,
        channels: { open: () => recordingChannel([]) },
        closeSelf: () => undefined,
        locks: { request: async (_name, callback) => await callback() },
        openRuntime: async () =>
          ({
            opfs: { closeAll: () => closed.push("opfs") },
            pthreads: { terminateAll: () => closed.push("pthreads") },
            runner: { subscribeEvents: () => () => undefined },
            stops: new Map(),
            store: {
              close: async () => closed.push("store"),
              remote: { close: async () => closed.push("remote") },
            },
          }) as unknown as WorkerState,
        postLocal: (response) => responses.push(response),
        randomId: (prefix) => `${prefix}-owner`,
      },
    );

    await runtime.start();

    expect(result(responses, 1)?.error?.message).toContain("durable leader fencing");
    expect(closed).toEqual(["remote", "store", "pthreads", "opfs"]);
  });

  test("acknowledges close only after the storage runtime has closed", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const responses: WorkerResponse[] = [];
    const closed: string[] = [];
    const closeReady = deferred<void>();
    let workerClosed = false;
    const runtime = createCoordinatorRuntime(
      {
        clientId: "owner",
        id: 1,
        identity: identity(),
        op: WorkerCommand.Init,
        storagePath: "documents.db",
        storageOwner: true,
      },
      {
        assertCapabilities: () => undefined,
        channels: { open: () => recordingChannel([]) },
        closeSelf: () => {
          workerClosed = true;
        },
        locks: {
          request: async (_name, callback) => await callback(),
        },
        openRuntime: async () =>
          testRuntime(
            "owner",
            closed,
            async () => undefined,
            async () => undefined,
            closeReady.promise,
          ),
        postLocal: (response) => responses.push(response),
        randomId: (prefix) => `${prefix}-owner`,
      },
    );

    await runtime.start();
    runtime.handle({ id: 2, op: WorkerCommand.Close });
    await Promise.resolve();
    expect(result(responses, 2)).toBeUndefined();
    expect(workerClosed).toBe(false);

    closeReady.resolve();
    await waitUntil(() => result(responses, 2) !== undefined);
    expect(closed).toEqual(["owner"]);
    expect(workerClosed).toBe(true);
  });

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
      fence: "1",
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
          contractId: CURRENT_WIRE_CONTRACT_ID,
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

  test("discovers every deployment through one physical browser-storage scope", () => {
    const oldIdentity = identity({ moduleGraphHash: "old", packageVersion: "1.0.0" });
    const newIdentity = identity({ moduleGraphHash: "new", packageVersion: "2.0.0" });

    expect(runtimeScope(oldIdentity)).toBe(runtimeScope(newIdentity));
    expect(controlChannelName(oldIdentity.storageId)).toBe(
      controlChannelName(newIdentity.storageId),
    );
  });

  test("runtime identity carries the local store format version", () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    expect(EMBEDDED_STORE_EPOCH).toBe(1);
    expect(createRuntimeIdentity("documents").storeFormatVersion).toBe(1);
  });

  test("a store format version mismatch surfaces as a runtime identity mismatch", () => {
    expect(() =>
      assertSameRuntimeIdentity(identity({ storeFormatVersion: 40 }), identity()),
    ).toThrow(/store format/);
  });

  test("a setup action mismatch is part of browser runtime ownership", () => {
    const current = identity({ setupGraphHash: "graph-a", setupReference: "local/setup:setup" });
    expect(() =>
      assertSameRuntimeIdentity(
        identity({ setupGraphHash: "graph-b", setupReference: "local/setup:setup" }),
        current,
      ),
    ).toThrow(/setup action/);
    expect(() =>
      assertSameRuntimeIdentity(
        identity({ setupGraphHash: "graph-a", setupReference: "local/setup:other" }),
        current,
      ),
    ).toThrow(/setup action/);
  });

  test("rejects an asymmetric setup admission identity", () => {
    const withSetup = identity({
      setupGraphHash: "graph-a",
      setupReference: "local/setup:setup",
    });

    expect(() => assertSameRuntimeIdentity(withSetup, identity())).toThrow(/setup action/);
    expect(() => assertSameRuntimeIdentity(identity(), withSetup)).toThrow(/setup action/);
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
      leaderFence: "0",
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
        leaderEpoch: "leader-old",
        leaderFence: "0",
        op: PeerOp.Attach,
        coordinationId: BrowserCoordinationContractId,
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

  test("sends the current remote snapshot after a follower is attached", () => {
    const messages: PeerMessage[] = [];
    const runtime = remoteRuntime();
    runtime.remoteEvent = {
      at: 1,
      attempt: 2,
      generation: 3,
      sequence: 4,
      status: "connected",
      tick: {
        changedTables: [],
        pullAttempted: 1,
        pushAccepted: 0,
        pushAttempted: 0,
        pushConflicts: 0,
        pushFailed: 0,
        pushRebases: 0,
        pushed: 0,
        received: 1,
        reconnected: false,
        retainedRevisions: 0,
        rowsApplied: 0,
        sent: 1,
        receiptsPushed: 0,
        storeJobs: 0,
        pending: {
          checkpoints: 0,
          inflight: 1,
          mutations: 2,
          scope: 1,
          settlements: 0,
          uploads: 0,
        },
      },
      type: "remote",
    };
    const leader = new LeaderRuntime({
      epoch: "leader-incarnation",
      fence: "1",
      identity: identity(),
      runtime,
      scope: "scope",
      storagePath: "documents.db",
    });

    leader.attachFollower(
      {
        clientId: "client",
        identity: identity(),
        leaderEpoch: "leader-incarnation",
        leaderFence: "1",
        op: PeerOp.Attach,
        coordinationId: BrowserCoordinationContractId,
        remote: {
          authFetchToken: false,
          clientId: "client",
          moduleGraphHash: "modules",
          contractId: CURRENT_WIRE_CONTRACT_ID,
          schemaHash: "schema",
          url: "https://fixture.convex.cloud",
        },
        scope: "scope",
        storagePath: "documents.db",
        workerId: "follower",
      },
      () => recordingChannel(messages),
      () => undefined,
      "owner",
    );

    expect(messages.map((message) => message.op)).toEqual([PeerOp.Attached, PeerOp.Response]);
    expect(messages[1]).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          event: expect.objectContaining({
            generation: 3,
            incarnation: "leader-incarnation",
            sequence: 4,
            status: "connected",
            tick: expect.objectContaining({
              pending: {
                checkpoints: 0,
                inflight: 1,
                mutations: 2,
                scope: 1,
                settlements: 0,
                uploads: 0,
              },
              pullAttempted: 1,
              received: 1,
              sent: 1,
            }),
            type: "remote",
          }),
        }),
      }),
    );
    const snapshot = messages[1] as Extract<PeerMessage, { op: typeof PeerOp.Response }>;
    expect("settlements" in snapshot.response).toBe(false);
  });

  test("forwards a live remote settlement vector without replaying it in snapshots", () => {
    const firstResponses: WorkerResponse[] = [];
    const laterResponses: WorkerResponse[] = [];
    const runtime = remoteRuntime();
    const event = {
      at: 1,
      attempt: 1,
      generation: 2,
      sequence: 3,
      status: "idle",
      tick: {
        changedTables: [],
        pullAttempted: 0,
        pushAccepted: 1,
        pushAttempted: 1,
        pushConflicts: 0,
        pushFailed: 0,
        pushRebases: 0,
        pushed: 1,
        received: 0,
        reconnected: false,
        retainedRevisions: 0,
        rowsApplied: 0,
        sent: 1,
        receiptsPushed: 1,
        storeJobs: 0,
      },
      type: "remote",
    } satisfies Extract<EmbeddedEvent, { type: "remote" }>;
    runtime.remoteEvent = event;
    const leader = new LeaderRuntime({
      epoch: "leader-incarnation",
      fence: "1",
      identity: identity(),
      runtime,
      scope: "scope",
      storagePath: "documents.db",
    });
    const client = (id: string, responses: WorkerResponse[]) => ({
      activeMutations: 0,
      id,
      post: (response: WorkerResponse) => responses.push(response),
      remoteConfigured: true,
      watches: new Map(),
      workerId: id,
    });

    leader.addLocalClient(client("first", firstResponses));
    expect(firstResponses).toHaveLength(1);
    expect("settlements" in firstResponses[0]!).toBe(false);

    runtime.emitRemote?.(event, [
      {
        functionName: "documents:write",
        mutationId: "settled-once",
        outcome: "applied",
        retainedRevisions: [],
      },
    ]);
    expect(firstResponses.at(-1)).toMatchObject({
      event: { generation: 2, sequence: 3, type: "remote" },
      op: WorkerEvent.Event,
      settlements: [
        {
          functionName: "documents:write",
          mutationId: "settled-once",
          outcome: "applied",
          retainedRevisions: [],
        },
      ],
    });

    leader.addLocalClient(client("later", laterResponses));
    expect(laterResponses).toHaveLength(1);
    expect("settlements" in laterResponses[0]!).toBe(false);
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
      name: "documents:read",
      op: WorkerCommand.Query,
    });
    await waitUntil(() => firstQueries === 1);
    expect(opened).toEqual(["first"]);

    const closeFirst = first.close();
    await Promise.resolve();
    expect(opened).toEqual(["first"]);
    firstClose.resolve();
    await closeFirst;
    second.handle({ id: 99, op: WorkerCommand.StorageOwnerWrite });
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

  test("accepts sequence one from the new leader incarnation after an owner handoff", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const channels = new ChannelBus();
    const locks = new LockQueue();
    const handoffOrder: string[] = [];
    channels.onSend = (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { op?: unknown; leaderId?: unknown }).op === ControlOp.BroadcastLeader &&
        (message as { leaderId?: unknown }).leaderId === "worker-second-incarnation"
      ) {
        handoffOrder.push("barrier");
      }
    };
    const firstResponses: WorkerResponse[] = [];
    const secondResponses: WorkerResponse[] = [];
    const firstRuntime = remoteRuntime();
    const secondRuntime = remoteRuntime(handoffOrder);
    (
      secondRuntime.store as unknown as { leader: { fence: { write(): Promise<string> } } }
    ).leader.fence.write = async () => {
      handoffOrder.push("fence");
      return "10";
    };
    const first = coordinator("first-incarnation", firstResponses, {
      channels,
      locks,
      openRuntime: async () => firstRuntime,
      remote: true,
    });
    const second = coordinator("second-incarnation", secondResponses, {
      channels,
      locks,
      openRuntime: async () => secondRuntime,
      remote: true,
    });

    await first.start();
    await second.start();
    firstRuntime.emit?.({
      at: 1,
      attempt: 1,
      generation: 1,
      sequence: 99,
      status: "connected",
      type: "remote",
    });
    await waitUntil(() => remoteEvents(secondResponses).some((event) => event.sequence === 99));
    const oldEvent = remoteEvents(secondResponses).find((event) => event.sequence === 99)!;

    await first.close();
    second.handle({ id: 99, op: WorkerCommand.StorageOwnerWrite });
    await waitUntil(() => secondRuntime.emit !== undefined);
    await waitUntil(() => handoffOrder.includes("remote"));
    expect(handoffOrder.indexOf("fence")).toBeLessThan(handoffOrder.indexOf("barrier"));
    expect(handoffOrder.indexOf("barrier")).toBeLessThan(handoffOrder.indexOf("remote"));
    secondRuntime.emit?.({
      at: 2,
      attempt: 1,
      generation: 1,
      sequence: 1,
      status: "offline",
      type: "remote",
    });
    await waitUntil(() => remoteEvents(secondResponses).some((event) => event.sequence === 1));
    const nextEvent = remoteEvents(secondResponses).find(
      (event) => event.sequence === 1 && event.status === "offline",
    )!;

    expect(oldEvent.incarnation).toBe("leader-first-incarnation");
    expect(nextEvent.incarnation).toBe("leader-second-incarnation");
    expect(Number(nextEvent.leaderFence)).toBeGreaterThan(Number(oldEvent.leaderFence));

    // A delayed peer frame from the retired leader cannot reattach this worker or settle a
    // request after the replacement owner has allocated its higher durable term.
    const stalePeer = channels.open(
      workerChannelName(runtimeScope(identity()), "worker-second-incarnation"),
    );
    stalePeer.postMessage({
      leaderEpoch: "leader-first-incarnation",
      leaderFence: oldEvent.leaderFence!,
      leaderId: "first-incarnation",
      op: PeerOp.Attached,
      coordinationId: BrowserCoordinationContractId,
    } satisfies PeerMessage);
    stalePeer.postMessage({
      leaderEpoch: "leader-first-incarnation",
      leaderFence: oldEvent.leaderFence!,
      op: PeerOp.Response,
      coordinationId: BrowserCoordinationContractId,
      response: { id: 777, op: WorkerEvent.Result, result: "late-first-result" },
    } satisfies PeerMessage);
    await Promise.resolve();
    expect(result(secondResponses, 777)).toBeUndefined();
    stalePeer.close();

    let emit: ((event: EmbeddedEvent) => void) | undefined;
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      remote: { identity: { read: async () => undefined } },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emit = listener;
        return () => undefined;
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, remoteConfigured: true, runner });
    try {
      await Promise.resolve();
      emit?.(oldEvent);
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });
      emit?.(nextEvent);
      expect(client.connectionState().replication).toEqual({ status: "offline" });
    } finally {
      await client.close();
      await second.close();
    }
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
    second.handle({ id: 99, op: WorkerCommand.StorageOwnerWrite });
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
    remote?: boolean;
  },
) {
  return createCoordinatorRuntime(
    {
      clientId: workerId,
      id: 1,
      identity: identity(),
      op: WorkerCommand.Init,
      remote: options.remote
        ? {
            authFetchToken: false,
            clientId: workerId,
            moduleGraphHash: "modules",
            contractId: CURRENT_WIRE_CONTRACT_ID,
            schemaHash: "schema",
            url: "https://fixture.convex.cloud",
          }
        : undefined,
      storagePath: "documents.db",
      storageOwner: workerId.startsWith("first"),
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
      leader: { fence: { write: async () => String(++nextLeaderFence) } },
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
  onSend?: (message: unknown) => void;
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
    this.onSend?.(message);
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
      leader: { fence: { write: async () => String(++nextLeaderFence) } },
      remote: { close: async () => undefined },
    },
  } as unknown as WorkerState;
}

function remoteRuntime(order?: string[]): WorkerState {
  return {
    closed: false,
    opfs: { closeAll: () => undefined },
    runner: {
      route: async () => undefined,
      runQuery: async () => undefined,
      remote: { scope: { write: async () => undefined } },
      subscribeEvents: () => () => undefined,
    },
    stops: new Map(),
    store: {
      close: async () => undefined,
      leader: { fence: { write: async () => String(++nextLeaderFence) } },
      remote: {
        close: async () => undefined,
        identity: async () => ({ identity: null, identityKey: "unauthenticated" }),
        pull: async () => new Promise(() => undefined),
        start: async () => {
          order?.push("remote");
        },
      },
    },
  } as unknown as WorkerState;
}

function remoteEvents(responses: WorkerResponse[]) {
  return responses.flatMap((response) =>
    response.op === WorkerEvent.Event && response.event.type === "remote" ? [response.event] : [],
  );
}

function identity(overrides: Partial<RuntimeIdentity> = {}): RuntimeIdentity {
  return {
    moduleGraphHash: "modules",
    packageVersion: "0.0.0",
    contractId: CURRENT_WIRE_CONTRACT_ID,
    schemaHash: "schema",
    storageId: "documents",
    storeFormatVersion: EMBEDDED_STORE_EPOCH,
    storageBindingId: CURRENT_STORAGE_BINDING_CONTRACT_ID,
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

let nextLeaderFence = 0;
