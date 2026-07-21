import { describe, expect, test } from "vite-plus/test";
import { makeFunctionReference } from "convex/server";

import { EMBEDDED_STORE_FORMAT_VERSION } from "../../src/abi";
import { EmbeddedClient } from "../../src/client";
import { WASM_API_VERSION } from "../../src/browser/artifact";
import {
  ConvexEmbeddedClient,
  createBrowserStorageOwnership,
  installBrowserNetworkLifecycle,
} from "../../src/browser/client";
import { BrowserLifecycleRunner, installPageLifecycle } from "../../src/browser/lifecycle";
import type { WorkerRunner } from "../../src/browser/proxy";
import { WorkerEvent, type EmbeddedWorker, type RuntimeIdentity } from "../../src/browser/protocol";
import type { EmbeddedEvent } from "../../src/events";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import type { Runner } from "../../src/runtime/runner";
import { setEmbeddedIdentity } from "../../src/browser/identity";

type PageLocks = NonNullable<Parameters<typeof createBrowserStorageOwnership>[1]>;

function identity(storageId: string): RuntimeIdentity {
  return {
    moduleGraphHash: "modules",
    packageVersion: "0.0.0",
    protocolVersion: EMBEDDED_PROTOCOL_VERSION,
    schemaHash: "schema",
    storageId,
    storeFormatVersion: EMBEDDED_STORE_FORMAT_VERSION,
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
      "documents:list" as never,
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
    await expect(runtime.runQuery("documents:list" as never)).rejects.toThrow(
      "browser runtime is suspended",
    );
    await runtime.resume();
    await expect(runtime.runQuery("documents:list" as never)).resolves.toBeUndefined();
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
      await Promise.resolve();
      await Promise.resolve();
      workers[0]?.emit({
        error: { message: "init failed", name: "Error" },
        op: WorkerEvent.Terminal,
      });
      await expect(first.query("missing" as never)).rejects.toThrow("init failed");

      const second = new ConvexEmbeddedClient();
      expect(workers).toHaveLength(2);
      workers[1]?.emit({
        error: { message: "done", name: "Error" },
        op: WorkerEvent.Terminal,
      });
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
      expect(client.connectionState()).toMatchObject({ local: "ready", remote: "starting" });

      emit?.({ at: 1, attempt: 0, status: "started", type: "remote" });
      expect(client.connectionState().remote).toBe("starting");

      emit?.({ at: 2, attempt: 1, status: "connected", type: "remote" });
      expect(client.connectionState().remote).toBe("connected");

      emit?.({ at: 3, attempt: 2, status: "tick", type: "remote" });
      expect(client.connectionState().remote).toBe("connected");

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
      expect(client.connectionState().remote).toBe("ready");
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
      expect(client.connectionState().remote).toBe("offline");
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

      expect(client.connectionState()).toEqual({ local: "ready", remote: "starting" });
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
        sequence: 1,
        status: "connected",
        type: "remote",
      });
      emit?.({ at: 2, attempt: 1, generation: 1, sequence: 99, status: "offline", type: "remote" });
      emit?.({ at: 3, attempt: 1, generation: 2, sequence: 1, status: "offline", type: "remote" });
      expect(client.connectionState().remote).toBe("connected");

      emit?.({ at: 4, attempt: 1, generation: 2, sequence: 2, status: "started", type: "remote" });
      expect(client.connectionState().remote).toBe("connected");
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
      expect(client.connectionState().remote).toBe("connected");
    } finally {
      await client.close();
    }
  });
});
