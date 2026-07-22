/**
 * Browser implementation of the embedded Convex client.
 *
 * @remarks
 * This module is re-exported by `@convex-dev/embedded/browser`. Prefer that
 * package entrypoint in application code so the generated virtual modules are
 * initialized before the client starts.
 *
 * @packageDocumentation
 */
import {
  createEmbeddedAuthState,
  EmbeddedClient,
  type ConvexModules,
  type EmbeddedAuthState,
} from "../client";
import type { ConvexEmbeddedSchema } from "../schema";
import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { loadWasmModule, type WasmModule, type WasmSource } from "./artifact";
import { createRuntimeIdentity, embeddedCompatiblePriorRuntimes } from "./identity";
import { storageOwnerLockName } from "./coordinator/protocol";
import { requestStoragePersistence } from "./opfs";
import {
  BrowserLifecycleRunner,
  type BrowserRunnerHandle,
  installPageLifecycle,
} from "./lifecycle";
import { WorkerRunner } from "./proxy";
import type { EmbeddedWorkerSource, RuntimeIdentity } from "./protocol";
import { browserStorageId, browserStoragePath } from "./storage";
import { WasmStore } from "./store";

declare const Worker:
  | undefined
  | (new (url: URL, options: { name?: string; type: "module" }) => EmbeddedWorkerSource);

export type {
  ConvexEmbeddedMutationOptions,
  AuthTokenFetcher,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
  EmbeddedConnectionState,
  EmbeddedEvent,
  EmbeddedEventListener,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedOperationPhase,
  EmbeddedRuntimeDegradation,
  EmbeddedRuntimeEvent,
  EmbeddedRuntimePhase,
  EmbeddedRemoteEvent,
  EmbeddedRemoteStatus,
  EmbeddedSchedulerEvent,
  EmbeddedSpanEvent,
  EmbeddedSpanPhase,
  EmbeddedStorageEvent,
  Watch,
} from "../client";
export type { ConvexEmbeddedSchema } from "../schema";

/**
 * Configuration for {@link ConvexEmbeddedClient}.
 *
 * @remarks
 * Browser configuration is currently supplied by the Vite/unplugin adapter and
 * the packaged worker runtime. This options object is intentionally reserved
 * so future browser options can be added without changing the constructor
 * shape.
 *
 * @public
 */
export interface ConvexEmbeddedClientOptions {
  /** Convex deployment URL. Omit it for a local-only runtime. */
  url?: string;

  /**
   * Reserved for future browser configuration.
   *
   * @internal
   */
  readonly __convexEmbeddedClientOptionsBrand?: never;
}

interface InternalConvexEmbeddedClientOptions {
  modules?: ConvexModules;
  schema: ConvexEmbeddedSchema;
  wasm?: WasmSource;
  worker?: EmbeddedWorkerSource;
}

interface CachedBrowserRuntime {
  closeTimer?: ReturnType<typeof setTimeout>;
  refs: number;
  ready: Promise<WorkerRunner>;
  runner: WorkerRunner;
  ownership: BrowserStorageOwnership;
}

const wasmOverrides = new WeakMap<InternalConvexEmbeddedClientOptions, WasmModule>();
const localRuntimeCache = new Map<string, CachedBrowserRuntime>();
const LOCAL_RUNTIME_IDLE_CLOSE_MS = 1_000;
/** OPFS reclaim uses a shared 5s sub-budget, leaving the rest for WASM and store setup. */
const BROWSER_WORKER_INIT_TIMEOUT_MS = 15_000;

/**
 * Embedded Convex client for browsers.
 *
 * @remarks
 * Convex functions execute in JavaScript inside a module worker; storage is
 * provided by the Rust/WASM backend using OPFS. The browser build requires
 * Dedicated Worker support, cross-origin isolation for WASM shared memory, and
 * the embedded Vite/unplugin adapter so the worker can import the generated
 * Convex schema and modules.
 *
 * @example
 * ```ts
 * import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";
 * import { api } from "../convex/_generated/api";
 *
 * const client = new ConvexEmbeddedClient();
 * const todos = await client.query(api.todos.list, {});
 * ```
 *
 * @public
 */
export class ConvexEmbeddedClient extends EmbeddedClient {
  /**
   * Creates a browser embedded client backed by the package-owned worker.
   *
   * @param _options - Reserved browser client options.
   * @throws If Dedicated Worker support is unavailable. Worker initialization
   * may also fail asynchronously if the Vite/unplugin adapter, cross-origin
   * isolation, WASM artifact, schema, or module graph cannot be loaded.
   */
  constructor(options: ConvexEmbeddedClientOptions = {}) {
    const authState = createEmbeddedAuthState();
    assertDedicatedWorkerSupport();
    requestStoragePersistence();
    const identity = createRuntimeIdentity();
    const storagePath = browserStoragePath();
    const runtime = new BrowserLifecycleRunner(() =>
      defaultBrowserRuntime(options, authState, identity, storagePath),
    );
    const cleanupLifecycle = installPageLifecycle(
      () => runtime.suspend(),
      () => void runtime.resume(),
    );
    let cleanupNetwork: () => void = () => undefined;
    super({
      close: async () => {
        cleanupLifecycle();
        cleanupNetwork();
        await runtime.close();
      },
      eagerRunner: runtime,
      runner: runtime,
      authState,
      hosted: options.url === undefined ? undefined : { url: options.url },
      remoteConfigured: options.url !== undefined,
    });
    if (options.url !== undefined) {
      cleanupNetwork = installBrowserNetworkLifecycle(options.url, (online) => {
        void runtime.remote.network.write(online).catch(() => undefined);
      });
    }
  }
}

function defaultBrowserRuntime(
  options: ConvexEmbeddedClientOptions,
  authState: EmbeddedAuthState,
  identity: RuntimeIdentity,
  storagePath: string,
): BrowserRunnerHandle {
  const remote = options.url === undefined ? undefined : { url: options.url };
  if (remote === undefined) {
    return cachedLocalBrowserRuntime(identity, storagePath);
  }
  const ownership = createBrowserStorageOwnership(identity);
  const runner = new WorkerRunner(defaultRuntimeWorker(), {
    compatiblePriorRuntimes: embeddedCompatiblePriorRuntimes(),
    identity,
    initTimeoutMs: BROWSER_WORKER_INIT_TIMEOUT_MS,
    onDispose: () => ownership.close(),
    remote,
    remoteAuth: async (args) => (await authState.fetchToken?.(args)) ?? null,
    storagePath,
    storageOwner: ownership.initial,
  });
  let stopTemporaryStorage: (() => void) | undefined;
  stopTemporaryStorage = runner.subscribeEvents((event) => {
    if (event.type !== "runtime" || event.degradation !== "temporary-storage") return;
    ownership.close();
    stopTemporaryStorage?.();
    stopTemporaryStorage = undefined;
  });
  ownership.bind(
    () => {
      void runner.storage.owner.write().catch(() => runner.terminate());
    },
    () => runner.terminate(),
  );
  void runner.initialized().catch(() => runner.terminate());
  return {
    close: async () => {
      stopTemporaryStorage?.();
      await runner.close();
      ownership.close();
    },
    closeNow: () => {
      stopTemporaryStorage?.();
      runner.terminate();
      ownership.close();
    },
    eagerRunner: runner,
    runner,
  };
}

interface PageLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T>;
  request<T>(
    name: string,
    options: { signal: AbortSignal },
    callback: (lock: object) => T | Promise<T>,
  ): Promise<T>;
}

interface BrowserStorageOwnership {
  initial: Promise<boolean>;
  bind(acquired: () => void, lost: (error: unknown) => void): void;
  close(): void;
}

/** Keeps the origin-wide storage lease in the page lifecycle, never in a worker lifecycle. */
export function createBrowserStorageOwnership(
  identity: RuntimeIdentity,
  locks: PageLockManager | undefined = (globalThis as { navigator?: { locks?: PageLockManager } })
    .navigator?.locks,
): BrowserStorageOwnership {
  let resolveInitial!: (owner: boolean) => void;
  let rejectInitial!: (error: unknown) => void;
  const initial = new Promise<boolean>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  if (!locks) {
    rejectInitial(new Error("ConvexEmbeddedClient browser runtime requires Web Locks support."));
    return { bind: () => undefined, close: () => undefined, initial };
  }

  const name = storageOwnerLockName(identity);
  const queued = new AbortController();
  let acquiredListener: (() => void) | undefined;
  let lostListener: ((error: unknown) => void) | undefined;
  let pendingAcquire = false;
  let initialSettled = false;
  let closed = false;
  let release: (() => void) | undefined;

  const settleInitial = (owner: boolean) => {
    if (initialSettled) return;
    initialSettled = true;
    resolveInitial(owner);
  };
  const hold = async () => {
    if (closed) return;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (!initialSettled) settleInitial(true);
    else if (acquiredListener) acquiredListener();
    else pendingAcquire = true;
    await held;
    release = undefined;
  };
  const fail = (error: unknown) => {
    if (closed) return;
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(error);
    } else {
      lostListener?.(error);
    }
  };
  const wait = () => {
    if (closed) return;
    void locks.request(name, { signal: queued.signal }, hold).catch(fail);
  };
  void locks
    .request(name, { ifAvailable: true }, async (lock) => {
      if (lock === null) {
        settleInitial(false);
        return;
      }
      await hold();
    })
    .then(() => {
      if (!closed && release === undefined) wait();
    })
    .catch(fail);

  return {
    bind: (acquired, lost) => {
      acquiredListener = acquired;
      lostListener = lost;
      if (pendingAcquire) {
        pendingAcquire = false;
        acquired();
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (!initialSettled) {
        initialSettled = true;
        rejectInitial(new Error("ConvexEmbeddedClient browser storage ownership closed."));
      }
      queued.abort();
      release?.();
    },
    initial,
  };
}

function cachedLocalBrowserRuntime(
  identity: RuntimeIdentity,
  storagePath: string,
): BrowserRunnerHandle {
  const key = localRuntimeCacheKey(identity, storagePath);
  let cached = localRuntimeCache.get(key);
  if (!cached) {
    const ownership = createBrowserStorageOwnership(identity);
    const runner = new WorkerRunner(defaultRuntimeWorker(), {
      identity,
      initTimeoutMs: BROWSER_WORKER_INIT_TIMEOUT_MS,
      onDispose: () => ownership.close(),
      storagePath,
      storageOwner: ownership.initial,
    });
    let stopTemporaryStorage: (() => void) | undefined;
    stopTemporaryStorage = runner.subscribeEvents((event) => {
      if (event.type !== "runtime" || event.degradation !== "temporary-storage") return;
      ownership.close();
      stopTemporaryStorage?.();
      stopTemporaryStorage = undefined;
    });
    ownership.bind(
      () => {
        void runner.storage.owner.write().catch(() => runner.terminate());
      },
      () => runner.terminate(),
    );
    const created: CachedBrowserRuntime = {
      ownership,
      ready: Promise.resolve(runner),
      refs: 0,
      runner,
    };
    created.ready = runner.initialized().then(
      () => runner,
      (error) => {
        if (localRuntimeCache.get(key) === created) localRuntimeCache.delete(key);
        if (created.closeTimer !== undefined) clearTimeout(created.closeTimer);
        created.closeTimer = undefined;
        runner.terminate();
        ownership.close();
        throw error;
      },
    );
    // A client can close before EmbeddedClient.init reaches its first runner read. The cache still
    // owns this derived readiness promise and must observe its rejection while preserving it for a
    // later query or initialization waiter.
    void created.ready.catch(() => undefined);
    cached = created;
    localRuntimeCache.set(key, created);
  }
  if (cached.closeTimer !== undefined) {
    clearTimeout(cached.closeTimer);
    cached.closeTimer = undefined;
  }
  cached.refs += 1;
  let released = false;
  const release = (immediate: boolean) => {
    if (released) return;
    released = true;
    cached.refs = Math.max(0, cached.refs - 1);
    if (cached.refs > 0) return;
    const close = (immediate = false) => {
      if (cached.refs > 0) return;
      localRuntimeCache.delete(key);
      if (immediate) cached.runner.terminate();
      else void cached.runner.close();
      cached.ownership.close();
    };
    if (immediate) {
      if (cached.closeTimer !== undefined) clearTimeout(cached.closeTimer);
      cached.closeTimer = undefined;
      close(true);
      return;
    }
    cached.closeTimer = setTimeout(close, LOCAL_RUNTIME_IDLE_CLOSE_MS);
  };
  return {
    close: () => release(false),
    closeNow: () => release(true),
    eagerRunner: cached.runner,
    runner: cached.ready,
  };
}

function localRuntimeCacheKey(identity: RuntimeIdentity, storagePath: string): string {
  return [
    identity.schemaHash,
    identity.moduleGraphHash,
    identity.protocolVersion,
    identity.packageVersion,
    identity.storageId,
    identity.wasmAbiVersion,
    storagePath,
  ].join("|");
}

class InternalConvexEmbeddedClient extends EmbeddedClient {
  constructor(options: InternalConvexEmbeddedClientOptions) {
    if (options.worker) {
      const runner = new WorkerRunner(options.worker);
      super({
        close: () => runner.close(),
        runner,
      });
      return;
    }
    super({
      schema: options.schema,
      modules: options.modules ?? {},
      store: openStore(options),
    });
  }
}

/**
 * Creates a browser client with an injected WASM module.
 *
 * @internal
 */
export function createConvexEmbeddedClientForTest(
  options: InternalConvexEmbeddedClientOptions,
  wasm: WasmModule,
): EmbeddedClient {
  wasmOverrides.set(options, wasm);
  return new InternalConvexEmbeddedClient(options);
}

function defaultRuntimeWorker(): EmbeddedWorkerSource {
  assertDedicatedWorkerSupport();
  const WorkerConstructor = Worker as Exclude<typeof Worker, undefined>;
  return new WorkerConstructor(new URL("./browser-embedded.mjs", import.meta.url), {
    name: "convex-embedded",
    type: "module",
  });
}

function assertDedicatedWorkerSupport(): void {
  if (typeof Worker === "undefined") {
    throw new Error(
      "ConvexEmbeddedClient browser runtime requires Dedicated Worker support. This browser cannot run @convex-dev/embedded/browser.",
    );
  }
}

interface BrowserNetworkGlobal {
  addEventListener?: (type: "online" | "offline", callback: () => void) => void;
  /** Test seam only; reachability is deliberately never inferred with HTTP. */
  fetch?: typeof fetch;
  navigator?: { onLine?: boolean };
  removeEventListener?: (type: "online" | "offline", callback: () => void) => void;
}

/** Forwards browser hints as retry nudges; the worker-owned socket remains authoritative. @internal */
export function installBrowserNetworkLifecycle(
  _remoteUrl: string,
  write: (online: boolean) => void,
  global: BrowserNetworkGlobal = globalThis as typeof globalThis & BrowserNetworkGlobal,
): () => void {
  if (
    typeof global.addEventListener !== "function" ||
    typeof global.removeEventListener !== "function"
  ) {
    return () => undefined;
  }
  const onOnline = () => {
    write(true);
  };
  const onOffline = () => {
    write(false);
  };
  global.addEventListener("online", onOnline);
  global.addEventListener("offline", onOffline);
  if (global.navigator?.onLine === false) queueMicrotask(onOffline);
  return () => {
    global.removeEventListener?.("online", onOnline);
    global.removeEventListener?.("offline", onOffline);
  };
}

async function openStore(options: InternalConvexEmbeddedClientOptions): Promise<WasmStore> {
  const override = wasmOverrides.get(options);
  wasmOverrides.delete(options);
  const wasm = await loadWasmModule(override ?? options.wasm);
  return WasmStore.openWith(wasm.Store, browserStoragePath(), {
    defaultIdentityKey: EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
    selectorKey: browserStorageId(),
  });
}
