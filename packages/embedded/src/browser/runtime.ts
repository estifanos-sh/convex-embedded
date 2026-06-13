/**
 * Browser worker runtime entrypoint for embedded Convex.
 *
 * @remarks
 * This module is used by the package-owned worker runtime. Applications should
 * construct `ConvexEmbeddedClient` from
 * `@convex-dev/embedded/browser` instead.
 *
 * @packageDocumentation
 */
import type { ConvexModules } from "../client";
import { createRunner, type Runner } from "../runtime/runner";
import type { ConvexEmbeddedSchema } from "../schema";
import { toStoreSchema } from "../schema";
import type { StoreSchema } from "../storage/types";
import { loadWasmModule, type WasmSource } from "./artifact";
import { OpfsDirectory, registerTursoFiles } from "./opfs";
import {
  PortCommand,
  serializeError,
  type EmbeddedWorker,
  WorkerCommand,
  WorkerEvent,
  type WorkerPortRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { browserStoragePath } from "./storage";
import { WasmStore } from "./store";

declare const self: {
  close?: () => void;
  onmessage: ((event: { data: unknown; ports?: EmbeddedWorker[] }) => void) | null;
  postMessage?(message: unknown): void;
};

/**
 * Configuration for the worker-owned embedded runtime.
 *
 * @internal
 */
export interface ConvexEmbeddedWorkerOptions {
  /**
   * Convex schema definition used to configure embedded storage indexes.
   *
   * @remarks
   * Pass the default export from the app's `convex/schema` module.
   */
  schema: ConvexEmbeddedSchema;

  /**
   * Convex function modules executed by this worker.
   *
   * @remarks
   * Keys are Convex module paths and values are module exports or lazy module
   * loaders.
   */
  modules: ConvexModules;

  /**
   * Generated Rust/WASM storage module.
   *
   * By default the packaged artifact is loaded from this package. This option is for tests or
   * custom bundler artifact loading.
   */
  wasm?: WasmSource;
}

/**
 * Runtime state owned by an embedded browser worker.
 *
 * @internal
 */
export interface WorkerState {
  /** OPFS bridge used by the Rust/WASM storage imports. */
  opfs: OpfsDirectory;
  /** Local Convex function runner. */
  runner: Runner;
  /** WASM-backed embedded store. */
  store: WasmStore;
  /** Active watch cleanup callbacks keyed by watch ID. */
  stops: Map<number, () => void>;
}

type WorkerCommandHandler<T extends WorkerRequest = WorkerRequest> = (
  state: WorkerState,
  request: T,
  postResponse: (message: WorkerResponse) => void,
) => Promise<void> | void;

const workerCommandHandlers = new Map<number, WorkerCommandHandler>([
  [WorkerCommand.Query, (state, request, post) => handleQuery(state, request as never, post)],
  [WorkerCommand.Mutation, (state, request, post) => handleMutation(state, request as never, post)],
  [
    WorkerCommand.WatchStart,
    (state, request, post) => handleWatchStart(state, request as never, post),
  ],
  [
    WorkerCommand.WatchStop,
    (state, request, post) => handleWatchStop(state, request as never, post),
  ],
]);

/**
 * Starts a worker-owned embedded Convex runtime.
 *
 * @remarks
 * Import this from a module worker and pass the same schema/modules you would
 * pass to the Node client. The main-thread {@link ConvexEmbeddedClient} talks
 * to this worker over `postMessage`.
 *
 * @param options - Schema, modules, and optional WASM artifact source.
 * @returns Nothing. The function installs a worker `onmessage` handler.
 * @internal
 */
export function createConvexEmbeddedWorker(options: ConvexEmbeddedWorkerOptions): void {
  start(init(options));
}

/**
 * Starts the package-owned worker runtime. The main-thread client sends the schema and module URLs
 * as an internal init message.
 *
 * @internal
 */
export function createConvexEmbeddedWorkerFromMessage(): void {
  let state: Promise<WorkerState> | undefined;
  // A worker hosts exactly one runtime, so it serves exactly one transport: either the implicit
  // `self` channel or a single bound port. A second port would share this `state` closure and
  // silently interleave two clients' requests over one runtime, so we bind at most one.
  let bound = false;
  const bind = (port: EmbeddedWorker, postResponse: (message: WorkerResponse) => void): void => {
    port.start?.();
    port.addEventListener("message", (event) => {
      const request = event.data as WorkerRequest;
      if (request.op === WorkerCommand.Init) {
        if (state) {
          postResponse({
            error: serializeError(new Error("Convex embedded worker is already initialized.")),
            id: request.id,
            op: WorkerEvent.Result,
          });
          return;
        }
        postDebug(request.debug, "worker:init:received", undefined, postResponse);
        state = initFromMessage(request, postResponse);
        void state.then(
          () => {
            postDebug(request.debug, "worker:init:ready", undefined, postResponse);
            postResponse({ id: request.id, op: WorkerEvent.Result });
          },
          (error) => {
            postDebug(request.debug, "worker:init:error", describeError(error), postResponse);
            postResponse({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
          },
        );
        return;
      }
      if (!state) {
        postResponse({
          error: serializeError(new Error("Convex embedded worker has not been initialized")),
          id: request.id,
          op: WorkerEvent.Result,
        });
        return;
      }
      void handleWorkerRequest(state, request, postResponse);
    });
  };

  self.onmessage = (event) => {
    if (isWorkerPortRequest(event.data)) {
      const port = event.data.port ?? event.ports?.[0];
      if (!port) return;
      if (bound) {
        port.postMessage({
          error: serializeError(
            new Error("Convex embedded worker is already bound to a port and hosts one runtime."),
          ),
          id: -1,
          op: WorkerEvent.Result,
        });
        return;
      }
      bound = true;
      bind(port, (message) => port.postMessage(message));
      return;
    }
    const request = event.data as WorkerRequest;
    if (request.op === WorkerCommand.Init) {
      if (state) {
        post({
          error: serializeError(new Error("Convex embedded worker is already initialized.")),
          id: request.id,
          op: WorkerEvent.Result,
        });
        return;
      }
      postDebug(request.debug, "worker:init:received");
      state = initFromMessage(request);
      void state.then(
        () => {
          postDebug(request.debug, "worker:init:ready");
          post({ id: request.id, op: WorkerEvent.Result });
        },
        (error) => {
          postDebug(request.debug, "worker:init:error", describeError(error));
          post({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
        },
      );
      return;
    }
    if (!state) {
      post({
        error: serializeError(new Error("Convex embedded worker has not been initialized")),
        id: request.id,
        op: WorkerEvent.Result,
      });
      return;
    }
    void handleWorkerRequest(state, request);
  };
}

async function init(options: ConvexEmbeddedWorkerOptions): Promise<WorkerState> {
  return initRuntime({
    modules: options.modules,
    storagePath: browserStoragePath(),
    storeSchema: toStoreSchema(options.schema),
    wasm: options.wasm,
  });
}

/**
 * Initializes the package-owned worker from an internal init message.
 *
 * @param request - Internal worker initialization request.
 * @param postResponse - Response sink for debug and initialization result messages.
 * @returns Worker state after the generated bundle, WASM artifact, and store are ready.
 * @throws If generated virtual modules, WASM loading, OPFS registration, or store setup fails.
 *
 * @internal
 */
export async function initFromMessage(
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>,
  postResponse: (message: WorkerResponse) => void = post,
): Promise<WorkerState> {
  postDebug(request.debug, "worker:bundle:import:start", undefined, postResponse);
  const embedded = await importEmbeddedBundle();
  const schema = embedded.schema;
  postDebug(
    request.debug,
    "worker:bundle:import:done",
    {
      modules: Object.keys(embedded.modules),
    },
    postResponse,
  );
  return initRuntime({
    debug: request.debug,
    modules: embedded.modules,
    storagePath: request.storagePath,
    storeSchema: toStoreSchema(schema),
  });
}

async function importEmbeddedBundle(): Promise<typeof import("virtual:convex-embedded")> {
  try {
    return await import("virtual:convex-embedded");
  } catch (cause) {
    throw Object.assign(
      new Error(
        "ConvexEmbeddedClient requires the @convex-dev/embedded bundler plugin so the browser worker can load your Convex schema and functions.",
      ),
      { cause },
    );
  }
}

/**
 * Creates the worker runtime from already-resolved modules and storage schema.
 *
 * @param options - Modules, storage path, store schema, and optional diagnostics.
 * @returns Worker state containing the OPFS bridge, store, runner, and active watches.
 * @throws If OPFS registration, WASM loading, store opening, or schema setup fails.
 *
 * @internal
 */
export async function initRuntime(options: {
  debug?: boolean;
  modules: ConvexModules;
  storagePath: string;
  storeSchema: StoreSchema;
  wasm?: WasmSource;
}): Promise<WorkerState> {
  const opfs = new OpfsDirectory((phase, detail) => postDebug(options.debug, phase, detail));
  let store: WasmStore | undefined;
  try {
    postDebug(options.debug, "worker:opfs:register:start");
    await registerTursoFiles(opfs, options.storagePath);
    postDebug(options.debug, "worker:opfs:register:done");
    postDebug(options.debug, "worker:wasm:load:start");
    const wasm = await loadWasmModule(options.wasm, {
      debug: (phase, detail) => postDebug(options.debug, phase, detail),
      opfs,
    });
    postDebug(options.debug, "worker:wasm:load:done");
    postDebug(options.debug, "worker:store:open:start");
    store = await WasmStore.openWith(wasm.Store, options.storagePath);
    postDebug(options.debug, "worker:store:open:done");
    postDebug(options.debug, "worker:store:setup:start");
    await store.setup(options.storeSchema);
    postDebug(options.debug, "worker:store:setup:done");
    return {
      opfs,
      runner: createRunner(options.modules, store, options.storeSchema),
      stops: new Map(),
      store,
    };
  } catch (error) {
    await store?.close().catch(() => undefined);
    opfs.closeAll();
    throw error;
  }
}

function start(state: Promise<WorkerState>): void {
  self.onmessage = (event) => {
    void handleWorkerRequest(state, event.data as WorkerRequest);
  };
}

/**
 * Handles one internal request sent to an embedded browser worker.
 *
 * @param statePromise - Promise for initialized worker state.
 * @param request - Worker protocol request.
 * @param postResponse - Response sink for result, watch, and error messages.
 * @returns A promise that settles after the request has been handled.
 *
 * @internal
 */
export async function handleWorkerRequest(
  statePromise: Promise<WorkerState>,
  request: WorkerRequest,
  postResponse: (message: WorkerResponse) => void = post,
): Promise<void> {
  if (request.op === WorkerCommand.Close) {
    try {
      const state = await statePromise;
      for (const stop of state.stops.values()) stop();
      state.stops.clear();
      try {
        await state.store.close();
      } finally {
        state.opfs.closeAll();
      }
      postResponse({ id: request.id, op: WorkerEvent.Result });
      self.close?.();
    } catch (error) {
      postResponse({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
    }
    return;
  }

  try {
    const state = await statePromise;
    await workerCommandHandlers.get(request.op)?.(state, request as never, postResponse);
  } catch (error) {
    postResponse({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
  }
}

function post(message: WorkerResponse): void {
  self.postMessage?.(message);
}

function postDebug(
  enabled: boolean | undefined,
  phase: string,
  detail?: unknown,
  postResponse: (message: WorkerResponse) => void = post,
): void {
  if (!enabled) return;
  postResponse({ detail, phase, op: WorkerEvent.Debug });
}

function describeError(error: unknown): unknown {
  if (error instanceof Error)
    return { message: error.message, name: error.name, stack: error.stack };
  return String(error);
}

function isWorkerPortRequest(value: unknown): value is WorkerPortRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { op?: unknown }).op === PortCommand.Connect
  );
}

async function handleQuery(
  state: WorkerState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Query }>,
  postResponse: (message: WorkerResponse) => void,
): Promise<void> {
  const result = await state.runner.runQuery(request.name, request.args);
  postResponse({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleMutation(
  state: WorkerState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Mutation }>,
  postResponse: (message: WorkerResponse) => void,
): Promise<void> {
  const result = await state.runner.runMutation(request.name, request.args, {
    mutationId: request.mutationId,
    onAccepted: (mutationId) =>
      postResponse({ id: request.id, mutationId, op: WorkerEvent.MutationAccepted }),
  });
  postResponse({ id: request.id, result, op: WorkerEvent.Result });
}

function handleWatchStart(
  state: WorkerState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStart }>,
  postResponse: (message: WorkerResponse) => void,
): void {
  state.stops.get(request.watchId)?.();
  const stop = state.runner.onUpdate(
    request.name,
    request.args,
    (value) => postResponse({ op: WorkerEvent.WatchUpdated, value, watchId: request.watchId }),
    (error) =>
      postResponse({
        error: serializeError(error),
        op: WorkerEvent.WatchFailed,
        watchId: request.watchId,
      }),
  );
  state.stops.set(request.watchId, stop);
  postResponse({ id: request.id, op: WorkerEvent.Result });
}

function handleWatchStop(
  state: WorkerState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStop }>,
  postResponse: (message: WorkerResponse) => void,
): void {
  state.stops.get(request.watchId)?.();
  state.stops.delete(request.watchId);
  postResponse({ id: request.id, op: WorkerEvent.Result });
}
