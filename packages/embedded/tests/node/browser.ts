import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { ConvexEmbeddedClient, createConvexEmbeddedClientForTest } from "../../src/browser/client";
import { createCoordinatorRuntime, type CoordinatorRuntime } from "../../src/browser/coordinator";
import {
  ControlOp,
  CoordinatorProtocol,
  PeerOp,
  storageOwnerLockName,
} from "../../src/browser/coordinator/protocol";
import type { WasmModule } from "../../src/browser/artifact";
import { OpfsDirectory, opfsImports, registerTursoFiles } from "../../src/browser/opfs";
import { browserStorageId, browserStoragePath } from "../../src/browser/storage";
import type { ConvexEmbeddedClientOptions } from "../../src/browser";
import { runtimeScope, setEmbeddedIdentity } from "../../src/browser/identity";
import type {
  EmbeddedWorker,
  RuntimeIdentity,
  WorkerRequest,
  WorkerResponse,
} from "../../src/browser/protocol";
import { WorkerCommand, WorkerEvent } from "../../src/browser/protocol";
import { WorkerRunner } from "../../src/browser/proxy";
import type { WorkerState } from "../../src/browser/runtime";
import { defineFunctions } from "../../src/runtime/functions";
import type { Runner, RunMutationOptions } from "../../src/runtime/runner";
import type {
  BindingCommitOptions,
  BindingMutationCall,
  BindingMutationRecord,
  BindingPage,
  BindingPruneResult,
  BindingScanSpec,
  BindingWriteBatch,
  StoreBinding,
} from "../../src/storage/binding";
import type { StoreSchema } from "../../src/storage/types";

const schema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const { query, mutation } = defineFunctions<DataModel>();

const messages = {
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", args),
  }),
  list: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect(),
  }),
};

const send = makeFunctionReference<"mutation", { channel: string; body: string }, string>(
  "messages:send",
);
const list = makeFunctionReference<"query", { channel: string }, { body: string }[]>(
  "messages:list",
);

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
const originalAddEventListener = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
const originalCrossOriginIsolated = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalRemoveEventListener = Object.getOwnPropertyDescriptor(
  globalThis,
  "removeEventListener",
);
const originalSharedArrayBuffer = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
const originalDedicatedWorkerGlobalScope = Object.getOwnPropertyDescriptor(
  globalThis,
  "DedicatedWorkerGlobalScope",
);

afterEach(() => {
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("self", originalSelf);
  restoreGlobal("Worker", originalWorker);
  restoreGlobal("BroadcastChannel", originalBroadcastChannel);
  restoreGlobal("addEventListener", originalAddEventListener);
  restoreGlobal("crossOriginIsolated", originalCrossOriginIsolated);
  restoreGlobal("location", originalLocation);
  restoreGlobal("localStorage", originalLocalStorage);
  restoreGlobal("removeEventListener", originalRemoveEventListener);
  restoreGlobal("SharedArrayBuffer", originalSharedArrayBuffer);
  restoreGlobal("DedicatedWorkerGlobalScope", originalDedicatedWorkerGlobalScope);
  delete (
    globalThis as typeof globalThis & {
      __CONVEX_EMBEDDED_DEBUG_LOG__?: unknown;
    }
  ).__CONVEX_EMBEDDED_DEBUG_LOG__;
});

describe("browser ConvexEmbeddedClient", () => {
  test("fails clearly when Dedicated Worker is unavailable", () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    expect(() => new ConvexEmbeddedClient()).toThrow("requires Dedicated Worker support");
  });

  test("closes the browser worker on pagehide and reloads after BFCache restore", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const worker = new ErrorableWorker();
    const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
    let reloads = 0;

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: function WorkerConstructor() {
        return worker;
      },
    });
    Object.defineProperty(globalThis, "addEventListener", {
      configurable: true,
      value: (type: string, callback: (event: { persisted?: boolean }) => void) => {
        listeners.set(type, callback);
      },
    });
    Object.defineProperty(globalThis, "removeEventListener", {
      configurable: true,
      value: (type: string) => {
        listeners.delete(type);
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        reload: () => {
          reloads += 1;
        },
      },
    });

    const convex = new ConvexEmbeddedClient();
    await waitFor(() => expect(worker.ready).toBe(true));

    listeners.get("pagehide")?.({});
    await waitFor(() => expect(worker.closed).toBe(true));
    listeners.get("pageshow")?.({ persisted: true });

    expect(convex).toBeInstanceOf(ConvexEmbeddedClient);
    expect(reloads).toBe(1);
  });

  test("public browser options are config-only", () => {
    const valid: ConvexEmbeddedClientOptions = {};
    expect(valid).toEqual({});

    // @ts-expect-error browser storage is origin-scoped and privately named.
    const invalidStorage: ConvexEmbeddedClientOptions = { storageKey: "test-browser" };
    expect(invalidStorage).toBeDefined();

    // @ts-expect-error modules are discovered by the embedded bundler plugin.
    const invalid: ConvexEmbeddedClientOptions = { modules: { messages } };
    expect(invalid).toBeDefined();

    // @ts-expect-error schema is discovered by the embedded bundler plugin.
    const invalidSchema: ConvexEmbeddedClientOptions = { schema };
    expect(invalidSchema).toBeDefined();

    // @ts-expect-error WASM artifact loading is not part of the public browser API.
    const invalidWasm: ConvexEmbeddedClientOptions = { wasm: wasmModule() };
    expect(invalidWasm).toBeDefined();
  });

  test("runtime coordination scopes are storage-scoped, not schema-scoped", () => {
    const base = {
      packageVersion: "0.0.0",
      protocolVersion: 3,
      storageId: "origin",
      wasmAbiVersion: 6,
    };

    expect(
      runtimeScope({
        ...base,
        moduleGraphHash: "modules-a",
        schemaHash: "schema-a",
      }),
    ).toBe(
      runtimeScope({
        ...base,
        moduleGraphHash: "modules-b",
        schemaHash: "schema-b",
      }),
    );
  });

  test("uses one deterministic browser storage id per origin", () => {
    const storage = installLocalStorage();

    expect(browserStorageId()).toBe("origin");
    expect(storage.getItem("convex-embedded.storageId")).toBe("origin");
    expect(browserStoragePath()).toBe("convex-embedded-origin.db");

    storage.setItem("convex-embedded.storageId", "legacy.id-1");
    expect(browserStorageId()).toBe("legacy.id-1");
    expect(browserStoragePath()).toBe("convex-embedded-legacy.id-1.db");
  });

  test("falls back to the deterministic origin storage id when localStorage is unavailable", () => {
    installThrowingLocalStorage();

    expect(browserStorageId()).toBe("origin");
    expect(browserStoragePath()).toBe("convex-embedded-origin.db");
  });

  test("runs through the Rust/WASM storage binding contract", async () => {
    const convex = createConvexEmbeddedClientForTest(options(), wasmModule());
    await convex.mutation(send, { channel: "general", body: "hi" });
    await expect(convex.query(list, { channel: "general" })).resolves.toEqual([
      expect.objectContaining({ body: "hi" }),
    ]);
    await convex.close();
  });

  test("validates browser WASM artifact shape", async () => {
    const convex = createConvexEmbeddedClientForTest(options(), { apiVersion: () => 6 } as never);
    await expect(convex.query(list, { channel: "general" })).rejects.toThrow(
      "did not export Store.open",
    );
  });

  test("can use a worker-owned embedded runtime facade", async () => {
    const worker = new FakeRuntimeWorker();
    const convex = createConvexEmbeddedClientForTest(
      {
        schema,
        worker,
      },
      wasmModule(),
    );
    const watch = convex.watchQuery(list, { channel: "general" });
    const seen: unknown[] = [];
    const stop = watch.onUpdate(() => {
      seen.push(watch.localQueryResult());
    });

    await convex.mutation(send, { channel: "general", body: "hi" });
    await expect(convex.query(list, { channel: "general" })).resolves.toEqual([
      expect.objectContaining({ body: "hi" }),
    ]);
    expect(seen.at(-1)).toEqual([expect.objectContaining({ body: "hi" })]);

    stop();
    await convex.close();
    expect(worker.closed).toBe(true);
  });

  test("does not start a worker watch after unsubscribe before init", async () => {
    const worker = new DeferredInitWorker();
    const runner = new WorkerRunner(worker, { storagePath: "test-browser.db" });
    const stop = runner.onUpdate("messages:list", { channel: "general" }, () => undefined);

    stop();
    worker.resolveInit();
    await tick();

    expect(worker.messages.map((message) => message.op)).toEqual([WorkerCommand.Init]);
    await runner.close();
  });

  test("fails worker requests instead of hanging forever", async () => {
    const worker = new SilentWorker();
    const runner = new WorkerRunner(worker, {
      closeTimeoutMs: 1,
      requestTimeoutMs: 1,
      storagePath: "test-browser.db",
    });

    await expect(runner.runQuery("messages:list", { channel: "general" })).rejects.toThrow(
      'worker request "init" timed out',
    );
    expect(worker.closed).toBe(true);
    await expect(runner.close()).resolves.toBeUndefined();
  });

  test("close returns even when init is still pending", async () => {
    const worker = new SilentWorker();
    const runner = new WorkerRunner(worker, {
      closeTimeoutMs: 1,
      requestTimeoutMs: 60_000,
      storagePath: "test-browser.db",
    });

    await expect(runner.close()).resolves.toBeUndefined();
    expect(worker.closed).toBe(true);
  });

  test("does not reject an accepted mutation just because the request timeout elapses", async () => {
    const worker = new AcceptedSlowMutationWorker();
    const runner = new WorkerRunner(worker, {
      acceptedResultTimeoutMs: 60_000,
      requestTimeoutMs: 1,
      storagePath: "test-browser.db",
    });

    const mutation = runner.runMutation(send, { channel: "general", body: "hi" });
    await delay(5);
    expect(worker.closed).toBe(false);
    worker.resolveMutation("messages|1");
    await expect(mutation).resolves.toBe("messages|1");
    await runner.close();
  });

  test("rejects a slow query without terminating the worker", async () => {
    const worker = new ErrorableWorker();
    const runner = new WorkerRunner(worker, {
      requestTimeoutMs: 1,
      storagePath: "test-browser.db",
    });
    await waitFor(() => expect(worker.ready).toBe(true));

    const query = runner.runQuery("messages:list", { channel: "general" });
    await expect(query).rejects.toThrow("timed out");
    // A query timeout is recoverable: it rejects the caller but leaves the runtime running so
    // other in-flight and future requests survive (only Init/protocol failures are fatal).
    expect(worker.closed).toBe(false);
  });

  test("rejects an accepted mutation as indeterminate when the final result never arrives", async () => {
    const worker = new AcceptedSlowMutationWorker();
    const runner = new WorkerRunner(worker, {
      acceptedResultTimeoutMs: 1,
      requestTimeoutMs: 60_000,
      storagePath: "test-browser.db",
    });

    const mutation = runner.runMutation(send, { channel: "general", body: "hi" });
    await expect(mutation).rejects.toThrow("final result");
    expect(worker.closed).toBe(false);
    await runner.close();
  });

  test("opens OPFS sync handles in exclusive readwrite mode and retries stale locks", async () => {
    const modes: unknown[] = [];
    let attempts = 0;
    const handle = syncHandle();
    setNavigatorStorage({
      async getFileHandle() {
        return {
          async createSyncAccessHandle(options?: { mode: "readwrite" }) {
            attempts += 1;
            modes.push(options);
            if (attempts === 1) {
              throw Object.assign(new Error("locked"), { name: "NoModificationAllowedError" });
            }
            return handle;
          },
        };
      },
      async removeEntry() {},
    });

    const opfs = new OpfsDirectory();
    await opfs.registerFile("app.db");

    expect(attempts).toBe(2);
    expect(modes).toEqual([{ mode: "readwrite" }, { mode: "readwrite" }]);
    expect(opfs.getFileHandle("app.db")).toBe(1);
  });

  test("reports stale OPFS ownership after bounded sync handle retries", async () => {
    let attempts = 0;
    setNavigatorStorage({
      async getFileHandle() {
        return {
          async createSyncAccessHandle() {
            attempts += 1;
            throw Object.assign(new Error("locked"), { name: "NoModificationAllowedError" });
          },
        };
      },
      async removeEntry() {},
    });

    const opfs = new OpfsDirectory();
    await expect(opfs.registerFile("app.db")).rejects.toThrow("Close or reload other tabs");
    expect(attempts).toBe(4);
  });

  test("removes OPFS files synchronously without physical browser deletion", async () => {
    let removeEntryCalls = 0;
    let truncateSize: number | undefined;
    let flushes = 0;
    setNavigatorStorage({
      async getFileHandle() {
        return {
          async createSyncAccessHandle() {
            return {
              ...syncHandle(),
              flush() {
                flushes += 1;
              },
              truncate(size: number) {
                truncateSize = size;
              },
            };
          },
        };
      },
      async removeEntry() {
        removeEntryCalls += 1;
      },
    });

    const opfs = new OpfsDirectory();
    await opfs.registerFile("app.db");

    expect(opfs.removeFile("app.db")).toBe(0);
    expect(truncateSize).toBe(0);
    expect(flushes).toBe(1);
    expect(removeEntryCalls).toBe(0);
    expect(opfs.getFileHandle("app.db")).toBe(1);

    expect(opfs.removeFile("unknown.db")).toBe(0);
    expect(removeEntryCalls).toBe(0);
  });

  test("does not truncate Turso OPFS files during normal register and close", async () => {
    const truncates: Array<{ path: string; size: number | undefined }> = [];
    setNavigatorStorage({
      async getFileHandle(path) {
        return {
          async createSyncAccessHandle() {
            return {
              ...syncHandle(),
              truncate(size?: number) {
                truncates.push({ path, size });
              },
            };
          },
        };
      },
    });

    const opfs = new OpfsDirectory();
    await registerTursoFiles(opfs, "app.db");
    opfs.closeAll();

    expect(truncates).toEqual([]);
  });

  test("emits debug events for OPFS remove and truncate paths", async () => {
    const events: Array<{ detail?: unknown; phase: string }> = [];
    setNavigatorStorage({
      async getFileHandle() {
        return {
          async createSyncAccessHandle() {
            return syncHandle();
          },
        };
      },
    });

    const opfs = new OpfsDirectory((phase, detail) => events.push({ detail, phase }));
    await opfs.registerFile("app.db");
    const handle = opfs.getFileHandle("app.db");
    expect(handle).toBe(1);

    opfs.truncate(handle ?? -1, 128);
    opfs.removeFile("app.db");
    opfs.removeFile("unknown.db");

    expect(events).toEqual([
      { detail: { handle: 1, size: 128 }, phase: "worker:opfs:truncate" },
      {
        detail: { path: "app.db", registered: true },
        phase: "worker:opfs:remove-file",
      },
      {
        detail: { path: "unknown.db", registered: false },
        phase: "worker:opfs:remove-file",
      },
    ]);
  });

  test("reports OPFS capability only from dedicated workers", () => {
    class DedicatedWorker {}
    Object.defineProperty(globalThis, "DedicatedWorkerGlobalScope", {
      configurable: true,
      value: DedicatedWorker,
    });
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: new DedicatedWorker(),
    });

    const imports = opfsImports(new OpfsDirectory(), { buffer: new ArrayBuffer(8) }) as {
      opfs_is_dedicated_worker(): boolean;
    };

    expect(imports.opfs_is_dedicated_worker()).toBe(true);

    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: {},
    });
    expect(imports.opfs_is_dedicated_worker()).toBe(false);
  });

  test("disposes every watch even when a user onError callback throws", async () => {
    const worker = new ErrorableWorker();
    const runner = new WorkerRunner(worker, { storagePath: "test-browser.db" });
    const errors: string[] = [];

    runner.onUpdate(
      "messages:list",
      { channel: "general" },
      () => undefined,
      () => {
        errors.push("first");
        throw new Error("user callback failed");
      },
    );
    runner.onUpdate(
      "messages:list",
      { channel: "general" },
      () => undefined,
      () => {
        errors.push("second");
      },
    );

    await waitFor(() => expect(worker.watchStarts).toBe(2));
    worker.emitError(new Error("worker failed"));

    expect(errors).toEqual(["first", "second"]);
    expect(worker.closed).toBe(true);
  });

  test("surfaces unknown worker protocol messages through the debug hook", async () => {
    const worker = new ErrorableWorker();
    const events: Array<{ phase: string }> = [];
    (
      globalThis as typeof globalThis & {
        __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: { phase: string }) => void;
      }
    ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => events.push(event);
    const runner = new WorkerRunner(worker, { storagePath: "test-browser.db" });

    await waitFor(() => expect(worker.ready).toBe(true));
    worker.emit({ op: 999, payload: true });

    await waitFor(() =>
      expect(events.some((event) => event.phase === "worker:protocol:unknown-message")).toBe(true),
    );
    await runner.close();
  });
});

describe("dedicated browser runtime coordinator", () => {
  test("elects one leader and proxies follower requests without opening a second runtime", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    await leader.start();

    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await follower.start();

    expect(harness.runtime.initCount).toBe(1);
    expect(harness.locks.requests).toContain(
      storageOwnerLockName(identity("schema-a", "modules-a")),
    );
    expect(harness.locks.requests.some((name) => name.endsWith(":leader"))).toBe(false);
    expect(
      harness.network.messages.some(
        (message) =>
          message.channel.endsWith(":control") &&
          isRecord(message.data) &&
          message.data.op === ControlOp.SeekLeader,
      ),
    ).toBe(true);
    expect(
      harness.network.messages.some(
        (message) =>
          message.channel.endsWith(":control") &&
          isRecord(message.data) &&
          message.data.op === ControlOp.BroadcastLeader,
      ),
    ).toBe(true);
    expect(
      harness.network.messages.every(
        (message) => !isRecord(message.data) || !Object.hasOwn(message.data, "type"),
      ),
    ).toBe(true);

    follower.handle({
      args: { body: "hi", channel: "general" },
      clientId: "client-b",
      id: 2,
      mutationId: "mutation:1",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });

    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 2,
        mutationId: "mutation:1",
        op: WorkerEvent.MutationAccepted,
      }),
    );
    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 2,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );
    expect(
      harness.network.messages.some(
        (message) =>
          message.channel.endsWith(":worker:worker-a") &&
          isRecord(message.data) &&
          message.data.op === PeerOp.Request,
      ),
    ).toBe(true);
    expect(
      harness.network.messages.some(
        (message) =>
          message.channel.endsWith(":worker:worker-b") &&
          isRecord(message.data) &&
          message.data.op === PeerOp.RequestAck &&
          message.data.requestId === 2,
      ),
    ).toBe(true);
    expect(
      harness.network.messages.some(
        (message) =>
          message.channel.endsWith(":control") &&
          isRecord(message.data) &&
          message.data.op === PeerOp.Request &&
          isRecord(message.data.request),
      ),
    ).toBe(false);

    leader.handle({
      args: { channel: "general" },
      clientId: "client-a",
      id: 3,
      name: "messages:list",
      op: WorkerCommand.Query,
    });
    await waitFor(() =>
      expect(leader.responses).toContainEqual({
        id: 3,
        result: [expect.objectContaining({ body: "hi", channel: "general" })],
        op: WorkerEvent.Result,
      }),
    );
  });

  test("storage owner lock is stable across protocol and schema identity", () => {
    expect(storageOwnerLockName(identity("schema-a", "modules-a"))).toBe(
      storageOwnerLockName({
        ...identity("schema-b", "modules-b"),
        protocolVersion: 999,
      }),
    );
  });

  test("replays the cached shared watch value to a late follower subscriber", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    leader.handle({
      args: { body: "seeded", channel: "general" },
      clientId: "client-a",
      id: 2,
      mutationId: "mutation:seeded",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });
    await waitFor(() =>
      expect(leader.responses).toContainEqual({
        id: 2,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );

    leader.handle({
      args: { channel: "general" },
      clientId: "client-a",
      id: 3,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 11,
    });
    await waitFor(() =>
      expect(leader.responses).toContainEqual({
        op: WorkerEvent.WatchUpdated,
        value: [expect.objectContaining({ body: "seeded", channel: "general" })],
        watchId: 11,
      }),
    );

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 4,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 12,
    });

    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 4, op: WorkerEvent.Result }),
    );
    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        op: WorkerEvent.WatchUpdated,
        value: [expect.objectContaining({ body: "seeded", channel: "general" })],
        watchId: 12,
      }),
    );
  });

  test("replays the cached shared watch error to a late follower subscriber", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    harness.runtime.queryError = new Error("query failed");
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    leader.handle({
      args: { channel: "general" },
      clientId: "client-a",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 11,
    });
    await waitFor(() =>
      expect(leader.responses).toContainEqual({
        error: expect.objectContaining({ message: "query failed" }),
        op: WorkerEvent.WatchFailed,
        watchId: 11,
      }),
    );

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 3,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 12,
    });

    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 3, op: WorkerEvent.Result }),
    );
    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        error: expect.objectContaining({ message: "query failed" }),
        op: WorkerEvent.WatchFailed,
        watchId: 12,
      }),
    );
  });

  test("replays queued query mutation and watch once after follower attach", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness({ fastTimers: true });
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    await leader.start();

    harness.network.drop = (channel, data) =>
      channel.endsWith(":worker:worker-b") && isRecord(data) && data.op === PeerOp.Attached;
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    const start = follower.start();
    await delay(20);

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.Query,
    });
    follower.handle({
      args: { body: "queued", channel: "general" },
      clientId: "client-b",
      id: 3,
      mutationId: "mutation:queued",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });
    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 4,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    });

    harness.network.drop = undefined;
    await start;

    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 4, op: WorkerEvent.Result }),
    );
    const forwarded = forwardedRequests(harness, "worker-a").filter((request) =>
      [2, 3, 4].includes(request.id),
    );
    expect(forwarded.map((request) => request.id).sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  test("watch stop before attach cancels the queued watch start", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness({ fastTimers: true });
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    await leader.start();

    harness.network.drop = (channel, data) =>
      channel.endsWith(":worker:worker-b") && isRecord(data) && data.op === PeerOp.Attached;
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    const start = follower.start();
    await delay(20);

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    });
    follower.handle({
      clientId: "client-b",
      id: 3,
      op: WorkerCommand.WatchStop,
      watchId: 7,
    });

    harness.network.drop = undefined;
    await start;
    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 3, op: WorkerEvent.Result }),
    );

    expect(
      forwardedRequests(harness, "worker-a").some(
        (request) => request.op === WorkerCommand.WatchStart && request.watchId === 7,
      ),
    ).toBe(false);
  });

  test("rejects followers with mismatched schema or module identity", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    await leader.start();

    installEmbeddedIdentity("schema-b", "modules-a");
    const follower = harness.worker("worker-b", "client-b", identity("schema-b", "modules-a"));
    await follower.start().catch(() => undefined);

    await waitFor(() =>
      expect(
        follower.responses.some(
          (message) =>
            message.op === WorkerEvent.Result &&
            message.id === 1 &&
            message.error?.message.includes("different identity"),
        ),
      ).toBe(true),
    );
    expect(harness.runtime.initCount).toBe(1);
  });

  test("fails clearly when Web Locks are unavailable", () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    installCoordinatorGlobals({ locks: false });

    expect(() =>
      createCoordinatorRuntime(
        coordinatorInitRequest("client-a", identity("schema-a", "modules-a")),
        {
          closeSelf: () => undefined,
          openRuntime: (request, post) => new FakeCoordinatorRuntime().open(request, post),
          postLocal: () => undefined,
          randomId: (prefix) => (prefix === "worker" ? "worker-a" : `${prefix}:test`),
        },
      ),
    ).toThrow("Web Locks");
  });

  test("fails clearly when BroadcastChannel is unavailable", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    installCoordinatorGlobals({ broadcastChannel: false });

    const responses: WorkerResponse[] = [];
    const coordinator = createCoordinatorRuntime(
      coordinatorInitRequest("client-a", identity("schema-a", "modules-a")),
      {
        closeSelf: () => undefined,
        openRuntime: (request, post) => new FakeCoordinatorRuntime().open(request, post),
        postLocal: (message) => responses.push(message),
        randomId: (prefix) => (prefix === "worker" ? "worker-a" : `${prefix}:test`),
      },
    );

    await coordinator.start();

    expect(responses).toContainEqual({
      error: expect.objectContaining({
        message: expect.stringContaining("BroadcastChannel"),
      }),
      id: 1,
      op: WorkerEvent.Result,
    });
  });

  test("fails clearly when cross-origin isolation is unavailable", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    installCoordinatorGlobals({ crossOriginIsolated: false });
    const responses: WorkerResponse[] = [];
    const coordinator = createCoordinatorRuntime(
      coordinatorInitRequest("client-a", identity("schema-a", "modules-a")),
      {
        closeSelf: () => undefined,
        openRuntime: (request, post) => new FakeCoordinatorRuntime().open(request, post),
        postLocal: (message) => responses.push(message),
        randomId: (prefix) => (prefix === "worker" ? "worker-a" : `${prefix}:test`),
      },
    );

    await coordinator.start();

    expect(responses).toContainEqual({
      error: expect.objectContaining({
        message: expect.stringContaining("cross-origin isolation"),
      }),
      id: 1,
      op: WorkerEvent.Result,
    });
  });

  test("uses configurable coordinator timeout values", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const network = new FakeBroadcastNetwork();
    const timers: number[] = [];
    const coordinator = createCoordinatorRuntime(
      coordinatorInitRequest("client-a", identity("schema-a", "modules-a")),
      {
        assertCapabilities: () => undefined,
        channels: { open: (name) => network.channel(name) },
        clearTimer: (timer) => clearTimeout(timer),
        closeSelf: () => undefined,
        locks: new FakeLockManager(),
        openRuntime: (request, post) => new FakeCoordinatorRuntime().open(request, post),
        postLocal: () => undefined,
        randomId: (prefix) => (prefix === "worker" ? "worker-a" : `${prefix}:test`),
        setTimer: (_callback, ms) => {
          timers.push(ms);
          return setTimeout(() => undefined, 0);
        },
        timeouts: { helloIntervalMs: 7 },
      },
    );

    await coordinator.start();
    expect(timers).toContain(7);
    await coordinator.close();
  });

  test("promotes a follower and reattaches active watches after leader death", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    });
    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 2, op: WorkerEvent.Result }),
    );

    leader.handle({
      clientId: "client-a",
      id: 3,
      op: WorkerCommand.Close,
    });

    follower.handle({
      args: { body: "after-promotion", channel: "general" },
      clientId: "client-b",
      id: 4,
      mutationId: "mutation:after-promotion",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });
    await waitFor(() => expect(harness.runtime.initCount).toBe(2));

    await waitFor(() =>
      expect(
        follower.responses.some(
          (message) =>
            message.op === WorkerEvent.WatchUpdated &&
            message.watchId === 7 &&
            Array.isArray(message.value) &&
            message.value.some(
              (row) =>
                typeof row === "object" &&
                row !== null &&
                (row as { body?: unknown }).body === "after-promotion",
            ),
        ),
      ).toBe(true),
    );
  });

  test("recovers a follower request when a stale leader never acknowledges it", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness({ fastTimers: true });
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    harness.network.drop = (channel, data) =>
      channel.endsWith(":worker:worker-b") &&
      isRecord(data) &&
      (data.op === PeerOp.RequestAck || data.op === PeerOp.Response);
    follower.handle({
      args: { body: "slow", channel: "general" },
      clientId: "client-b",
      id: 2,
      mutationId: "mutation:no-ack",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });

    await delay(20);
    leader.handle({ clientId: "client-a", id: 3, op: WorkerCommand.Close });
    harness.network.drop = undefined;

    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 2,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );
    expect(harness.runtime.mutationAttempts.get("mutation:no-ack")).toBe(2);
  });

  test("keeps requests and watches alive when leader recovery takes longer than the diagnostic timeout", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness({ fastTimers: true });
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    });
    await waitFor(() =>
      expect(follower.responses).toContainEqual({ id: 2, op: WorkerEvent.Result }),
    );

    harness.network.drop = (channel, data) =>
      channel.endsWith(":worker:worker-b") &&
      isRecord(data) &&
      (data.op === PeerOp.RequestAck || data.op === PeerOp.Response);
    follower.handle({
      args: { body: "slow", channel: "general" },
      clientId: "client-b",
      id: 3,
      mutationId: "mutation:slow-recovery",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });

    await delay(25);
    expect(
      follower.responses.some(
        (message) =>
          message.op === WorkerEvent.Result && message.id === 3 && message.error !== undefined,
      ),
    ).toBe(false);
    expect(follower.responses.some((message) => message.op === WorkerEvent.WatchFailed)).toBe(
      false,
    );

    leader.handle({ clientId: "client-a", id: 4, op: WorkerCommand.Close });
    harness.network.drop = undefined;

    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 3,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );
    await waitFor(() =>
      expect(
        follower.responses.some(
          (message) =>
            message.op === WorkerEvent.WatchUpdated &&
            message.watchId === 7 &&
            Array.isArray(message.value) &&
            message.value.some(
              (row) =>
                typeof row === "object" &&
                row !== null &&
                (row as { body?: unknown }).body === "slow",
            ),
        ),
      ).toBe(true),
    );
  });

  test("watch stop during recovery prevents stale watch replay", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness({ fastTimers: true });
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    harness.network.drop = (channel, data) =>
      channel.endsWith(":worker:worker-b") &&
      isRecord(data) &&
      (data.op === PeerOp.RequestAck || data.op === PeerOp.Response);
    follower.handle({
      args: { channel: "general" },
      clientId: "client-b",
      id: 2,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    });
    await delay(10);
    follower.handle({
      clientId: "client-b",
      id: 3,
      op: WorkerCommand.WatchStop,
      watchId: 7,
    });

    leader.handle({ clientId: "client-a", id: 4, op: WorkerCommand.Close });
    harness.network.drop = undefined;
    follower.handle({
      args: { body: "after-stop", channel: "general" },
      clientId: "client-b",
      id: 5,
      mutationId: "mutation:after-stop",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });

    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 5,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );
    await delay(10);
    expect(
      follower.responses.some(
        (message) => message.op === WorkerEvent.WatchUpdated && message.watchId === 7,
      ),
    ).toBe(false);
  });

  test("ignores stale follower responses from an old leader epoch", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    harness.network
      .channel(`${runtimeScope(identity("schema-a", "modules-a"))}:worker:worker-b`)
      .postMessage({
        leaderEpoch: "stale",
        op: PeerOp.Response,
        protocol: CoordinatorProtocol,
        response: { id: 99, result: "stale", op: WorkerEvent.Result },
      });
    await tick();

    expect(follower.responses).not.toContainEqual({
      id: 99,
      result: "stale",
      op: WorkerEvent.Result,
    });
  });

  test("retries an accepted follower mutation with the same mutation id after promotion", async () => {
    installEmbeddedIdentity("schema-a", "modules-a");
    const harness = new CoordinatorHarness();
    const leader = harness.worker("worker-a", "client-a", identity("schema-a", "modules-a"));
    const follower = harness.worker("worker-b", "client-b", identity("schema-a", "modules-a"));
    await leader.start();
    await follower.start();

    follower.handle({
      args: { body: "slow", channel: "general" },
      clientId: "client-b",
      id: 2,
      mutationId: "mutation:retry",
      name: "messages:send",
      op: WorkerCommand.Mutation,
    });
    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 2,
        mutationId: "mutation:retry",
        op: WorkerEvent.MutationAccepted,
      }),
    );

    leader.handle({ clientId: "client-a", id: 3, op: WorkerCommand.Close });

    await waitFor(() =>
      expect(follower.responses).toContainEqual({
        id: 2,
        result: "messages|1",
        op: WorkerEvent.Result,
      }),
    );
    expect(harness.runtime.mutationAttempts.get("mutation:retry")).toBe(2);
  });
});

function setNavigatorStorage(root: {
  getFileHandle(
    path: string,
    options: { create: boolean },
  ): Promise<{
    createSyncAccessHandle(options?: { mode: "readwrite" }): Promise<ReturnType<typeof syncHandle>>;
  }>;
  removeEntry?(path: string): Promise<void>;
}): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: () => Promise.resolve(root),
      },
    },
  });
}

function installLocalStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  const storage = {
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function installThrowingLocalStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        throw new Error("localStorage unavailable");
      },
      setItem() {
        throw new Error("localStorage unavailable");
      },
    },
  });
}

function syncHandle() {
  return {
    close() {},
    flush() {},
    getSize() {
      return 0;
    },
    read() {
      return 0;
    },
    truncate(_size?: number) {},
    write() {
      return 0;
    },
  };
}

function restoreGlobal(
  name:
    | "addEventListener"
    | "BroadcastChannel"
    | "DedicatedWorkerGlobalScope"
    | "location"
    | "localStorage"
    | "navigator"
    | "removeEventListener"
    | "self"
    | "SharedArrayBuffer"
    | "Worker"
    | "crossOriginIsolated",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function options() {
  return { schema, modules: { messages } };
}

function wasmModule(): WasmModule {
  return {
    apiVersion: () => 6,
    Store: {
      open: () => new MemoryBinding(),
    },
  };
}

interface MemoryDoc {
  _id: string;
  _creationTime: number;
  data: string;
}

class MemoryBinding implements StoreBinding {
  private clock = 0;
  private seq = 0;
  private readonly mutations = new Map<string, BindingMutationRecord>();
  private readonly tables = new Map<string, Map<string, MemoryDoc>>();

  setup(schema: StoreSchema): Promise<void> {
    for (const table of schema.tables) this.tables.set(table.name, new Map());
    return Promise.resolve();
  }

  clockNext(): number {
    return ++this.clock;
  }

  mutationBegin(call: BindingMutationCall): Promise<BindingMutationRecord> {
    const existing = this.mutations.get(call.mutationId);
    if (existing) return Promise.resolve(existing);
    const record: BindingMutationRecord = { mutationId: call.mutationId, status: "accepted" };
    this.mutations.set(call.mutationId, record);
    return Promise.resolve(record);
  }

  mutationFail(mutationId: string, error: string): Promise<void> {
    const record = this.mutations.get(mutationId);
    if (record && record.status !== "committed") {
      record.error = error;
      record.status = "failed";
    }
    return Promise.resolve();
  }

  commit(batch: BindingWriteBatch, options?: BindingCommitOptions) {
    for (const upsert of batch.upserts) {
      this.table(upsert.table).set(upsert.id, {
        _id: upsert.id,
        _creationTime: upsert.creationTime,
        data: upsert.data,
      });
    }
    for (const deletion of batch.deletes) {
      this.table(deletion.table).delete(deletion.id);
    }
    this.seq += 1;
    if (options?.mutationId) {
      const record = this.mutations.get(options.mutationId);
      if (record) {
        record.commitSeq = this.seq;
        record.result = options.mutationResult;
        record.status = "committed";
      }
    }
    return Promise.resolve({
      changedTables: [...new Set([...batch.upserts, ...batch.deletes].map((write) => write.table))],
      commitSeq: this.seq,
    });
  }

  docRead(table: string, id: string): Promise<string | undefined> {
    const doc = this.table(table).get(id);
    return Promise.resolve(doc ? spliceDoc(doc) : undefined);
  }

  docScan(spec: BindingScanSpec): Promise<BindingPage> {
    const text = `[${this.rows(spec.table).map(spliceDoc).join(",")}]`;
    return Promise.resolve({ cursor: null, text });
  }

  keyScan(spec: BindingScanSpec): Promise<BindingPage> {
    const rows = this.rows(spec.table);
    const text = JSON.stringify({
      ids: rows.map((doc) => doc._id),
      cts: rows.map((doc) => doc._creationTime),
    });
    return Promise.resolve({ cursor: null, text });
  }

  docCount(): Promise<number | null> {
    return Promise.resolve(null);
  }

  ledgerPrune(): Promise<BindingPruneResult> {
    return Promise.resolve({ commitsDeleted: 0, mutationsDeleted: 0 });
  }

  blobRead(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  blobWrite(): Promise<void> {
    return Promise.resolve();
  }

  blobDelete(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    for (const table of this.tables.values()) table.clear();
    return Promise.resolve();
  }

  close(): void {}

  private rows(name: string): MemoryDoc[] {
    return [...this.table(name).values()].sort(
      (a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id),
    );
  }

  private table(name: string): Map<string, MemoryDoc> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }
}

/** Mirrors the Rust page splicer: system fields plus the stored compact JSON object body. */
function spliceDoc(doc: MemoryDoc): string {
  const head = `{"_id":${JSON.stringify(doc._id)},"_creationTime":${doc._creationTime}`;
  const body = doc.data.slice(1);
  return body === "}" ? `${head}}` : `${head},${body}`;
}

class FakeRuntimeWorker implements EmbeddedWorker {
  closed = false;
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private readonly rows: MemoryDoc[] = [];
  private readonly watches = new Map<number, { channel: string }>();

  addEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.add(callback);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.delete(callback);
  }

  postMessage(message: unknown): void {
    const request = message as {
      args?: { body?: string; channel?: string };
      id: number;
      op: number;
      watchId?: number;
    };
    queueMicrotask(() => this.handle(request));
  }

  terminate(): void {
    this.closed = true;
  }

  private handle(request: {
    args?: { body?: string; channel?: string };
    id: number;
    op: number;
    watchId?: number;
  }): void {
    if (request.op === WorkerCommand.Mutation) {
      const row = {
        _creationTime: this.rows.length + 1,
        _id: `messages|${this.rows.length + 1}`,
        data: JSON.stringify({
          body: request.args?.body,
          channel: request.args?.channel,
        }),
      };
      this.rows.push(row);
      this.respond(request.id, row._id);
      this.emitWatches();
      return;
    }
    if (request.op === WorkerCommand.Query) {
      this.respond(request.id, this.query(request.args?.channel));
      return;
    }
    if (request.op === WorkerCommand.WatchStart && request.watchId !== undefined) {
      this.watches.set(request.watchId, { channel: request.args?.channel ?? "" });
      this.respond(request.id);
      return;
    }
    if (request.op === WorkerCommand.WatchStop && request.watchId !== undefined) {
      this.watches.delete(request.watchId);
      this.respond(request.id);
      return;
    }
    if (request.op === WorkerCommand.Close) {
      this.closed = true;
      this.respond(request.id);
    }
  }

  private emitWatches(): void {
    for (const [watchId, watch] of this.watches) {
      this.emit({
        op: WorkerEvent.WatchUpdated,
        value: this.query(watch.channel),
        watchId,
      });
    }
  }

  private query(channel: string | undefined): unknown[] {
    return this.rows
      .map((row) => JSON.parse(row.data) as { body: string; channel: string })
      .filter((row) => row.channel === channel)
      .map((row) => ({ body: row.body }));
  }

  private respond(id: number, result?: unknown): void {
    this.emit({ id, result, op: WorkerEvent.Result });
  }

  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class DeferredInitWorker implements EmbeddedWorker {
  readonly messages: { id: number; op: number }[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private initId: number | undefined;

  addEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.add(callback);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.delete(callback);
  }

  postMessage(message: unknown): void {
    const request = message as { id: number; op: number };
    this.messages.push(request);
    if (request.op === WorkerCommand.Init) this.initId = request.id;
    if (request.op === WorkerCommand.Close) {
      this.emit({ id: request.id, op: WorkerEvent.Result });
    }
  }

  resolveInit(): void {
    if (this.initId !== undefined) this.emit({ id: this.initId, op: WorkerEvent.Result });
  }

  terminate(): void {}

  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class SilentWorker implements EmbeddedWorker {
  closed = false;

  addEventListener(
    _type: "message" | "error" | "messageerror",
    _callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {}

  removeEventListener(
    _type: "message" | "error" | "messageerror",
    _callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {}

  postMessage(_message: unknown): void {}

  terminate(): void {
    this.closed = true;
  }
}

class AcceptedSlowMutationWorker implements EmbeddedWorker {
  closed = false;
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private mutationId: number | undefined;

  addEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.add(callback);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message") this.listeners.delete(callback);
  }

  postMessage(message: unknown): void {
    const request = message as { id: number; mutationId?: string; op: number };
    if (request.op === WorkerCommand.Init) {
      this.emit({ id: request.id, op: WorkerEvent.Result });
      return;
    }
    if (request.op === WorkerCommand.Mutation) {
      this.mutationId = request.id;
      this.emit({
        id: request.id,
        mutationId: request.mutationId ?? "test",
        op: WorkerEvent.MutationAccepted,
      });
      return;
    }
    if (request.op === WorkerCommand.Close) this.emit({ id: request.id, op: WorkerEvent.Result });
  }

  resolveMutation(result: string): void {
    if (this.mutationId !== undefined) {
      this.emit({ id: this.mutationId, result, op: WorkerEvent.Result });
    }
  }

  terminate(): void {
    this.closed = true;
  }

  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class ErrorableWorker implements EmbeddedWorker {
  closed = false;
  ready = false;
  watchStarts = 0;
  private readonly errorListeners = new Set<(event: unknown) => void>();
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();

  addEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message")
      this.messageListeners.add(callback as (event: { data: unknown }) => void);
    else this.errorListeners.add(callback as (event: unknown) => void);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    callback: ((event: { data: unknown }) => void) | ((event: unknown) => void),
  ): void {
    if (type === "message")
      this.messageListeners.delete(callback as (event: { data: unknown }) => void);
    else this.errorListeners.delete(callback as (event: unknown) => void);
  }

  postMessage(message: unknown): void {
    const request = message as { id: number; op: number };
    queueMicrotask(() => {
      if (request.op === WorkerCommand.Init) {
        this.ready = true;
        this.emit({ id: request.id, op: WorkerEvent.Result });
        return;
      }
      if (request.op === WorkerCommand.WatchStart) {
        this.watchStarts += 1;
        this.emit({ id: request.id, op: WorkerEvent.Result });
        return;
      }
      if (request.op === WorkerCommand.Close) {
        this.closed = true;
        this.emit({ id: request.id, op: WorkerEvent.Result });
      }
    });
  }

  terminate(): void {
    this.closed = true;
  }

  emit(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener({ error });
  }
}

class CoordinatorHarness {
  constructor(readonly options: { fastTimers?: boolean } = {}) {}

  readonly locks = new FakeLockManager();
  readonly network = new FakeBroadcastNetwork();
  readonly runtime = new FakeCoordinatorRuntime();

  worker(
    workerId: string,
    clientId: string,
    runtimeIdentity: RuntimeIdentity,
  ): CoordinatorWorkerHarness {
    return new CoordinatorWorkerHarness(this, workerId, clientId, runtimeIdentity);
  }
}

class CoordinatorWorkerHarness {
  readonly responses: WorkerResponse[] = [];
  private readonly coordinator: CoordinatorRuntime;

  constructor(
    harness: CoordinatorHarness,
    workerId: string,
    clientId: string,
    runtimeIdentity: RuntimeIdentity,
  ) {
    this.coordinator = createCoordinatorRuntime(
      {
        clientId,
        debug: false,
        id: 1,
        identity: runtimeIdentity,
        op: WorkerCommand.Init,
        storagePath: "test-browser.db",
      },
      {
        assertCapabilities: () => undefined,
        channels: { open: (name) => harness.network.channel(name) },
        closeSelf: () => undefined,
        openRuntime: (request, post) => harness.runtime.open(request, post),
        locks: harness.locks,
        postLocal: (message) => this.responses.push(message),
        randomId: (prefix) => (prefix === "worker" ? workerId : `${prefix}:${workerId}`),
        ...(harness.options.fastTimers
          ? {
              timeouts: {
                attachTimeoutMs: 5,
                forwardAckTimeoutMs: 5,
                helloIntervalMs: 5,
                leaderRecoveryTimeoutMs: 5,
              },
            }
          : {}),
      },
    );
  }

  start(): Promise<void> {
    return this.coordinator.start();
  }

  handle(request: WorkerRequest): void {
    this.coordinator.handle(request);
  }
}

class FakeLockManager {
  readonly requests: string[] = [];
  private readonly held = new Set<string>();
  private readonly queues = new Map<
    string,
    Array<{
      callback(): Promise<unknown>;
      reject(error: unknown): void;
      resolve(value: unknown): void;
    }>
  >();

  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    this.requests.push(name);
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      queue.push({
        callback: async () => callback(),
        reject,
        resolve: (value) => resolve(value as T),
      });
      this.queues.set(name, queue);
      this.drain(name);
    });
  }

  private drain(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name);
    const next = queue?.shift();
    if (!next) return;
    this.held.add(name);
    void Promise.resolve()
      .then(() => next.callback())
      .then(
        (value) => next.resolve(value),
        (error) => next.reject(error),
      )
      .finally(() => {
        this.held.delete(name);
        this.drain(name);
      });
  }
}

class FakeBroadcastNetwork {
  drop: ((channel: string, data: unknown) => boolean) | undefined;
  readonly messages: Array<{ channel: string; data: unknown }> = [];
  private readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  channel(name: string): FakeBroadcastChannel {
    const channel = new FakeBroadcastChannel(this, name);
    const channels = this.channels.get(name) ?? new Set<FakeBroadcastChannel>();
    channels.add(channel);
    this.channels.set(name, channels);
    return channel;
  }

  close(channel: FakeBroadcastChannel): void {
    this.channels.get(channel.name)?.delete(channel);
  }

  post(sender: FakeBroadcastChannel, message: unknown): void {
    this.messages.push({ channel: sender.name, data: message });
    if (this.drop?.(sender.name, message)) return;
    for (const channel of this.channels.get(sender.name) ?? []) {
      if (channel === sender) continue;
      queueMicrotask(() => channel.emit(message));
    }
  }
}

class FakeBroadcastChannel {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  constructor(
    private readonly network: FakeBroadcastNetwork,
    readonly name: string,
  ) {}

  addEventListener(type: "message", callback: (event: { data: unknown }) => void): void {
    if (type === "message") this.listeners.add(callback);
  }

  removeEventListener(type: "message", callback: (event: { data: unknown }) => void): void {
    if (type === "message") this.listeners.delete(callback);
  }

  postMessage(message: unknown): void {
    this.network.post(this, message);
  }

  close(): void {
    this.listeners.clear();
    this.network.close(this);
  }

  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class FakeCoordinatorRuntime {
  initCount = 0;
  queryError: Error | undefined;
  readonly mutationAttempts = new Map<string, number>();
  private readonly rows: Array<{ body: string; channel: string; id: string }> = [];
  private readonly watchers = new Set<{
    args: Record<string, unknown>;
    callback(value: unknown): void;
    onError: ((error: unknown) => void) | undefined;
  }>();

  open(
    _request: Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>,
    _post: (message: WorkerResponse) => void,
  ): Promise<WorkerState> {
    this.initCount += 1;
    return Promise.resolve({
      opfs: { closeAll() {} } as WorkerState["opfs"],
      runner: this.runner(),
      stops: new Map(),
      store: { close() {} } as WorkerState["store"],
    });
  }

  private runner(): Runner {
    return {
      runQuery: async (_ref, args = {}) => {
        if (this.queryError) throw this.queryError;
        return this.query(args.channel);
      },
      runMutation: async (_ref, args = {}, options: RunMutationOptions = {}) => {
        const mutationId = options.mutationId ?? "missing";
        const attempts = (this.mutationAttempts.get(mutationId) ?? 0) + 1;
        this.mutationAttempts.set(mutationId, attempts);
        options.onAccepted?.(mutationId);
        if (args.body === "slow" && attempts === 1) {
          return new Promise<never>(() => undefined);
        }
        const id = `messages|${this.rows.length + 1}`;
        this.rows.push({
          body: stringArg(args.body),
          channel: stringArg(args.channel),
          id,
        });
        this.emit();
        return id;
      },
      onUpdate: (_ref, args, callback, onError) => {
        const watcher = { args, callback, onError };
        this.watchers.add(watcher);
        queueMicrotask(() => this.emitWatcher(watcher));
        return () => {
          this.watchers.delete(watcher);
        };
      },
    };
  }

  private emit(): void {
    for (const watcher of this.watchers) {
      this.emitWatcher(watcher);
    }
  }

  private emitWatcher(watcher: {
    args: Record<string, unknown>;
    callback(value: unknown): void;
    onError: ((error: unknown) => void) | undefined;
  }): void {
    if (this.queryError) {
      watcher.onError?.(this.queryError);
      return;
    }
    watcher.callback(this.query(watcher.args.channel));
  }

  private query(channel: unknown): Array<{ body: string; channel: string }> {
    return this.rows
      .filter((row) => row.channel === channel)
      .map((row) => ({ body: row.body, channel: row.channel }));
  }
}

function installEmbeddedIdentity(schemaHash: string, moduleGraphHash: string): void {
  setEmbeddedIdentity({ moduleGraphHash, schemaHash });
}

function installCoordinatorGlobals(
  options: {
    broadcastChannel?: boolean;
    crossOriginIsolated?: boolean;
    locks?: boolean;
  } = {},
): void {
  class DedicatedWorker {}
  class TestWorker {}
  class TestSharedArrayBuffer {}
  Object.defineProperty(globalThis, "DedicatedWorkerGlobalScope", {
    configurable: true,
    value: DedicatedWorker,
  });
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: new DedicatedWorker(),
  });
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: options.broadcastChannel === false ? undefined : NoopBroadcastChannel,
  });
  Object.defineProperty(globalThis, "SharedArrayBuffer", {
    configurable: true,
    value: TestSharedArrayBuffer,
  });
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    configurable: true,
    value: options.crossOriginIsolated ?? true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: options.locks === false ? undefined : new FakeLockManager(),
      storage: {
        getDirectory: () => Promise.resolve({}),
      },
    },
  });
}

class NoopBroadcastChannel {
  constructor(readonly _name: string) {}

  addEventListener(_type: "message", _callback: (event: { data: unknown }) => void): void {}

  removeEventListener(_type: "message", _callback: (event: { data: unknown }) => void): void {}

  postMessage(_message: unknown): void {}

  close(): void {}
}

function coordinatorInitRequest(
  clientId: string,
  runtimeIdentity: RuntimeIdentity,
): Extract<WorkerRequest, { op: typeof WorkerCommand.Init }> {
  return {
    clientId,
    id: 1,
    identity: runtimeIdentity,
    op: WorkerCommand.Init,
    storagePath: "test-browser.db",
  };
}

function identity(schemaHash: string, moduleGraphHash: string): RuntimeIdentity {
  return {
    moduleGraphHash,
    packageVersion: "0.0.0",
    protocolVersion: 3,
    schemaHash,
    storageId: "origin",
    wasmAbiVersion: 6,
  };
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function forwardedRequests(harness: CoordinatorHarness, targetWorkerId: string): WorkerRequest[] {
  return harness.network.messages
    .filter(
      (message) =>
        message.channel.endsWith(`:worker:${targetWorkerId}`) &&
        isRecord(message.data) &&
        message.data.op === PeerOp.Request &&
        isRecord(message.data.request),
    )
    .map((message) => (message.data as { request: WorkerRequest }).request);
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(5);
    }
  }
  throw lastError;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
