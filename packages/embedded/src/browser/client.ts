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
import { createRuntimeIdentity } from "./identity";
import { requestStoragePersistence } from "./opfs";
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
  EmbeddedDataUpsert,
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

interface BrowserRunnerHandle {
  close(): Promise<void> | void;
  closeNow(): Promise<void> | void;
  eagerRunner: WorkerRunner;
  runner: WorkerRunner | Promise<WorkerRunner>;
}

interface CachedBrowserRuntime {
  closeTimer?: ReturnType<typeof setTimeout>;
  refs: number;
  ready: Promise<WorkerRunner>;
  runner: WorkerRunner;
}

const wasmOverrides = new WeakMap<InternalConvexEmbeddedClientOptions, WasmModule>();
const localRuntimeCache = new Map<string, CachedBrowserRuntime>();
const LOCAL_RUNTIME_IDLE_CLOSE_MS = 1_000;

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
    const runtime = defaultBrowserRuntime(options, authState);
    const cleanupLifecycle = installPageLifecycleClose(() => {
      void runtime.closeNow();
    });
    super({
      close: async () => {
        cleanupLifecycle();
        await runtime.close();
      },
      eagerRunner: runtime.eagerRunner,
      runner: runtime.runner,
      authState,
      hosted: options.url === undefined ? undefined : { url: options.url },
      remoteConfigured: options.url !== undefined,
    });
  }
}

function defaultBrowserRuntime(
  options: ConvexEmbeddedClientOptions,
  authState: EmbeddedAuthState,
): BrowserRunnerHandle {
  assertDedicatedWorkerSupport();
  requestStoragePersistence();
  const identity = createRuntimeIdentity();
  const storagePath = browserStoragePath();
  const remote = options.url === undefined ? undefined : { url: options.url };
  if (remote === undefined) {
    return cachedLocalBrowserRuntime(identity, storagePath);
  }
  const runner = new WorkerRunner(defaultRuntimeWorker(), {
    identity,
    remote,
    remoteAuth: async (args) => (await authState.fetchToken?.(args)) ?? null,
    storagePath,
  });
  return {
    close: () => runner.close(),
    closeNow: () => runner.close(),
    eagerRunner: runner,
    runner,
  };
}

function cachedLocalBrowserRuntime(
  identity: RuntimeIdentity,
  storagePath: string,
): BrowserRunnerHandle {
  const key = localRuntimeCacheKey(identity, storagePath);
  let cached = localRuntimeCache.get(key);
  if (!cached) {
    const runner = new WorkerRunner(defaultRuntimeWorker(), {
      identity,
      storagePath,
    });
    cached = {
      ready: runner.initialized().then(() => runner),
      refs: 0,
      runner,
    };
    localRuntimeCache.set(key, cached);
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
    const close = () => {
      if (cached.refs > 0) return;
      localRuntimeCache.delete(key);
      void cached.runner.close();
    };
    if (immediate) {
      if (cached.closeTimer !== undefined) clearTimeout(cached.closeTimer);
      cached.closeTimer = undefined;
      close();
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

function installPageLifecycleClose(close: () => void): () => void {
  const global = globalThis as typeof globalThis & {
    addEventListener?: (
      type: "pagehide" | "pageshow",
      callback: (event: { persisted?: boolean }) => void,
    ) => void;
    location?: { reload(): void };
    removeEventListener?: (
      type: "pagehide" | "pageshow",
      callback: (event: { persisted?: boolean }) => void,
    ) => void;
  };
  if (
    typeof global.addEventListener !== "function" ||
    typeof global.removeEventListener !== "function"
  ) {
    return () => undefined;
  }
  let closedForPageHide = false;
  const onPageHide = (event: { persisted?: boolean }) => {
    if (!event.persisted) return;
    closedForPageHide = true;
    close();
  };
  const onPageShow = (event: { persisted?: boolean }) => {
    if (closedForPageHide && event.persisted) {
      global.location?.reload();
    }
  };
  global.addEventListener("pagehide", onPageHide);
  global.addEventListener("pageshow", onPageShow);
  return () => {
    global.removeEventListener?.("pagehide", onPageHide);
    global.removeEventListener?.("pageshow", onPageShow);
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
