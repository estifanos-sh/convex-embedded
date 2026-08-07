import { describe, expect, test } from "vite-plus/test";
import { makeFunctionReference } from "convex/server";

import { EMBEDDED_EPOCH } from "../../src/abi";
import { EmbeddedClient } from "../../src/client";
import { WASM_API_VERSION } from "../../src/browser/artifact";
import {
  ConvexEmbeddedClient,
  createBrowserStorageOwnership,
  installBrowserNetworkLifecycle,
  setBrowserLocalModules,
} from "../../src/browser/client";
import { BrowserLifecycleRunner, installPageLifecycle } from "../../src/browser/lifecycle";
import type { WorkerRunner } from "../../src/browser/proxy";
import { WorkerEvent, type EmbeddedWorker, type RuntimeIdentity } from "../../src/browser/protocol";
import type { DiagnosticEvent as EmbeddedEvent } from "../../src/events";
import { readDevtoolsBridge } from "../../src/devtools/bridge";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import type { Runner } from "../../src/runtime/runner";
import type { RemoteMutationSettlement, RemoteTick } from "../../src/storage/types";
import { setEmbeddedIdentity } from "../../src/browser/identity";
import { defineLocal, stampLocal } from "../../src/local/internal";
import { defineEmbeddedSchema } from "../../src/schema";
import { v } from "convex/values";

type PageLocks = NonNullable<Parameters<typeof createBrowserStorageOwnership>[1]>;

function identity(storageId: string): RuntimeIdentity {
  return {
    moduleGraphHash: "modules",
    packageVersion: "0.0.0",
    protocolVersion: EMBEDDED_PROTOCOL_VERSION,
    schemaHash: "schema",
    storageId,
    storeFormatVersion: EMBEDDED_EPOCH,
    wasmAbiVersion: WASM_API_VERSION,
  };
}

describe("browser page lifecycle", () => {
  test("suspends while hidden or frozen and resumes in place without reloading", () => {
    const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
    const document = {
      addEventListener: (type: string, callback: (event: { persisted?: boolean }) => void) =>
        listeners.set(`document:${type}`, callback),
      removeEventListener: (type: string) => listeners.delete(`document:${type}`),
      visibilityState: "visible",
    };
    let suspends = 0;
    let resumes = 0;
    const cleanup = installPageLifecycle(
      () => {
        suspends += 1;
      },
      () => {
        resumes += 1;
      },
      {
        addEventListener: (type, callback) => listeners.set(type, callback),
        document,
        removeEventListener: (type) => listeners.delete(type),
      },
    );

    document.visibilityState = "hidden";
    listeners.get("document:visibilitychange")?.({});
    listeners.get("freeze")?.({});
    listeners.get("pagehide")?.({ persisted: false });
    expect(suspends).toBe(3);
    document.visibilityState = "visible";
    listeners.get("document:visibilitychange")?.({});
    listeners.get("pageshow")?.({ persisted: false });
    listeners.get("resume")?.({});
    expect(resumes).toBe(3);

    cleanup();
    expect(listeners.size).toBe(0);
  });

  test("replaces the worker generation and reattaches watches without publishing teardown errors", async () => {
    const callbacks: Array<(value: unknown) => void> = [];
    const watchErrors: Array<(error: unknown) => void> = [];
    const closed: string[] = [];
    const opened: WorkerRunner[] = [];
    const makeRunner = (): WorkerRunner => {
      const runner = {
        close: async () => undefined,
        devtools: async () => undefined,
        handleUpload: async () => ({ storageId: "upload" }),
        identity: { read: async () => undefined, write: async () => undefined },
        invalidate: () => undefined,
        onUpdate: (
          _ref: unknown,
          _args: unknown,
          callback: (value: unknown) => void,
          onError: (error: unknown) => void,
        ) => {
          callbacks.push(callback);
          watchErrors.push(onError);
          return () => undefined;
        },
        remote: {
          identity: { read: async () => undefined },
          network: { write: async () => undefined },
          scope: { write: async () => undefined },
        },
        rerunResults: () => undefined,
        route: async () => ({ execution: "local" }),
        runAction: async () => undefined,
        runMutation: async () => undefined,
        runQuery: async () => undefined,
        storage: { owner: { write: async () => undefined } },
        subscribeEvents: () => () => undefined,
      } as unknown as WorkerRunner;
      opened.push(runner);
      return runner;
    };
    let generation = 0;
    const runtime = new BrowserLifecycleRunner(() => {
      const name = `worker-${generation++}`;
      const runner = makeRunner();
      return {
        close: () => {
          closed.push(`${name}:close`);
        },
        closeNow: () => {
          closed.push(`${name}:terminate`);
        },
        eagerRunner: runner,
        runner,
      };
    });
    const values: unknown[] = [];
    const errors: unknown[] = [];
    const stop = runtime.onUpdate(
      "documents:read" as never,
      {},
      (value) => values.push(value),
      (error) => errors.push(error),
    );

    callbacks[0]?.("first");
    runtime.suspend();
    watchErrors[0]?.(new Error("worker teardown"));
    await runtime.resume();
    callbacks[1]?.("second");

    expect(opened).toHaveLength(2);
    expect(closed).toEqual(["worker-0:terminate"]);
    expect(values).toEqual(["first", "second"]);
    expect(errors).toEqual([]);

    stop();
    await runtime.close();
    expect(closed).toEqual(["worker-0:terminate", "worker-1:close"]);
  });

  test("keeps a temporary memory store alive while the page is hidden", async () => {
    let emit: ((event: EmbeddedEvent) => void) | undefined;
    let terminated = 0;
    const runner = {
      close: async () => undefined,
      devtools: async () => undefined,
      handleUpload: async () => ({ storageId: "upload" }),
      identity: { read: async () => undefined, write: async () => undefined },
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
      remote: {
        identity: { read: async () => undefined },
        network: { write: async () => undefined },
        scope: { write: async () => undefined },
      },
      rerunResults: () => undefined,
      route: async () => ({ execution: "local" }),
      runAction: async () => undefined,
      runMutation: async () => undefined,
      runQuery: async () => undefined,
      storage: { owner: { write: async () => undefined } },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emit = listener;
        return () => undefined;
      },
    } as unknown as WorkerRunner;
    const runtime = new BrowserLifecycleRunner(() => ({
      close: () => undefined,
      closeNow: () => {
        terminated += 1;
      },
      eagerRunner: runner,
      runner,
    }));

    emit?.({ at: 1, degradation: "temporary-storage", type: "runtime" });
    runtime.suspend();

    expect(terminated).toBe(0);
    await expect(runtime.runQuery("documents:read" as never)).rejects.toThrow(
      "browser runtime is suspended",
    );
    await runtime.resume();
    await expect(runtime.runQuery("documents:read" as never)).resolves.toBeUndefined();
    expect(terminated).toBe(0);
    await runtime.close();
  });
});

describe("browser storage ownership", () => {
  test("holds initial ownership in the page until close", async () => {
    let held = false;
    const locks = {
      request: async <T>(
        _name: string,
        _options: { ifAvailable: true } | { signal: AbortSignal },
        callback: (lock: object | null) => T | Promise<T>,
      ) => {
        held = true;
        try {
          return await callback({});
        } finally {
          held = false;
        }
      },
    } as PageLocks;
    const ownership = createBrowserStorageOwnership(identity("page-owner-test"), locks);

    await expect(ownership.initial).resolves.toBe(true);
    expect(held).toBe(true);

    ownership.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toBe(false);
  });

  test("starts as a follower and reports a later page-level handoff", async () => {
    let queued: ((lock: object | null) => unknown) | undefined;
    let queuedSignal: AbortSignal | undefined;
    const locks = {
      request: <T>(
        _name: string,
        options: { ifAvailable: true } | { signal: AbortSignal },
        callback: (lock: object | null) => T | Promise<T>,
      ): Promise<T> => {
        if ("ifAvailable" in options) return Promise.resolve(callback(null));
        queued = callback;
        queuedSignal = options.signal;
        return new Promise<T>((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    } as PageLocks;
    const ownership = createBrowserStorageOwnership(identity("page-follower-test"), locks);

    await expect(ownership.initial).resolves.toBe(false);
    await Promise.resolve();
    let acquired = 0;
    ownership.bind(
      () => {
        acquired += 1;
      },
      () => undefined,
    );
    void queued?.({});
    await Promise.resolve();
    expect(acquired).toBe(1);

    ownership.close();
    expect(queuedSignal?.aborted).toBe(true);
  });

  test("releases ownership when close races the queued lock callback", async () => {
    let queued: ((lock: object | null) => unknown) | undefined;
    let queuedResult: Promise<unknown> | undefined;
    const locks = {
      request: <T>(
        _name: string,
        options: { ifAvailable: true } | { signal: AbortSignal },
        callback: (lock: object | null) => T | Promise<T>,
      ): Promise<T> => {
        if ("ifAvailable" in options) return Promise.resolve(callback(null));
        let granted = false;
        queued = callback;
        queuedResult = new Promise<T>((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              if (!granted) reject(options.signal.reason);
            },
            { once: true },
          );
          queued = (lock) => {
            granted = true;
            const result = Promise.resolve(callback(lock));
            result.then(resolve, reject);
            return result;
          };
        });
        return queuedResult as Promise<T>;
      },
    } as PageLocks;
    const ownership = createBrowserStorageOwnership(identity("page-owner-race-test"), locks);

    await expect(ownership.initial).resolves.toBe(false);
    await Promise.resolve();
    ownership.bind(
      () => ownership.close(),
      () => undefined,
    );
    void queued?.({});

    await expect(queuedResult).resolves.toBeUndefined();
  });

  test("fails before worker startup when Web Locks are unavailable", async () => {
    const ownership = createBrowserStorageOwnership(
      identity("page-owner-unsupported-test"),
      null as unknown as PageLocks,
    );

    await expect(ownership.initial).rejects.toThrow("requires Web Locks support");
  });

  test("closing before the initial lock callback settles ownership", async () => {
    const locks = {
      request: <T>(
        _name: string,
        _options: { ifAvailable: true } | { signal: AbortSignal },
        _callback: (lock: object | null) => T | Promise<T>,
      ): Promise<T> => new Promise<T>(() => undefined),
    } as PageLocks;
    const ownership = createBrowserStorageOwnership(identity("page-owner-close-test"), locks);

    ownership.close();

    await expect(ownership.initial).rejects.toThrow("storage ownership closed");
  });
});

describe("local browser runtime cache", () => {
  test("rejects a setup from another graph before creating a worker", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const local = defineLocal(defineEmbeddedSchema({}));
    const stale = local.internalAction({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    stampLocal("local/setup", "stale-modules", { stale });
    let workers = 0;
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          workers += 1;
        }
      },
    });
    const client = new ConvexEmbeddedClient();
    try {
      await expect(client.open(stale)).rejects.toThrow("loaded browser module graph");
      expect(workers).toBe(0);
    } finally {
      await client.close();
      if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
      else Reflect.deleteProperty(globalThis, "Worker");
    }
  });

  test("rejects an unknown same-graph setup reference before creating a worker", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    const local = defineLocal(defineEmbeddedSchema({}));
    const missing = local.internalAction({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    stampLocal("local/missing", "modules", { missing });
    setBrowserLocalModules({ "local/registered": async () => ({}) });
    let workers = 0;
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          workers += 1;
        }
      },
    });
    const client = new ConvexEmbeddedClient();
    try {
      await expect(client.open(missing)).rejects.toThrow("not registered");
      expect(workers).toBe(0);
    } finally {
      await client.close();
      setBrowserLocalModules(undefined);
      if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
      else Reflect.deleteProperty(globalThis, "Worker");
    }
  });

  test("evicts a worker whose initialization failed before the next client starts", async () => {
    setEmbeddedIdentity({ moduleGraphHash: "modules", schemaHash: "schema" });
    interface FakeWorker extends EmbeddedWorker {
      emit(message: unknown): void;
    }
    const workers: FakeWorker[] = [];
    class WorkerStub {
      private readonly listeners = new Set<(event: { data: unknown }) => void>();

      constructor() {
        workers.push(this as unknown as FakeWorker);
      }

      addEventListener(type: string, callback: (event: unknown) => void): void {
        if (type === "message") this.listeners.add(callback as (event: { data: unknown }) => void);
      }

      removeEventListener(type: string, callback: (event: unknown) => void): void {
        if (type === "message")
          this.listeners.delete(callback as (event: { data: unknown }) => void);
      }

      postMessage(): void {}
      start(): void {}
      terminate(): void {}

      emit(message: unknown): void {
        for (const listener of this.listeners) listener({ data: message });
      }
    }
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const locks = {
      request: async <T>(
        _name: string,
        _options: { ifAvailable: true } | { signal: AbortSignal },
        callback: (lock: object | null) => T | Promise<T>,
      ): Promise<T> => await callback({}),
    } as PageLocks;
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerStub });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks, storage: { persist: async () => true } },
    });
    try {
      const first = new ConvexEmbeddedClient();
      const firstOpen = first.open();
      await Promise.resolve();
      await Promise.resolve();
      workers[0]?.emit({
        error: { message: "init failed", name: "Error" },
        op: WorkerEvent.Terminal,
      });
      await expect(firstOpen).rejects.toThrow("init failed");

      const second = new ConvexEmbeddedClient();
      const secondOpen = second.open();
      await Promise.resolve();
      expect(workers).toHaveLength(2);
      workers[1]?.emit({
        error: { message: "done", name: "Error" },
        op: WorkerEvent.Terminal,
      });
      await expect(secondOpen).rejects.toThrow("done");
      await second.close();
    } finally {
      if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
      else Reflect.deleteProperty(globalThis, "Worker");
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

describe("browser network lifecycle", () => {
  test("reports delayed offline and online transitions in arrival order", async () => {
    const listeners = new Map<string, () => void>();
    const writes: boolean[] = [];
    const cleanup = installBrowserNetworkLifecycle(
      "https://deployment.convex.cloud",
      (online) => writes.push(online),
      {
        addEventListener: (type, callback) => listeners.set(type, callback),
        navigator: { onLine: false },
        removeEventListener: (type) => listeners.delete(type),
      },
    );

    await Promise.resolve();
    expect(writes).toEqual([false]);
    listeners.get("online")?.();
    listeners.get("offline")?.();
    expect(writes).toEqual([false, true, false]);

    cleanup();
    expect(listeners.size).toBe(0);
  });

  test("does not infer reachability with an HTTP probe", async () => {
    const writes: boolean[] = [];
    let fetches = 0;
    const cleanup = installBrowserNetworkLifecycle(
      "https://deployment.convex.cloud",
      (online) => writes.push(online),
      {
        addEventListener: () => undefined,
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
        navigator: { onLine: true },
        removeEventListener: () => undefined,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([]);
    expect(fetches).toBe(0);

    cleanup();
  });
});

describe("connection invariants", () => {
  test("observes an eager remote frame before its runner resolves without double subscribing", async () => {
    let resolveRunner: (runner: Runner) => void = () => undefined;
    const pendingRunner = new Promise<Runner>((resolve) => {
      resolveRunner = resolve;
    });
    let eventSubscriptions = 0;
    let settlementSubscriptions = 0;
    let emit: ((event: EmbeddedEvent) => void) | undefined;
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        eventSubscriptions += 1;
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
      subscribeRemoteSettlements: () => {
        settlementSubscriptions += 1;
        return () => undefined;
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({
      eagerRunner: runner,
      remoteConfigured: true,
      runner: pendingRunner,
    });
    try {
      expect(eventSubscriptions).toBe(1);
      expect(settlementSubscriptions).toBe(1);

      emit?.({
        at: 1,
        attempt: 1,
        generation: 1,
        incarnation: "first-owner",
        leaderFence: "1",
        sequence: 1,
        status: "offline",
        type: "remote",
      });
      expect(client.connectionState().replication).toEqual({ status: "offline" });

      resolveRunner(runner);
      await client.open();
      expect(eventSubscriptions).toBe(1);
      expect(settlementSubscriptions).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("releases eager runner ownership when initialization rejects", async () => {
    let eventStops = 0;
    let settlementStops = 0;
    let closes = 0;
    const cleanup: string[] = [];
    const eagerRunner = {
      subscribeEvents: () => () => {
        eventStops += 1;
        cleanup.push("events");
      },
      subscribeRemoteSettlements: () => () => {
        settlementStops += 1;
        cleanup.push("settlements");
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({
      close: async () => {
        closes += 1;
        cleanup.push("owner");
      },
      eagerRunner,
      remoteConfigured: true,
      runner: Promise.reject(new Error("runner initialization failed")),
    });
    try {
      await expect(client.open()).rejects.toThrow("runner initialization failed");
      expect(eventStops).toBe(1);
      expect(settlementStops).toBe(1);
      expect(closes).toBe(1);
      expect(cleanup).toEqual(["events", "settlements", "owner"]);
      expect(client.connectionState().local.status).toBe("failed");

      await client.close();
      expect(eventStops).toBe(1);
      expect(settlementStops).toBe(1);
      expect(closes).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("closes a pending prebuilt runner after it resolves", async () => {
    let resolveRunner: (runner: Runner) => void = () => undefined;
    const pendingRunner = new Promise<Runner>((resolve) => {
      resolveRunner = resolve;
    });
    const cleanup: string[] = [];
    const runner = {
      subscribeEvents: () => () => cleanup.push("events"),
      subscribeRemoteSettlements: () => () => cleanup.push("settlements"),
    } as unknown as Runner;
    const client = new EmbeddedClient({
      close: () => {
        cleanup.push("owner");
      },
      eagerRunner: runner,
      runner: pendingRunner,
    });
    const closing = client.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveRunner(runner);
    await closing;
    expect(cleanup).toEqual(["events", "settlements", "owner"]);
  });

  test("local mutations do not allocate replication metadata", async () => {
    let runOptions: Parameters<Runner["runMutation"]>[2];
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      route: async () => ({ execution: "local", placement: "local" }),
      runMutation: async (_ref: unknown, _args: unknown, options: typeof runOptions) => {
        runOptions = options;
        return "saved";
      },
      subscribeEvents: () => () => undefined,
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, runner });
    try {
      const mutation = makeFunctionReference<"mutation", Record<string, never>, string>(
        "preferences:save",
      );
      await expect(client.mutation(mutation, {})).resolves.toBe("saved");
      expect(runOptions).not.toHaveProperty("mutationId");
      expect(runOptions).not.toHaveProperty("pushCall");
      expect(runOptions).not.toHaveProperty("onTiming");

      const stopDevtools = readDevtoolsBridge(client).subscribe(() => undefined);
      await expect(client.mutation(mutation, {})).resolves.toBe("saved");
      expect(runOptions).toHaveProperty("onTiming", expect.any(Function));
      stopDevtools();
    } finally {
      await client.close();
    }
  });

  test("does not retain upload diagnostics unless the private devtools bridge observes", async () => {
    let uploads = 0;
    const runner = {
      handleUpload: async () => {
        uploads += 1;
        return { storageId: `upload-${uploads}` };
      },
      identity: { read: async () => undefined, write: async () => undefined },
      subscribeEvents: () => () => undefined,
    } as unknown as Runner;
    class TestClient extends EmbeddedClient {
      upload(url: string, blob: Blob): Promise<{ storageId: string }> {
        return this.handleUploadUrl(url, blob);
      }
    }
    const client = new TestClient({ eagerRunner: runner, runner });
    const blob = new Blob(["upload"], { type: "text/plain" });
    try {
      await expect(client.upload("/upload/one", blob)).resolves.toEqual({ storageId: "upload-1" });
      const bridge = readDevtoolsBridge(client);
      expect(bridge.snapshot().uploads).toEqual([]);

      const stop = bridge.subscribe(() => undefined);
      await expect(client.upload("/upload/two", blob)).resolves.toEqual({ storageId: "upload-2" });
      expect(bridge.snapshot().uploads).toMatchObject([
        {
          contentType: "text/plain",
          size: 6,
          status: "success",
          storageId: "upload-2",
          url: "/upload/two",
        },
      ]);
      stop();
    } finally {
      await client.close();
    }
  });

  test("local readiness never implies remote readiness", async () => {
    let emit: ((event: EmbeddedEvent) => void) | undefined;
    const runner = {
      identity: {
        read: async () => undefined,
        write: async () => undefined,
      },
      remote: { identity: { read: async () => undefined } },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emit = listener;
        return () => undefined;
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({
      eagerRunner: runner,
      remoteConfigured: true,
      runner,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.connectionState()).toMatchObject({
        local: { status: "ready" },
        replication: { status: "starting" },
      });

      emit?.({ at: 1, attempt: 0, status: "started", type: "remote" });
      expect(client.connectionState().replication.status).toBe("starting");

      emit?.({ at: 2, attempt: 1, status: "connected", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });

      emit?.({ at: 3, attempt: 2, status: "tick", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });

      emit?.({
        at: 4,
        attempt: 3,
        status: "idle",
        tick: {
          changedTables: [],
          pending: {
            checkpoints: 0,
            inflight: 0,
            mutations: 0,
            scope: 0,
            settlements: 0,
            uploads: 0,
          },
          pullAttempted: 0,
          pushAccepted: 0,
          pushAttempted: 0,
          pushConflicts: 0,
          pushFailed: 0,
          pushRebases: 0,
          pushed: 0,
          received: 0,
          reconnected: false,
          retainedRevisions: 0,
          rowsApplied: 0,
          sent: 0,
          receiptsPushed: 0,
          storeJobs: 0,
        },
        type: "remote",
      });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "idle" });

      emit?.({ at: 5, attempt: 4, status: "connected", type: "remote" });
      emit?.({ at: 6, attempt: 5, status: "tick", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "idle" });
    } finally {
      await client.close();
    }
  });

  test("progress after an offline transition does not claim convergence", async () => {
    let emit: ((event: EmbeddedEvent) => void) | undefined;
    const runner = {
      identity: {
        read: async () => undefined,
        write: async () => undefined,
      },
      remote: { identity: { read: async () => undefined } },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emit = listener;
        return () => undefined;
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, remoteConfigured: true, runner });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({ at: 1, attempt: 1, status: "offline", type: "remote" });
      emit?.({ at: 2, attempt: 2, status: "tick", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "offline" });
    } finally {
      await client.close();
    }
  });

  test("a permanent pull diagnostic survives reconnect events until a snapshot succeeds", async () => {
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
    const tick = {
      changedTables: [],
      pending: {
        checkpoints: 0,
        inflight: 0,
        mutations: 0,
        scope: 0,
        settlements: 0,
        uploads: 0,
      },
      pullAttempted: 0,
      pushAccepted: 0,
      pushAttempted: 0,
      pushConflicts: 0,
      pushFailed: 0,
      pushRebases: 0,
      pushed: 0,
      received: 0,
      reconnected: false,
      retainedRevisions: 0,
      rowsApplied: 0,
      sent: 0,
      receiptsPushed: 0,
      storeJobs: 0,
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({
        at: 1,
        attempt: 1,
        error: "snapshot could not be applied",
        status: "error",
        tick: { ...tick, pullDiagnostics: 1, pullError: "snapshot could not be applied" },
        type: "remote",
      });
      emit?.({
        at: 2,
        attempt: 2,
        error: "[convex-embedded:remote] remote command channel closed",
        status: "error",
        type: "remote",
      });
      expect(client.connectionState()).toEqual({
        local: { persistence: "durable", status: "ready" },
        replication: {
          error: { code: "EMBEDDED_REPLICATION", message: "snapshot could not be applied" },
          status: "error",
        },
      });
      emit?.({
        at: 3,
        attempt: 3,
        status: "offline",
        tick: { ...tick, connected: false },
        type: "remote",
      });
      emit?.({
        at: 4,
        attempt: 4,
        status: "idle",
        tick: { ...tick, connected: true },
        type: "remote",
      });
      expect(client.connectionState()).toEqual({
        local: { persistence: "durable", status: "ready" },
        replication: {
          error: { code: "EMBEDDED_REPLICATION", message: "snapshot could not be applied" },
          status: "error",
        },
      });

      emit?.({
        at: 5,
        attempt: 5,
        status: "idle",
        tick: { ...tick, connected: true, pullSnapshots: 1 },
        type: "remote",
      });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "idle" });
    } finally {
      await client.close();
    }
  });

  test("a retryable remote diagnostic remains connecting instead of becoming terminal", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({
        at: 1,
        attempt: 1,
        error: "network unavailable",
        nextRunAt: 501,
        status: "starting",
        type: "remote",
      });

      expect(client.connectionState()).toEqual({
        local: { persistence: "durable", status: "ready" },
        replication: { status: "starting" },
      });
    } finally {
      await client.close();
    }
  });

  test("generation and sequence fences reject stale connection regressions", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({
        at: 1,
        attempt: 1,
        generation: 2,
        incarnation: "first-owner",
        sequence: 1,
        status: "connected",
        type: "remote",
      });
      emit?.({ at: 2, attempt: 1, generation: 1, sequence: 99, status: "offline", type: "remote" });
      emit?.({ at: 3, attempt: 1, generation: 2, sequence: 1, status: "offline", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });

      emit?.({ at: 4, attempt: 1, generation: 2, sequence: 2, status: "started", type: "remote" });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });

      // An ownership handoff starts a new ordering domain: sequence one is fresh even though the
      // prior incarnation reached sequence two.
      emit?.({
        at: 5,
        attempt: 1,
        generation: 2,
        incarnation: "next-owner",
        sequence: 1,
        status: "offline",
        type: "remote",
      });
      expect(client.connectionState().replication).toEqual({ status: "offline" });
    } finally {
      await client.close();
    }
  });

  test("idle cannot claim synced while the authoritative actor has pending work", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({
        at: 1,
        attempt: 1,
        generation: 1,
        sequence: 1,
        status: "idle",
        tick: {
          changedTables: [],
          pending: {
            checkpoints: 0,
            inflight: 1,
            mutations: 1,
            scope: 0,
            settlements: 0,
            uploads: 0,
          },
          pullAttempted: 0,
          pushAccepted: 0,
          pushAttempted: 0,
          pushConflicts: 0,
          pushFailed: 0,
          pushRebases: 0,
          pushed: 0,
          received: 0,
          reconnected: false,
          retainedRevisions: 0,
          rowsApplied: 0,
          sent: 0,
          receiptsPushed: 0,
          storeJobs: 0,
        },
        type: "remote",
      });
      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });
    } finally {
      await client.close();
    }
  });

  test("publishes only changed nested connection snapshots and closes terminally", async () => {
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
    const states: unknown[] = [];
    const reported: unknown[] = [];
    const reportError = globalThis.reportError;
    Object.defineProperty(globalThis, "reportError", {
      configurable: true,
      value: (error: unknown) => reported.push(error),
      writable: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      emit?.({ at: 0, attempt: 0, status: "connected", type: "remote" });
      const lateStates: unknown[] = [];
      const stopLate = client.subscribeToConnectionState((state) => lateStates.push(state));
      await Promise.resolve();
      expect(lateStates).toEqual([]);
      stopLate();

      const stopThrowing = client.subscribeToConnectionState(() => {
        throw new Error("listener failure");
      });
      const stop = client.subscribeToConnectionState((state) => states.push(state));

      // No initial replay. Two semantic transitions in one turn coalesce to the latest snapshot.
      emit?.({ at: 1, attempt: 1, status: "connected", type: "remote" });
      emit?.({
        at: 2,
        attempt: 2,
        status: "idle",
        tick: remoteTickEventTick({
          pending: {
            checkpoints: 0,
            inflight: 0,
            mutations: 0,
            scope: 0,
            settlements: 0,
            uploads: 0,
          },
        }),
        type: "remote",
      });
      expect(states).toEqual([]);
      await Promise.resolve();
      expect(states).toEqual([
        {
          local: { persistence: "durable", status: "ready" },
          replication: { status: "online", sync: "idle" },
        },
      ]);
      expect(reported).toHaveLength(1);

      // A structural duplicate does not notify, and unsubscription is idempotent.
      emit?.({
        at: 3,
        attempt: 3,
        status: "idle",
        tick: remoteTickEventTick({
          pending: {
            checkpoints: 0,
            inflight: 0,
            mutations: 0,
            scope: 0,
            settlements: 0,
            uploads: 0,
          },
        }),
        type: "remote",
      });
      await Promise.resolve();
      expect(states).toHaveLength(1);
      stop();
      stop();
      stopThrowing();
      await client.close();
      await Promise.resolve();
      expect(client.connectionState()).toEqual({
        local: { status: "closed" },
        replication: { status: "closed" },
      });

      let postCloseCalls = 0;
      const stopPostClose = client.subscribeToConnectionState(() => {
        postCloseCalls += 1;
      });
      emit?.({ at: 4, attempt: 4, status: "connected", type: "remote" });
      await Promise.resolve();
      expect(postCloseCalls).toBe(0);
      stopPostClose();
      stopPostClose();
      expect(client.connectionState()).toEqual({
        local: { status: "closed" },
        replication: { status: "closed" },
      });
    } finally {
      if (reportError === undefined) {
        Reflect.deleteProperty(globalThis, "reportError");
      } else {
        Object.defineProperty(globalThis, "reportError", {
          configurable: true,
          value: reportError,
          writable: true,
        });
      }
      await client.close();
    }
  });

  test("delivers terminal settlements only from the durable settlement vector", async () => {
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      invalidate: () => undefined,
      rerunResults: () => undefined,
      subscribeEvents: () => () => undefined,
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, runner });
    const settlements: unknown[] = [];
    const late: unknown[] = [];
    const diagnostics: EmbeddedEvent[] = [];
    const stop = client.subscribeToMutationSettlements((settlement) =>
      settlements.push(settlement),
    );
    const stopDiagnostics = readDevtoolsBridge(client).subscribe((event) =>
      diagnostics.push(event),
    );
    try {
      await Promise.resolve();
      const process = (
        client as unknown as {
          processRemoteTick(tick: RemoteTick, runner: Runner): void;
        }
      ).processRemoteTick.bind(client);

      // Aggregate remote counters and rebases never manufacture a terminal settlement.
      process({ ...emptyRemoteTick(), pushAccepted: 1, pushFailed: 1, pushRebases: 3 }, runner);
      expect(settlements).toEqual([]);

      process(
        {
          ...emptyRemoteTick(),
          settlements: [
            {
              functionName: "todos:create",
              mutationId: "m1",
              outcome: "applied",
              retainedRevisions: [],
            },
            {
              code: "EMBEDDED_CONFLICT",
              functionName: "todos:edit",
              mutationId: "m2",
              outcome: "conflict",
              retainedRevisions: [{ id: "doc", revId: "r1", table: "todos" }],
            },
            {
              code: "EMBEDDED_REJECTED",
              functionName: "todos:remove",
              mutationId: "m3",
              outcome: "rejected",
              retainedRevisions: [{ id: "doc", revId: "r2", table: "todos" }],
            },
          ] satisfies RemoteMutationSettlement[],
        },
        runner,
      );
      expect(settlements).toEqual([
        { functionName: "todos:create", mutationId: "m1", outcome: "applied" },
        {
          code: "EMBEDDED_CONFLICT",
          functionName: "todos:edit",
          mutationId: "m2",
          outcome: "conflict",
          retainedRevisions: [{ id: "doc", revId: "r1", table: "todos" }],
        },
        {
          code: "EMBEDDED_REJECTED",
          functionName: "todos:remove",
          mutationId: "m3",
          outcome: "rejected",
          retainedRevisions: [{ id: "doc", revId: "r2", table: "todos" }],
        },
      ]);
      expect("retainedRevisions" in (settlements[0] as object)).toBe(false);
      expect((settlements[1] as { code?: string }).code).toBe("EMBEDDED_CONFLICT");
      expect("reason" in (settlements[2] as object)).toBe(false);
      for (const event of diagnostics.filter(
        (event): event is Extract<EmbeddedEvent, { type: "remote" }> => event.type === "remote",
      )) {
        expect("settlements" in event).toBe(false);
        expect(event.tick === undefined || !("settlements" in event.tick)).toBe(true);
      }

      // Subscriptions are live-only and unsubscribe idempotently.
      const stopLate = client.subscribeToMutationSettlements((settlement) => late.push(settlement));
      expect(late).toEqual([]);
      stop();
      stop();
      process(
        {
          ...emptyRemoteTick(),
          settlements: [
            {
              functionName: "todos:next",
              mutationId: "m4",
              outcome: "applied",
              retainedRevisions: [],
            },
          ],
        },
        runner,
      );
      expect(settlements).toHaveLength(3);
      expect(late).toEqual([{ functionName: "todos:next", mutationId: "m4", outcome: "applied" }]);
      stopLate();
    } finally {
      stopDiagnostics();
      await client.close();
    }
  });

  test("forwards a browser settlement vector only after its accepted remote event", async () => {
    let emitEvent: ((event: EmbeddedEvent) => void) | undefined;
    let emitSettlements:
      | ((
          event: Extract<EmbeddedEvent, { type: "remote" }>,
          settlements: readonly RemoteMutationSettlement[],
        ) => void)
      | undefined;
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emitEvent = listener;
        return () => {
          emitEvent = undefined;
        };
      },
      subscribeRemoteSettlements: (
        listener: (
          event: Extract<EmbeddedEvent, { type: "remote" }>,
          settlements: readonly RemoteMutationSettlement[],
        ) => void,
      ) => {
        emitSettlements = listener;
        return () => {
          emitSettlements = undefined;
        };
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, remoteConfigured: true, runner });
    const settlements: unknown[] = [];
    const statesAtSettlement: unknown[] = [];
    const diagnostics: EmbeddedEvent[] = [];
    const stop = client.subscribeToMutationSettlements((settlement) =>
      settlements.push(settlement),
    );
    const stopState = client.subscribeToMutationSettlements(() => {
      statesAtSettlement.push(client.connectionState());
    });
    const stopDiagnostics = readDevtoolsBridge(client).subscribe((event) =>
      diagnostics.push(event),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const accepted = {
        at: 1,
        attempt: 1,
        generation: 2,
        sequence: 2,
        status: "idle",
        tick: remoteTickEventTick({
          pending: {
            checkpoints: 0,
            inflight: 0,
            mutations: 0,
            scope: 0,
            settlements: 0,
            uploads: 0,
          },
        }),
        type: "remote",
      } satisfies Extract<EmbeddedEvent, { type: "remote" }>;
      const vector = [
        {
          functionName: "todos:worker",
          mutationId: "browser-m1",
          outcome: "applied",
          retainedRevisions: [],
        },
      ] satisfies RemoteMutationSettlement[];

      // The proxy first passes the normal diagnostic event; the paired vector follows only after
      // that event crossed the generation/sequence fence.
      emitEvent?.(accepted);
      emitSettlements?.(accepted, vector);
      expect(settlements).toEqual([
        { functionName: "todos:worker", mutationId: "browser-m1", outcome: "applied" },
      ]);
      expect(statesAtSettlement).toEqual([
        {
          local: { persistence: "durable", status: "ready" },
          replication: { status: "online", sync: "idle" },
        },
      ]);
      expect(diagnostics.filter((event) => event.type === "remote")).toEqual([accepted]);

      // A duplicate and an older generation may carry a vector on the wire, but neither can
      // replay a previously delivered terminal settlement.
      emitEvent?.(accepted);
      emitSettlements?.(accepted, vector);
      const stale = { ...accepted, generation: 1, sequence: 99 };
      emitEvent?.(stale);
      emitSettlements?.(stale, vector);
      expect(settlements).toHaveLength(1);
      expect(diagnostics.filter((event) => event.type === "remote")).toEqual([accepted]);
    } finally {
      stop();
      stopState();
      stopDiagnostics();
      await client.close();
    }
  });

  test("durable leader terms reject late remote diagnostics, settlements, and devtools events", async () => {
    let emitEvent: ((event: EmbeddedEvent) => void) | undefined;
    let emitSettlements:
      | ((
          event: Extract<EmbeddedEvent, { type: "remote" }>,
          settlements: readonly RemoteMutationSettlement[],
        ) => void)
      | undefined;
    const runner = {
      identity: { read: async () => undefined, write: async () => undefined },
      subscribeEvents: (listener: (event: EmbeddedEvent) => void) => {
        emitEvent = listener;
        return () => undefined;
      },
      subscribeRemoteSettlements: (
        listener: (
          event: Extract<EmbeddedEvent, { type: "remote" }>,
          settlements: readonly RemoteMutationSettlement[],
        ) => void,
      ) => {
        emitSettlements = listener;
        return () => undefined;
      },
    } as unknown as Runner;
    const client = new EmbeddedClient({ eagerRunner: runner, remoteConfigured: true, runner });
    const settlements: unknown[] = [];
    const diagnostics: EmbeddedEvent[] = [];
    const stopSettlements = client.subscribeToMutationSettlements((settlement) =>
      settlements.push(settlement),
    );
    const stopDiagnostics = readDevtoolsBridge(client).subscribe((event) =>
      diagnostics.push(event),
    );
    try {
      await Promise.resolve();
      const term9 = {
        at: 1,
        attempt: 1,
        generation: 1,
        incarnation: "session-9",
        leaderFence: "9",
        sequence: 1,
        status: "connected",
        type: "remote",
      } satisfies Extract<EmbeddedEvent, { type: "remote" }>;
      const term10 = {
        ...term9,
        at: 2,
        incarnation: "session-10",
        leaderFence: "10",
        sequence: 1,
        status: "idle",
      } satisfies Extract<EmbeddedEvent, { type: "remote" }>;
      const missingSession = {
        ...term10,
        at: 3,
        incarnation: undefined,
        sequence: 2,
        status: "offline",
      } satisfies Extract<EmbeddedEvent, { type: "remote" }>;
      const late9 = { ...term9, at: 3, sequence: 99, status: "offline" } as const;
      const settlement = (mutationId: string) => [
        {
          functionName: "todos:write",
          mutationId,
          outcome: "applied" as const,
          retainedRevisions: [],
        },
      ];

      emitEvent?.(term9);
      emitSettlements?.(term9, settlement("term-9"));
      emitEvent?.(term10);
      emitSettlements?.(term10, settlement("term-10"));
      emitEvent?.(missingSession);
      emitSettlements?.(missingSession, settlement("missing-session"));
      emitEvent?.(late9);
      emitSettlements?.(late9, settlement("late-9"));

      expect(client.connectionState().replication).toEqual({ status: "online", sync: "pending" });
      expect(settlements).toEqual([
        { functionName: "todos:write", mutationId: "term-9", outcome: "applied" },
        { functionName: "todos:write", mutationId: "term-10", outcome: "applied" },
      ]);
      expect(diagnostics.filter((event) => event.type === "remote")).toEqual([term9, term10]);
    } finally {
      stopSettlements();
      stopDiagnostics();
      await client.close();
    }
  });
});

function emptyRemoteTick(): RemoteTick {
  return {
    changedResults: [],
    changedTables: [],
    pullAttempted: 0,
    pullChangesApplied: 0,
    pullDiagnostics: 0,
    pullSnapshots: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushFailed: 0,
    pushRebases: 0,
    pushed: 0,
    receiptsPushed: 0,
    received: 0,
    reconnected: false,
    retainedRevisions: [],
    rowsApplied: 0,
    sent: 0,
    settlements: [],
    storeJobs: 0,
  };
}

function remoteTickEventTick(
  overrides: Partial<NonNullable<Extract<EmbeddedEvent, { type: "remote" }>["tick"]>>,
): NonNullable<Extract<EmbeddedEvent, { type: "remote" }>["tick"]> {
  return {
    changedTables: [],
    pullAttempted: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushFailed: 0,
    pushRebases: 0,
    received: 0,
    reconnected: false,
    retainedRevisions: 0,
    rowsApplied: 0,
    sent: 0,
    receiptsPushed: 0,
    storeJobs: 0,
    ...overrides,
  } as NonNullable<Extract<EmbeddedEvent, { type: "remote" }>["tick"]>;
}
