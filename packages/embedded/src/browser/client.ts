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
import { EmbeddedClient, type ConvexModules } from "../client";
import type { ConvexEmbeddedSchema } from "../schema";
import { loadWasmModule, type WasmModule, type WasmSource } from "./artifact";
import { createRuntimeIdentity } from "./identity";
import { WorkerRunner } from "./proxy";
import type { EmbeddedWorkerSource } from "./protocol";
import { browserStoragePath } from "./storage";
import { WasmStore } from "./store";

declare const Worker:
  | undefined
  | (new (url: URL, options: { name?: string; type: "module" }) => EmbeddedWorkerSource);

export type {
  ConvexEmbeddedMutationOptions,
  MutationOptions,
  OptimisticLocalStore,
  OptimisticUpdate,
  Watch,
  WatchQueryOptions,
} from "../client";
export type { ConvexEmbeddedSchema } from "../schema";

/**
 * Configuration for {@link ConvexEmbeddedClient}.
 *
 * @remarks
 * Browser configuration is currently supplied by the bundler plugin and the
 * packaged worker runtime. This options object is intentionally reserved so
 * future browser options can be added without changing the constructor shape.
 *
 * @public
 */
export interface ConvexEmbeddedClientOptions {
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

const wasmOverrides = new WeakMap<InternalConvexEmbeddedClientOptions, WasmModule>();

/**
 * Embedded Convex client for browsers.
 *
 * @remarks
 * Convex functions execute in JavaScript inside a module worker; storage is
 * provided by the Rust/WASM backend using OPFS. The browser build requires
 * Dedicated Worker support, cross-origin isolation for WASM shared memory, and
 * the embedded bundler plugin so the worker can import the generated Convex
 * schema and modules.
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
   * may also fail asynchronously if the bundler plugin, cross-origin isolation,
   * WASM artifact, schema, or module graph cannot be loaded.
   */
  constructor(_options?: ConvexEmbeddedClientOptions) {
    const runner = defaultBrowserRunner();
    const cleanupLifecycle = installPageLifecycleClose(() => {
      void runner.close();
    });
    super({
      close: async () => {
        cleanupLifecycle();
        await runner.close();
      },
      runner,
    });
  }
}

function defaultBrowserRunner(): WorkerRunner {
  assertDedicatedWorkerSupport();
  const identity = createRuntimeIdentity();
  return new WorkerRunner(defaultRuntimeWorker(), {
    identity,
    storagePath: browserStoragePath(),
  });
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
  const onPageHide = () => {
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
  return WasmStore.openWith(wasm.Store, browserStoragePath());
}
