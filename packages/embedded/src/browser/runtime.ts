/**
 * Browser worker runtime entrypoint for embedded Convex.
 *
 * @remarks
 * This module is used by the package-owned worker runtime. Applications should
 * construct `ConvexEmbeddedClient` from
 * `@estifanos-sh/convex-embedded/browser` instead.
 *
 * @packageDocumentation
 */
import type { ConvexModules } from "../client";
import { openCandidate } from "../candidate";
import type {
  DiagnosticEventListener,
  EmbeddedRemoteEvent,
  EmbeddedRuntimeDegradation,
  EmbeddedRuntimeEvent,
  EmbeddedRuntimePhase,
} from "../events";
import { EMBEDDED_ERROR_CODES, EmbeddedClientRetiredError, errorMessage } from "../error";
import { randomId } from "../id/random";
import { createRunner, type Runner } from "../runtime/runner";
import type { ConvexEmbeddedSchema } from "../schema";
import { localCompatibilitySchema, localGraphHash, localReferenceName } from "../local/internal";
import {
  consumeRemoteTick,
  mergeRemoteTicks,
  remotePendingIsEmpty,
  REMOTE_PULL_DIAGNOSTIC_ERROR,
  remoteTickHasWork,
} from "../rev";
import type {
  RemoteStartOptions,
  RemoteScope,
  RemotePending,
  RemoteMutationSettlement,
  RemoteTick,
  RemoteTransportHost,
  StoreSchema,
} from "../storage/types";
import { getElapsedTime, getTimerTime } from "../time";
import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { REMOTE_CLIENT_RETIRED_PREFIX, RotationBreaker } from "../retirement";
import { loadWasmModule, PthreadRegistry, type WasmSource } from "./artifact";
import { type StoreRecovery } from "./recovery";
import { OpfsDirectory, registerTursoFiles } from "./opfs";
import {
  deserializeError,
  type EmbeddedWorker,
  WorkerCommand,
  WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { WasmStore } from "./store";
import { readUploadToken } from "../upload";
import { remoteConfigKey } from "./remote";

declare const self: {
  close?: () => void;
  onmessage: ((event: { data: unknown; ports?: EmbeddedWorker[] }) => void) | null;
  postMessage?(message: unknown): void;
};

/**
 * Runtime state owned by an embedded browser worker.
 *
 * @internal
 */
export interface WorkerState {
  /** Runtime event cleanup callback. */
  eventStop?: () => void;
  /** Runtime event sink used by runner and remote lifecycle events. */
  emit?: DiagnosticEventListener;
  /** Exact terminal settlement vectors paired with browser remote diagnostics. */
  emitRemote?: (
    event: EmbeddedRemoteEvent,
    settlements: readonly RemoteMutationSettlement[],
  ) => void;
  /** OPFS bridge used by the Rust/WASM storage imports. */
  opfs: OpfsDirectory;
  /** Local Convex function runner. */
  runner: Runner;
  /** Stops the worker-owned remote replication scheduler. */
  remoteStop?: () => void;
  /** Wakes the worker-owned remote replication scheduler, optionally clearing retry backoff. */
  remoteWake?: (immediate?: boolean) => void;
  /** Resets remote replication so identity negotiation runs before another pull or push. */
  remoteReset?: () => Promise<void>;
  /** Resolves after the configured remote client has started. */
  remoteReady?: Promise<void>;
  /** Clears startup backoff or marks the active startup for an immediate retry. */
  remoteStartWake?: () => void;
  remoteStartImmediate?: boolean;
  /** Consecutive failed remote starts used to bound reconnect backoff. */
  remoteStartAttempt?: number;
  /** Deferred remote startup timer, if remote was configured during init. */
  remoteStartTimer?: ReturnType<typeof setTimeout>;
  /** Canonical remote configuration key owned by this worker runtime. */
  remoteKey?: string;
  /** Live remote transport; retained so a rebuild/offline suspect can close its socket synchronously. */
  remoteTransport?: RemoteTransportHost;
  /** Whether the live transport currently owns an open WebSocket. */
  remoteConnected?: boolean;
  /** Current remote event incarnation and its next ordered sequence. */
  remoteEventGeneration?: number;
  remoteEventSequence?: number;
  /** Last authoritative work snapshot returned by the remote actor. */
  remotePending?: RemotePending;
  /** Latest fenced snapshot replayed to clients that attach after startup. */
  remoteEvent?: EmbeddedRemoteEvent;
  /** Last browser reachability hint; false invalidates readiness and the current socket. */
  remoteNetworkOnline?: boolean;
  /** A network loss invalidated the socket before the remote actor could actively replace it. */
  remoteReconnectRequired?: boolean;
  /** Auth token requests awaiting a main-thread response. */
  remoteAuthPending?: Map<number, RemoteAuthPending>;
  /** Monotonic for the whole worker lifetime so retired auth responses cannot alias a fresh start. */
  remoteAuthRequestId?: number;
  /** True after close begins, so delayed remote startup cannot reopen work. */
  closed?: boolean;
  /** True once the instance is abandoned dead; close must not await its store/remote operations. */
  abandoned?: boolean;
  /** WASM-backed embedded store. */
  store: WasmStore;
  /** Active watch cleanup callbacks keyed by watch ID. */
  stops: Map<number, () => void>;
  /** Loaded WASM storage ABI version for artifact freshness diagnostics. */
  wasmApiVersion?: number;
  /** emnapi pthread pool for the live store instance; recovery terminates it before a graft. */
  pthreads?: PthreadRegistry;
  /** Store-instance recovery controller; when present, lane ops are watchdog-covered. */
  recovery?: StoreRecovery;
  /** Bounds retired-client rotation churn; a tripped breaker surfaces the terminal retirement signal. */
  rotationBreaker?: RotationBreaker;
}

interface RemoteAuthPending {
  reject(error: unknown): void;
  resolve(token: string | null): void;
}

/**
 * A store open/replay slower than this emits a `slow-open` degradation so a UI can show a
 * still-loading notice instead of a dead spinner. Pure observability: it changes no boot timing.
 */
const STORAGE_WAIT_NOTICE_MS = 3_000;
const REMOTE_DEPLOYMENT_MISMATCH_PREFIX = "remote deployment mismatch:";

/**
 * A pull that only sent outbound work (a connect or subscription) leaves an unanswered server
 * response in flight. The loop is otherwise woken by the transport's `onmessage`, but an idle
 * worker whose event loop holds no pending timer can have that delivery suspended by the host.
 * While a response is outstanding the loop keeps a bounded timer pending instead of going fully
 * dormant, so the awaited transition is drained even when `onmessage` is throttled. A multi-step
 * checkpoint pull re-sends on the same tick it receives a chunk, so the timer stays armed until an
 * inbound tick queues no further outbound work.
 */
const REMOTE_RESPONSE_KEEPALIVE_MS = 500;

/** Sink for boot-lifecycle and degradation events surfaced during {@link initRuntime}. */
export type RuntimeEventSink = (event: EmbeddedRuntimeEvent) => void;

const RUNTIME_PHASE_BY_DEBUG: Record<string, EmbeddedRuntimePhase> = {
  "worker:opfs:register:start": "opfs-register",
  "worker:wasm:load:start": "wasm-load",
  "worker:store:open:start": "store-open",
  "worker:store:setup:start": "store-setup",
  "worker:store:wal-write:start": "store-wal-write",
};

function runtimeEventFromDebug(phase: string, detail: unknown): EmbeddedRuntimeEvent | undefined {
  const mapped = RUNTIME_PHASE_BY_DEBUG[phase];
  if (mapped) return { at: getTimerTime(), phase: mapped, type: "runtime" };
  if (phase === "worker:opfs:acquire:retry" || phase === "worker:opfs:acquire:reclaimed") {
    const record = (detail ?? {}) as { attempt?: number; waitedMs?: number };
    return {
      at: getTimerTime(),
      attempt: record.attempt,
      degradation:
        phase === "worker:opfs:acquire:retry" ? "opfs-acquire-retry" : "opfs-acquire-reclaimed",
      type: "runtime",
      waitedMs: record.waitedMs,
    };
  }
  if (phase === "worker:storage:temporary") {
    const record = (detail ?? {}) as { error?: string };
    return runtimeDegradation("temporary-storage", { error: record.error });
  }
  if (phase === "worker:wasm:thread:error" || phase === "worker:wasm:thread:messageerror") {
    const record = (detail ?? {}) as { message?: string };
    return runtimeDegradation("failed", {
      error: record.message ?? "embedded storage worker thread crashed",
    });
  }
  return undefined;
}

function runtimeDegradation(
  degradation: EmbeddedRuntimeDegradation,
  detail: { error?: string; waitedMs?: number } = {},
): EmbeddedRuntimeEvent {
  return {
    at: getTimerTime(),
    degradation,
    error: detail.error,
    type: "runtime",
    waitedMs: detail.waitedMs,
  };
}

function deploymentMismatchMessage(error: unknown): string | undefined {
  const message = errorMessage(error);
  return message.startsWith(REMOTE_DEPLOYMENT_MISMATCH_PREFIX) ? message : undefined;
}

function emitDeploymentMismatch(state: WorkerState, error: unknown): boolean {
  const message = deploymentMismatchMessage(error);
  if (!message) return false;
  state.emit?.(runtimeDegradation("deployment-mismatch", { error: message }));
  return true;
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
  options: { events?: boolean } = {},
): Promise<WorkerState> {
  postDebug(request.debug, "worker:bundle:import:start", undefined, postResponse);
  const embedded = await importEmbeddedBundle();
  postDebug(
    request.debug,
    "worker:bundle:import:done",
    {
      modules: Object.keys(embedded.modules),
    },
    postResponse,
  );
  await validateBrowserSetup(
    request.setup,
    request.identity?.moduleGraphHash,
    embedded.localModules,
  );
  const runtimeStoreSchema =
    request.setup === undefined
      ? embedded.embeddedSchema.runtimeStoreSchema
      : {
          ...embedded.embeddedSchema.runtimeStoreSchema,
          setupHash: `${request.setup.reference}\u0000${request.setup.graphHash}`,
        };
  const state = await initRuntime({
    debug: request.debug,
    emit:
      options.events === false
        ? undefined
        : (event) => postResponse({ event, op: WorkerEvent.Event }),
    emitRemote:
      options.events === false
        ? undefined
        : (event, settlements) =>
            postResponse({
              event,
              op: WorkerEvent.Event,
              ...(settlements.length === 0 ? {} : { settlements: [...settlements] }),
            }),
    localModules: embedded.localModules,
    compatibilitySchemas: await localModuleCompatibilitySchemas(embedded.localModules),
    modules: embedded.modules,
    manifest: embedded.embeddedManifest,
    moduleGraphHash: request.identity?.moduleGraphHash,
    onRuntimeEvent: (event) => postResponse({ event, op: WorkerEvent.Event }),
    setupSchema: runtimeStoreSchema,
    setup: request.setup,
    storagePath: request.storagePath,
    temporaryStoragePath: `:memory:${request.storagePath}`,
    storeSchema: runtimeStoreSchema,
    remote: request.remote !== undefined,
  });
  if (request.remote) {
    postResponse({
      event: { at: getTimerTime(), phase: "remote-attach", type: "runtime" },
      op: WorkerEvent.Event,
    });
    state.remoteReady = ensureWorkerRemoteStarted(
      state,
      request.remote,
      request.debug,
      postResponse,
    );
  }
  return state;
}

async function importEmbeddedBundle(): Promise<typeof import("virtual:convex-embedded")> {
  try {
    const browserWindow = (
      globalThis as typeof globalThis & {
        window?: { __convexAllowFunctionsInBrowser?: boolean };
      }
    ).window;
    if (browserWindow) browserWindow.__convexAllowFunctionsInBrowser = true;
    return await import("virtual:convex-embedded");
  } catch (cause) {
    throw Object.assign(
      new Error(
        "ConvexEmbeddedClient requires the @estifanos-sh/convex-embedded Vite or unplugin adapter so the browser worker can load your Convex schema and functions.",
      ),
      { cause },
    );
  }
}

async function validateBrowserSetup(
  setup: { graphHash: string; reference: string } | undefined,
  moduleGraphHash: string | undefined,
  localModules: import("../runtime/runner").LocalModuleMap,
): Promise<void> {
  if (setup === undefined) return;
  if (setup.graphHash !== moduleGraphHash) {
    throw new Error("Candidate setup graph identity does not match the worker runtime.");
  }
  const separator = setup.reference.lastIndexOf(":");
  const moduleId = separator < 0 ? "" : setup.reference.slice(0, separator);
  const exportName = separator < 0 ? "" : setup.reference.slice(separator + 1);
  const load = localModules[moduleId];
  if (load === undefined || exportName.length === 0) {
    throw new Error(
      `Candidate setup ${setup.reference} is not registered in the loaded local module graph.`,
    );
  }
  const loaded = (await load()) as Record<string, unknown>;
  const value = loaded[exportName];
  if (localReferenceName(value) !== setup.reference || localGraphHash(value) !== setup.graphHash) {
    throw new Error(
      `Candidate setup ${setup.reference} does not match the loaded local module graph.`,
    );
  }
}

async function startWorkerRemote(
  state: WorkerState,
  remote: NonNullable<Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>["remote"]>,
  debug: boolean | undefined,
  postResponse: (message: WorkerResponse) => void,
  eventGeneration: number,
): Promise<void> {
  if (!state.store.remote) {
    throw new Error("Browser remote replication requires a WASM artifact with remote support.");
  }
  rejectPendingRemoteAuth(state, new Error("Browser remote replication restarting."));
  const pendingAuth = new Map<number, RemoteAuthPending>();
  state.remoteAuthPending = pendingAuth;
  const auth: RemoteStartOptions["auth"] | undefined = remote.authFetchToken
    ? ({ forceRefreshToken }) =>
        new Promise<string | null>((resolve, reject) => {
          if (state.remoteAuthPending !== pendingAuth) {
            reject(new Error("Browser remote replication auth request is stale."));
            return;
          }
          const authRequestId = (state.remoteAuthRequestId ?? 0) + 1;
          state.remoteAuthRequestId = authRequestId;
          pendingAuth.set(authRequestId, { reject, resolve });
          postResponse({
            authRequestId,
            forceRefreshToken,
            op: WorkerEvent.AuthTokenRequest,
          });
        })
    : undefined;

  postDebug(debug, "worker:remote:store-start:before", undefined, postResponse);
  const generation = state.recovery?.remoteGeneration ?? 0;
  const stale = () =>
    state.remoteEventGeneration !== eventGeneration ||
    (state.recovery?.remoteGeneration ?? 0) !== generation;
  const transport = createRemoteTransport(
    remote.operationTimeoutMs ?? 30_000,
    (phase, detail) => postDebug(debug, phase, detail, postResponse),
    () => state.remoteWake?.(),
    (url, blob) => state.runner.handleUpload(url, blob),
    () => state.recovery?.transportActive(generation),
    () => state.recovery?.progress(generation, "push"),
    (connected) => writeWorkerRemoteConnection(state, connected, eventGeneration),
  );
  state.remoteTransport = transport;
  await state.store.remote.start({
    auth,
    clientId: remote.clientId,
    moduleGraphHash: remote.moduleGraphHash,
    operationTimeoutMs: remote.operationTimeoutMs,
    protocolVersion: remote.protocolVersion,
    receiveTimeoutMs: remote.receiveTimeoutMs,
    schemaHash: remote.schemaHash,
    transport,
    url: remote.url,
  });
  if (stale()) return;
  if (!state.store.remote.identity) {
    throw new Error("Browser remote replication requires identity negotiation support.");
  }
  const disarm = state.recovery?.arm("remote-start");
  try {
    await state.store.remote.identity();
    if (stale()) return;
    await state.runner.remote?.scope.write();
  } finally {
    disarm?.();
  }
  if (stale()) return;
  postDebug(debug, "worker:remote:store-start:after", undefined, postResponse);

  postDebug(debug, "worker:remote:loop:start", undefined, postResponse);
  state.remoteStop = startWorkerRemoteLoop(
    state,
    (phase, detail) => postDebug(debug, phase, detail, postResponse),
    () => {
      void rotateRetiredClient(state, remote, debug, postResponse);
    },
    eventGeneration,
  );
}

/**
 * Rotates a retired client incarnation: tears the current remote down, mints a fresh clientId, and
 * restarts the remote so a fresh complete pull re-establishes accepted heads. Unresolved local work
 * survives teardown as dirty rows in the retained store and re-pushes under the new author.
 *
 * @internal
 */
export async function rotateRetiredClient(
  state: WorkerState,
  remote: NonNullable<Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>["remote"]>,
  debug: boolean | undefined,
  postResponse: (message: WorkerResponse) => void,
): Promise<void> {
  const breaker = (state.rotationBreaker ??= new RotationBreaker());
  if (breaker.record(getTimerTime())) {
    postDebug(
      debug,
      "worker:remote:retired:exhausted",
      { clientId: remote.clientId },
      postResponse,
    );
    await stopWorkerRemote(state);
    state.emit?.(
      runtimeDegradation("retired", { error: EMBEDDED_ERROR_CODES.EMBEDDED_CLIENT_RETIRED }),
    );
    return;
  }
  const previous = remote.clientId;
  remote.clientId = randomId("client");
  postDebug(debug, "worker:remote:retired", { next: remote.clientId, previous }, postResponse);
  await stopWorkerRemote(state);
  if (state.closed) return;
  await ensureWorkerRemoteStarted(state, remote, debug, postResponse);
}

function emitWorkerRemoteEvent(
  state: WorkerState,
  status: "starting" | "started" | "connected" | "tick" | "idle" | "offline" | "error" | "closed",
  detail: {
    attempt?: number;
    durationMs?: number;
    error?: unknown;
    foreground?: { actorQueueDepth: number; actorQueueMs: number };
    nextRunIn?: number;
    tick?: RemoteTick;
    generation?: number;
  } = {},
): void {
  const generation = detail.generation ?? state.remoteEventGeneration ?? 0;
  if (generation !== (state.remoteEventGeneration ?? 0)) return;
  if (
    state.remoteNetworkOnline === false &&
    (status === "connected" || status === "tick" || status === "idle")
  ) {
    return;
  }
  const sequence = (state.remoteEventSequence ?? 0) + 1;
  state.remoteEventSequence = sequence;
  const now = getTimerTime();
  const settlements = detail.tick?.settlements ?? [];
  const tick =
    detail.tick === undefined
      ? undefined
      : (() => {
          const { settlements: _settlements, ...diagnosticTick } = detail.tick!;
          return { ...diagnosticTick, retainedRevisions: diagnosticTick.retainedRevisions.length };
        })();
  const event: EmbeddedRemoteEvent = {
    at: now,
    attempt: detail.attempt ?? 0,
    durationMs: detail.durationMs,
    error: detail.error === undefined ? undefined : errorMessage(detail.error),
    foreground: detail.foreground,
    generation,
    nextRunAt: detail.nextRunIn === undefined ? undefined : now + detail.nextRunIn,
    status,
    sequence,
    tick,
    type: "remote",
    wasmApiVersion: state.wasmApiVersion,
  };
  state.remoteEvent = event;
  if (state.emitRemote) {
    state.emitRemote(event, settlements);
  } else {
    state.emit?.(event);
  }
}

/** Emits a recovery error through the same generation/sequence fence as transport state. */
export function emitWorkerRemoteError(state: WorkerState, error: unknown): void {
  emitWorkerRemoteEvent(state, "error", { error });
}

export function ensureWorkerRemoteStarted(
  state: WorkerState,
  remote: NonNullable<Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>["remote"]>,
  debug: boolean | undefined,
  postResponse: (message: WorkerResponse) => void,
): Promise<void> {
  if (!state.remoteReset) {
    state.remoteReset = async () => {
      await stopWorkerRemote(state);
      if (state.closed) return;
      await ensureWorkerRemoteStarted(state, remote, debug, postResponse);
    };
  }
  const key = remoteConfigKey(remote);
  if (state.remoteKey !== undefined && state.remoteKey !== key) {
    throw new Error(
      "ConvexEmbeddedClient cannot attach to an existing browser runtime with a different remote configuration.",
    );
  }
  state.remoteKey = key;
  state.remoteStartWake = () => {
    state.remoteStartAttempt = 0;
    if (state.remoteStartTimer !== undefined) {
      clearTimeout(state.remoteStartTimer);
      state.remoteStartTimer = undefined;
    }
    if (state.remoteReady) {
      state.remoteStartImmediate = true;
      return;
    }
    void ensureWorkerRemoteStarted(state, remote, debug, postResponse);
  };
  if (state.remoteReady) return state.remoteReady;
  let ready: Promise<void> | undefined;
  ready = (async () => {
    if (state.closed) return;
    const eventGeneration = (state.remoteEventGeneration ?? 0) + 1;
    state.remoteEventGeneration = eventGeneration;
    state.remoteEventSequence = 0;
    state.remoteConnected = false;
    state.remoteNetworkOnline ??= true;
    state.remoteReconnectRequired = false;
    state.remotePending = undefined;
    const recoveryGeneration = state.recovery?.remoteGeneration ?? 0;
    const stale = () =>
      state.remoteEventGeneration !== eventGeneration ||
      (state.recovery?.remoteGeneration ?? 0) !== recoveryGeneration;
    postDebug(debug, "worker:remote:start", undefined, postResponse);
    emitWorkerRemoteEvent(state, state.remoteNetworkOnline === false ? "offline" : "starting", {
      generation: eventGeneration,
    });
    try {
      await startWorkerRemote(state, remote, debug, postResponse, eventGeneration);
      if (stale()) return;
      state.remoteStartAttempt = 0;
      emitWorkerRemoteEvent(state, "started", { generation: eventGeneration });
    } catch (error) {
      if (stale()) return;
      postDebug(debug, "worker:remote:error", describeError(error), postResponse);
      if (ready !== undefined && state.remoteReady === ready) state.remoteReady = undefined;
      await state.store.remote?.close().catch(() => undefined);
      if (stale()) return;
      const terminal = emitDeploymentMismatch(state, error);
      const nextRunIn =
        terminal || state.remoteNetworkOnline === false
          ? undefined
          : scheduleWorkerRemoteStart(state, remote, debug, postResponse);
      const status = terminal
        ? "error"
        : state.remoteNetworkOnline === false
          ? "offline"
          : "starting";
      emitWorkerRemoteEvent(state, status, {
        error,
        generation: eventGeneration,
        nextRunIn,
      });
    }
  })();
  ready.catch(() => undefined);
  state.remoteReady = ready;
  return ready;
}

function scheduleWorkerRemoteStart(
  state: WorkerState,
  remote: NonNullable<Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>["remote"]>,
  debug: boolean | undefined,
  postResponse: (message: WorkerResponse) => void,
): number | undefined {
  if (state.closed || state.remoteStartTimer !== undefined) return undefined;
  const attempt = (state.remoteStartAttempt ?? 0) + 1;
  state.remoteStartAttempt = attempt;
  const immediate = state.remoteStartImmediate === true;
  state.remoteStartImmediate = false;
  const delayMs = immediate ? 0 : Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
  state.remoteStartTimer = setTimeout(() => {
    state.remoteStartTimer = undefined;
    void ensureWorkerRemoteStarted(state, remote, debug, postResponse);
  }, delayMs);
  return delayMs;
}

/**
 * Synchronously tears down the remote replication loop of a suspect instance without touching its
 * store: the loop stop clears timers and unsubscribes only, and the wedged `store.remote.close()`
 * is deliberately never awaited (spec §2 — never await a suspect promise). Remote fields are reset
 * so a later {@link ensureWorkerRemoteStarted} starts a fresh loop.
 *
 * @internal
 */
export function abandonWorkerRemote(state: WorkerState): void {
  if (state.remoteStartTimer !== undefined) {
    clearTimeout(state.remoteStartTimer);
    state.remoteStartTimer = undefined;
  }
  const transport = state.remoteTransport;
  state.remoteTransport = undefined;
  void transport?.close();
  const stop = state.remoteStop;
  state.remoteStop = undefined;
  stop?.();
  state.remoteEventGeneration = (state.remoteEventGeneration ?? 0) + 1;
  state.remoteEventSequence = 0;
  state.remoteConnected = false;
  state.remotePending = undefined;
  state.remoteReconnectRequired = false;
  state.remoteReady = undefined;
  state.remoteReset = undefined;
  state.remoteStartAttempt = 0;
  state.remoteStartImmediate = false;
  state.remoteStartWake = undefined;
  state.remoteKey = undefined;
  state.remoteWake = undefined;
  rejectPendingRemoteAuth(state, new Error("Browser remote replication rebuilding."));
}

/**
 * Synchronously closes the live remote socket while leaving the replication loop running, so a
 * hung receive settles and the loop reconnects on its own backoff. Used by the recovery
 * controller's offline (transport-suspect) verdict: the store is healthy, only the network is down.
 *
 * @internal
 */
export function closeWorkerRemoteSocket(state: WorkerState): void {
  void state.remoteTransport?.close();
}

/** Invalidates a suspect socket immediately; only a fresh socket callback can confirm reconnection. */
export function writeWorkerRemoteNetwork(state: WorkerState, online: boolean): void {
  const wasOnline = state.remoteNetworkOnline;
  state.remoteNetworkOnline = online;
  if (!online) {
    state.remoteConnected = false;
    state.remoteReconnectRequired = true;
    if (
      wasOnline !== false &&
      state.remoteWake !== undefined &&
      state.remoteTransport !== undefined
    ) {
      closeWorkerRemoteSocket(state);
    }
    emitWorkerRemoteEvent(state, "offline");
    state.remoteWake?.(false);
    return;
  }
  emitWorkerRemoteEvent(state, "starting");
  if (state.remoteWake) state.remoteWake(true);
  else state.remoteStartWake?.();
}

/** Applies one generation-fenced socket state transition from the transport host. @internal */
export function writeWorkerRemoteConnection(
  state: WorkerState,
  connected: boolean,
  generation: number,
): void {
  if (generation !== state.remoteEventGeneration) return;
  if (connected && state.remoteNetworkOnline === false) {
    state.remoteConnected = false;
    if (state.remoteReconnectRequired !== true) {
      state.remoteReconnectRequired = true;
      closeWorkerRemoteSocket(state);
    }
    return;
  }
  if (state.remoteConnected === connected) return;
  state.remoteConnected = connected;
  if (connected) state.remoteReconnectRequired = false;
  emitWorkerRemoteEvent(state, connected ? "connected" : "offline", { generation });
}

export async function stopWorkerRemote(state: WorkerState): Promise<void> {
  if (state.remoteStartTimer !== undefined) {
    clearTimeout(state.remoteStartTimer);
    state.remoteStartTimer = undefined;
  }
  const stop = state.remoteStop;
  state.remoteStop = undefined;
  stop?.();
  state.remoteEventGeneration = (state.remoteEventGeneration ?? 0) + 1;
  state.remoteEventSequence = 0;
  state.remoteConnected = false;
  state.remotePending = undefined;
  state.remoteReconnectRequired = false;
  state.remoteReady = undefined;
  state.remoteStartAttempt = 0;
  state.remoteStartImmediate = false;
  state.remoteStartWake = undefined;
  state.remoteKey = undefined;
  state.remoteWake = undefined;
  state.remoteTransport = undefined;
  rejectPendingRemoteAuth(state, new Error("Browser remote replication closed."));
  await state.store.remote?.close().catch(() => undefined);
}

/**
 * Transfers a claimed pending upload's bytes during `drain_uploads`. `embedded:upload` mints the
 * upload URL: in a fully local runtime it is an embedded token route handled in-process, while
 * against a live Convex deployment it is a real storage URL that must be POSTed over the network.
 * Routing by URL shape lets in-browser replication complete uploads to either target — the remote
 * branch mirrors the native HttpRemoteUploader (POST bytes, parse `storageId` from the JSON body).
 *
 * @internal
 */
export async function transferRemoteUpload(
  args: { uploadUrl: string; bytes: Uint8Array; contentType?: string },
  handleUpload: (url: string, blob: Blob) => Promise<{ storageId: string }>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<{ storageId: string }> {
  const { uploadUrl, bytes, contentType } = args;
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const blob = new Blob([owned], contentType ? { type: contentType } : undefined);
  if (readUploadToken(uploadUrl) !== undefined) {
    return handleUpload(uploadUrl, blob);
  }
  const response = await fetchImpl(uploadUrl, {
    body: blob,
    headers: contentType ? { "content-type": contentType } : undefined,
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`upload POST failed with status ${response.status}: ${body}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw Object.assign(new Error("upload response was not JSON"), { cause });
  }
  const storageId =
    parsed && typeof parsed === "object"
      ? (parsed as { storageId?: unknown }).storageId
      : undefined;
  if (typeof storageId !== "string") {
    throw new Error("upload response missing storageId");
  }
  return { storageId };
}

export interface TransitionChunkBuffer {
  bytes: number;
  transitionId: string;
  totalParts: number;
  parts: string[];
}

interface TransitionChunkStep {
  buffer: TransitionChunkBuffer | undefined;
  message: string | undefined;
}

export interface RemoteTransportLimits {
  inboxBytes: number;
  inboxCount: number;
  messageBytes: number;
  totalParts: number;
}

export const REMOTE_TRANSPORT_LIMITS: RemoteTransportLimits = {
  inboxBytes: 32 * 1024 * 1024,
  inboxCount: 128,
  messageBytes: 16 * 1024 * 1024,
  totalParts: 256,
};

const REMOTE_TRANSPORT_INPUT_ERROR = "websocket transport input limit exceeded";

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) index += 1;
      bytes += low >= 0xdc00 && low <= 0xdfff ? 4 : 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Chunked `Transition` frames must be joined before the actor; the sync client rejects raw chunks. */
export function assembleTransitionChunk(
  buffer: TransitionChunkBuffer | undefined,
  raw: string,
  limits: RemoteTransportLimits = REMOTE_TRANSPORT_LIMITS,
): TransitionChunkStep {
  const rawBytes = utf8Bytes(raw);
  if (rawBytes > limits.messageBytes) throw new Error(REMOTE_TRANSPORT_INPUT_ERROR);
  const chunk = JSON.parse(raw) as {
    type?: string;
    chunk?: string;
    partNumber?: number;
    totalParts?: number;
    transitionId?: string;
  };
  if (chunk.type !== "TransitionChunk") return { buffer: undefined, message: raw };
  if (
    typeof chunk.chunk !== "string" ||
    typeof chunk.transitionId !== "string" ||
    typeof chunk.totalParts !== "number" ||
    typeof chunk.partNumber !== "number" ||
    !Number.isSafeInteger(chunk.totalParts) ||
    !Number.isSafeInteger(chunk.partNumber) ||
    chunk.partNumber < 0 ||
    chunk.totalParts <= 0 ||
    chunk.partNumber >= chunk.totalParts ||
    chunk.partNumber !== (buffer?.parts.length ?? 0) ||
    (buffer &&
      (buffer.transitionId !== chunk.transitionId || buffer.totalParts !== chunk.totalParts))
  ) {
    throw new Error("websocket received an invalid TransitionChunk");
  }
  if (chunk.totalParts > limits.totalParts) throw new Error(REMOTE_TRANSPORT_INPUT_ERROR);
  const next: TransitionChunkBuffer = buffer ?? {
    bytes: 0,
    parts: [],
    totalParts: chunk.totalParts,
    transitionId: chunk.transitionId,
  };
  const chunkBytes = utf8Bytes(chunk.chunk);
  if (next.bytes + chunkBytes > limits.messageBytes) {
    throw new Error(REMOTE_TRANSPORT_INPUT_ERROR);
  }
  next.bytes += chunkBytes;
  next.parts.push(chunk.chunk);
  if (next.parts.length < next.totalParts) return { buffer: next, message: undefined };
  const message = next.parts.join("");
  const assembled = JSON.parse(message) as { type?: string };
  if (assembled.type !== "Transition") {
    throw new Error(`expected Transition after assembling chunks, got ${assembled.type}`);
  }
  return { buffer: undefined, message };
}

export function createRemoteTransport(
  connectTimeoutMs: number,
  debug: (phase: string, detail?: unknown) => void,
  onWake: () => void = () => undefined,
  handleUpload: (url: string, blob: Blob) => Promise<{ storageId: string }>,
  onTransportActivity: () => void = () => undefined,
  onLaneProgress: () => void = () => undefined,
  onConnectionChange: (connected: boolean) => void = () => undefined,
  limits: RemoteTransportLimits = REMOTE_TRANSPORT_LIMITS,
): RemoteTransportHost {
  let socket: WebSocket | undefined;
  let generation = 0;
  let pendingConnectReject: ((error: Error) => void) | undefined;
  const inbox: Array<{ kind: "closed"; reason?: string } | { kind: "message"; message: string }> =
    [];
  let inboxBytes = 0;
  const waiters: Array<() => void> = [];
  let chunkBuffer: TransitionChunkBuffer | undefined;

  const inboxClear = () => {
    inbox.splice(0);
    inboxBytes = 0;
  };

  const inboxRead = () => {
    const event = inbox.shift();
    if (event?.kind === "message") inboxBytes -= utf8Bytes(event.message);
    return event;
  };

  const failInput = (reason: string) => {
    debug("worker:remote:transport:protocol-error", { reason });
    chunkBuffer = undefined;
    inboxClear();
    inbox.push({ kind: "closed", reason });
    generation += 1;
    const current = socket;
    socket = undefined;
    onConnectionChange(false);
    if (current) {
      current.onclose = null;
      current.onerror = null;
      current.onmessage = null;
      current.onopen = null;
      current.close(1009, "invalid server message");
    }
    wake();
  };

  const inboxWrite = (message: string): boolean => {
    const bytes = utf8Bytes(message);
    if (inbox.length >= limits.inboxCount || inboxBytes + bytes > limits.inboxBytes) {
      failInput(REMOTE_TRANSPORT_INPUT_ERROR);
      return false;
    }
    inbox.push({ kind: "message", message });
    inboxBytes += bytes;
    return true;
  };

  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
    onWake();
  };
  const receiveInbox = () => {
    // Arrival owns the wake. Reading an item is already part of the active Rust
    // actor turn and must not manufacture a redundant follow-up pull.
    return inboxRead();
  };
  const acceptServerMessage = (raw: string): boolean => {
    let assembled: TransitionChunkStep;
    try {
      assembled = assembleTransitionChunk(chunkBuffer, raw, limits);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failInput(reason);
      return false;
    }
    chunkBuffer = assembled.buffer;
    if (assembled.message === undefined) return false;
    return inboxWrite(assembled.message);
  };

  return {
    close: async () => {
      debug("worker:remote:transport:close");
      generation += 1;
      chunkBuffer = undefined;
      inboxClear();
      const rejectPending = pendingConnectReject;
      pendingConnectReject = undefined;
      const current = socket;
      socket = undefined;
      onConnectionChange(false);
      if (current) {
        current.onclose = null;
        current.onerror = null;
        current.onmessage = null;
        current.onopen = null;
        current.close();
      }
      rejectPending?.(new Error("websocket closed during connect"));
      inbox.push({ kind: "closed", reason: "client closed" });
      wake();
    },
    connect: ({ url }) =>
      new Promise<void>((resolve, reject) => {
        debug("worker:remote:transport:connect:start", { url });
        generation += 1;
        const socketGeneration = generation;
        const rejectPrevious = pendingConnectReject;
        pendingConnectReject = undefined;
        const previous = socket;
        if (previous) {
          previous.onclose = null;
          previous.onerror = null;
          previous.onmessage = null;
          previous.onopen = null;
          previous.close();
        }
        rejectPrevious?.(new Error("websocket connect superseded"));
        inboxClear();
        chunkBuffer = undefined;
        const current = new WebSocket(url);
        let settled = false;
        const isCurrent = () => socket === current && generation === socketGeneration;
        const timer = setTimeout(() => {
          if (!isCurrent()) return;
          rejectOnce(new Error(`websocket connect timed out after ${connectTimeoutMs}ms`));
          current.close();
        }, connectTimeoutMs);
        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          if (pendingConnectReject === rejectOnce) pendingConnectReject = undefined;
          clearTimeout(timer);
          debug("worker:remote:transport:connect:open", { url });
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          if (pendingConnectReject === rejectOnce) pendingConnectReject = undefined;
          clearTimeout(timer);
          debug("worker:remote:transport:connect:error", { message: error.message, url });
          reject(error);
        };
        pendingConnectReject = rejectOnce;
        socket = current;
        current.onopen = () => {
          if (!isCurrent()) return;
          onConnectionChange(true);
          onTransportActivity();
          resolveOnce();
        };
        current.onerror = () => {
          if (!isCurrent()) return;
          onConnectionChange(false);
          chunkBuffer = undefined;
          debug("worker:remote:transport:error");
          if (!settled) {
            rejectOnce(new Error("websocket error"));
            return;
          }
          inbox.push({ kind: "closed", reason: "websocket error" });
          wake();
        };
        current.onclose = (event) => {
          if (!isCurrent()) return;
          onConnectionChange(false);
          chunkBuffer = undefined;
          debug("worker:remote:transport:closed", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
          socket = undefined;
          rejectOnce(new Error(event.reason || `websocket closed with code ${event.code}`));
          inbox.push({
            kind: "closed",
            reason: event.reason || `websocket closed with code ${event.code}`,
          });
          wake();
        };
        current.onmessage = (event) => {
          if (!isCurrent()) return;
          if (typeof event.data === "string") {
            debug("worker:remote:transport:message", { bytes: event.data.length });
            onTransportActivity();
            if (acceptServerMessage(event.data)) wake();
          }
        };
      }),
    monotonicMs: getTimerTime,
    nowMs: getTimerTime,
    receive: async ({ timeoutMs }) => {
      const event = receiveInbox();
      if (event) {
        debug("worker:remote:transport:receive", { kind: event.kind });
        return event;
      }
      return await new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          const next = receiveInbox() ?? { kind: "timeout" as const };
          debug("worker:remote:transport:receive", { kind: next.kind });
          resolve(next);
        };
        timer = setTimeout(() => {
          const index = waiters.indexOf(done);
          if (index >= 0) waiters.splice(index, 1);
          debug("worker:remote:transport:receive", { kind: "timeout" });
          resolve({ kind: "timeout" });
        }, timeoutMs);
        waiters.push(done);
      });
    },
    runStoreJob: () => undefined,
    send: async ({ message }) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("websocket is not connected");
      }
      try {
        debug("worker:remote:transport:send", { bytes: message.length });
        socket.send(message);
        onTransportActivity();
      } catch (cause) {
        throw Object.assign(new Error("websocket send failed"), { cause });
      }
    },
    upload: async ({ uploadUrl, bytes, contentType }) => {
      debug("worker:remote:transport:upload", { bytes: bytes.byteLength });
      onLaneProgress();
      const uploaded = await transferRemoteUpload({ bytes, contentType, uploadUrl }, handleUpload);
      onLaneProgress();
      return uploaded;
    },
  };
}

export function handleWorkerRemoteAuthResult(
  state: WorkerState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.AuthTokenResult }>,
): void {
  const pending = state.remoteAuthPending?.get(request.authRequestId);
  if (!pending) return;
  state.remoteAuthPending?.delete(request.authRequestId);
  if (request.error) {
    pending.reject(deserializeError(request.error));
  } else {
    pending.resolve(request.token ?? null);
  }
}

export function startWorkerRemoteLoop(
  state: WorkerState,
  debug: (phase: string, detail?: unknown) => void = () => undefined,
  onRetired: () => void = () => undefined,
  eventGeneration: number = state.remoteEventGeneration ?? 0,
): () => void {
  const remote = state.store.remote;
  if (!remote) {
    throw new Error("Browser remote replication requires a WASM artifact with remote support.");
  }
  if (!remote.pull) {
    throw new Error("Browser remote replication requires a WASM artifact that exports remotePull.");
  }
  const pull = remote.pull.bind(remote);
  const push = remote.doc?.push.bind(remote.doc);
  const generation = state.recovery?.remoteGeneration ?? 0;
  const isCurrent = () => eventGeneration === (state.remoteEventGeneration ?? 0);
  let attempt = 0;
  let consecutiveErrors = 0;
  let pullDiagnostic: string | undefined;
  let stopped = false;
  let running = false;
  let wakePending = false;
  let localProgressPending = true;
  let awaitingResponse = false;
  let nextAllowedRunAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let microtaskPending = false;
  let immediateRetryPending = false;
  const scope = remote.scope;
  const scopeWrite = scope?.write.bind(scope);
  let scheduledScopeWrite: ((next: RemoteScope) => Promise<void>) | undefined;
  const backlogPush = { commitSeq: 0, id: "", table: "" };
  let pushPending: { commitSeq: number; id: string; table: string } | undefined = push
    ? backlogPush
    : undefined;
  const emit = (
    status: "starting" | "started" | "connected" | "tick" | "idle" | "offline" | "error" | "closed",
    detail: {
      durationMs?: number;
      error?: unknown;
      foreground?: { actorQueueDepth: number; actorQueueMs: number };
      nextRunIn?: number;
      tick?: Awaited<ReturnType<typeof pull>>;
    } = {},
  ) => emitWorkerRemoteEvent(state, status, { ...detail, attempt, generation: eventGeneration });
  const schedule = (delay: number) => {
    if (stopped || state.remoteNetworkOnline === false) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (delay <= 0) {
      if (microtaskPending) return;
      microtaskPending = true;
      queueMicrotask(() => {
        microtaskPending = false;
        run();
      });
      return;
    }
    timer = setTimeout(run, delay);
  };
  const wake = () => {
    if (stopped || state.remoteNetworkOnline === false) return;
    if (running) {
      wakePending = true;
      return;
    }
    schedule(Math.max(0, nextAllowedRunAt - getTimerTime()));
  };
  if (scope && scopeWrite) {
    scheduledScopeWrite = async (next) => {
      state.remotePending = undefined;
      emit(state.remoteConnected === true ? "tick" : "starting");
      await scopeWrite(next);
      wake();
    };
    scope.write = scheduledScopeWrite;
  }
  const eventStop = state.runner.subscribeEvents?.((event) => {
    if (event.type !== "data" || event.source !== "local") return;
    state.remotePending = undefined;
    emit(state.remoteConnected === true ? "tick" : "starting");
    if (event.changedTables.includes("_pending_uploads")) {
      localProgressPending = true;
      wake();
    }
    const row = event.docWrites[0] ?? event.deletes[0];
    if (!push || row === undefined || event.commitSeq === undefined) return;
    pushPending = { commitSeq: event.commitSeq, id: row.id, table: row.table };
    wake();
  });
  const remoteWakeStop = state.runner.remote?.wake?.subscribe(() => {
    localProgressPending = true;
    pushPending ??= backlogPush;
    state.remotePending = undefined;
    emit(state.remoteConnected === true ? "tick" : "starting");
    wake();
  });
  const remoteWake = (immediate = false) => {
    if (immediate) {
      nextAllowedRunAt = 0;
      consecutiveErrors = 0;
      immediateRetryPending = true;
    }
    pushPending ??= push ? backlogPush : undefined;
    wake();
  };
  state.remoteWake = remoteWake;
  if (state.remoteReconnectRequired) {
    state.remoteReconnectRequired = false;
    closeWorkerRemoteSocket(state);
    remoteWake(state.remoteNetworkOnline !== false);
  }
  let torndown = false;
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (scope && scopeWrite && scope.write === scheduledScopeWrite) scope.write = scopeWrite;
    eventStop?.();
    remoteWakeStop?.();
    if (state.remoteWake === remoteWake) state.remoteWake = undefined;
  };
  const handleRetirement = (startedAt: number, error: unknown): boolean => {
    if (!errorMessage(error).startsWith(REMOTE_CLIENT_RETIRED_PREFIX)) return false;
    if (torndown) return true;
    teardown();
    emit("error", {
      durationMs: getElapsedTime(startedAt),
      error: new EmbeddedClientRetiredError(),
    });
    onRetired();
    return true;
  };
  const run = () => {
    if (stopped || running || state.remoteNetworkOnline === false) return;
    debug("worker:remote:loop:run");
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    wakePending = false;
    const localProgress = localProgressPending;
    localProgressPending = false;
    attempt += 1;
    const startedAt = getTimerTime();
    state.recovery?.onRemoteActive();
    let nextDelay: number | undefined;
    let attemptedPush: typeof pushPending;
    void (async () => {
      let combined: RemoteTick | undefined;
      let foreground: { actorQueueDepth: number; actorQueueMs: number } | undefined;
      if (push && pushPending) {
        attemptedPush = pushPending;
        pushPending = undefined;
        const disarmPush = state.recovery?.arm("push");
        try {
          const result = await push(attemptedPush.table, attemptedPush.id, {
            firstCommitSeq: attemptedPush.commitSeq,
            updatedCommitSeq: attemptedPush.commitSeq,
          });
          attemptedPush = undefined;
          if (!isCurrent()) return undefined;
          // A blocked foreground replay still owns durable work. Keep its backlog token, but do
          // not poll it: transport ingress, a local wake, or an applied pull projection schedules
          // the next attempt. Dropping the token here strands offline mutations after a rebase.
          if (result.state !== "settled") pushPending ??= backlogPush;
          consumeWorkerRemoteTick(state, result.tick);
          state.remotePending = result.tick.pending;
          combined = result.tick;
          foreground = {
            actorQueueDepth: result.actorQueueDepth ?? 0,
            actorQueueMs: result.actorQueueMs ?? 0,
          };
        } finally {
          disarmPush?.();
        }
      }
      const disarmPull = state.recovery?.arm("pull");
      try {
        const pulled = await pull(localProgress);
        return {
          foreground,
          pulled,
          tick: combined ? mergeRemoteTicks(combined, pulled) : pulled,
        };
      } finally {
        disarmPull?.();
      }
    })()
      .then((turn) => {
        if (!turn) return;
        immediateRetryPending = false;
        const { foreground, pulled, tick } = turn;
        if (!isCurrent()) return;
        state.recovery?.progress(generation, "pull");
        nextAllowedRunAt = 0;
        consecutiveErrors = 0;
        if (pulled.pullSnapshots > 0) pullDiagnostic = undefined;
        if (pulled.pullDiagnostics > 0) {
          pullDiagnostic = pulled.pullError ?? REMOTE_PULL_DIAGNOSTIC_ERROR;
        }
        consumeWorkerRemoteTick(state, pulled);
        state.remotePending = pulled.pending;
        // A blocked push retains the shared backlog token until the actor reports its exact final
        // pending snapshot. Clear only that retained token when every lane is drained. A concrete
        // local row token installed while this turn was awaiting the actor must survive the older
        // snapshot and will be handled by `wakePending` on the next turn.
        if (pushPending === backlogPush && remotePendingIsEmpty(state.remotePending)) {
          pushPending = undefined;
        }
        const active = remoteTickHasWork(tick);
        // Transport bookkeeping is observable activity, not proof that another immediate actor
        // turn can advance durable replay. In particular a received frame or an OPFS job count can
        // otherwise turn a blocked mutation into an unbounded microtask poll. A completed pull
        // projection is the local progress that can make a retained blocked push runnable now.
        const pushUnblocked =
          pushPending !== undefined &&
          (tick.pullSnapshots > 0 || tick.pullChangesApplied > 0 || tick.rowsApplied > 0);
        // A newly subscribed pull can send its query and consume the authoritative result in the
        // same WASM actor turn. `pullAttempted` proves that result reached the projection lane, so
        // it must clear the response fence even when the turn also reports outbound protocol
        // messages. Otherwise an empty follow-up has nothing left to receive and the browser polls
        // forever while connectionState remains `starting`.
        if (remotePendingIsEmpty(state.remotePending)) awaitingResponse = false;
        else if (pulled.pullAttempted > 0) awaitingResponse = false;
        else if (pulled.sent > 0) awaitingResponse = true;
        else if (active) awaitingResponse = false;
        const idle =
          state.remoteConnected === true &&
          state.remoteNetworkOnline !== false &&
          !awaitingResponse &&
          !wakePending &&
          pushPending === undefined &&
          remotePendingIsEmpty(state.remotePending);
        if (idle) state.recovery?.onRemoteIdle();
        const delay = wakePending
          ? 0
          : awaitingResponse
            ? REMOTE_RESPONSE_KEEPALIVE_MS
            : pushUnblocked && !remotePendingIsEmpty(state.remotePending)
              ? 0
              : undefined;
        if (pullDiagnostic) {
          emit("error", {
            durationMs: getElapsedTime(startedAt),
            error: new Error(pullDiagnostic),
            foreground,
            nextRunIn: delay,
            tick,
          });
          nextDelay = delay;
          return;
        }
        emit(idle ? "idle" : state.remoteConnected === true ? "tick" : "starting", {
          durationMs: getElapsedTime(startedAt),
          foreground,
          nextRunIn: delay,
          tick,
        });
        nextDelay = delay;
      })
      .catch((error) => {
        if (!isCurrent()) return;
        localProgressPending ||= localProgress;
        if (attemptedPush) pushPending ??= attemptedPush;
        if (handleRetirement(startedAt, error)) return;
        if (emitDeploymentMismatch(state, error)) {
          stopped = true;
          eventStop?.();
          remoteWakeStop?.();
          if (state.remoteWake === remoteWake) state.remoteWake = undefined;
          emit("error", { durationMs: getElapsedTime(startedAt), error });
          return;
        }
        if (state.remoteNetworkOnline === false) {
          immediateRetryPending = false;
          nextAllowedRunAt = 0;
          consecutiveErrors = 0;
          emit("offline", { durationMs: getElapsedTime(startedAt), error });
          return;
        }
        const retryImmediately = immediateRetryPending;
        immediateRetryPending = false;
        consecutiveErrors += 1;
        const delay = retryImmediately ? 0 : Math.min(5_000 * 2 ** (consecutiveErrors - 1), 60_000);
        nextAllowedRunAt = getTimerTime() + delay;
        emit("starting", { durationMs: getElapsedTime(startedAt), error, nextRunIn: delay });
        nextDelay = delay;
      })
      .finally(() => {
        running = false;
        state.recovery?.onRemoteSettled();
        if (state.remoteNetworkOnline === false) return;
        if (wakePending) {
          schedule(Math.max(0, nextAllowedRunAt - getTimerTime()));
        } else if (nextDelay !== undefined) {
          schedule(nextDelay);
        }
      });
  };
  emit("started", { nextRunIn: 0 });
  queueMicrotask(run);
  return () => {
    debug("worker:remote:loop:stop");
    teardown();
    emit("closed");
  };
}

export function consumeWorkerRemoteTick(state: WorkerState, tick: RemoteTick): void {
  consumeRemoteTick(tick, state.runner, (event) => state.emit?.(event));
}

/**
 * Creates the worker runtime from already-resolved modules and storage schema.
 *
 * @param options - Modules, storage path, setup schema, store schema, and diagnostics.
 * @returns Worker state containing the OPFS bridge, store, runner, and active watches.
 * @throws If OPFS registration, WASM loading, store opening, or schema setup fails.
 *
 * @internal
 */
export async function initRuntime(options: {
  debug?: boolean;
  emit?: DiagnosticEventListener;
  emitRemote?: (
    event: EmbeddedRemoteEvent,
    settlements: readonly RemoteMutationSettlement[],
  ) => void;
  localModules?: import("../runtime/runner").LocalModuleMap;
  compatibilitySchemas?: readonly ConvexEmbeddedSchema[];
  modules: ConvexModules;
  manifest?: import("../runtime/runner").RuntimeFunctionManifest;
  moduleGraphHash?: string;
  onDebug?: (phase: string, detail?: unknown) => void;
  onRuntimeEvent?: RuntimeEventSink;
  setupSchema: StoreSchema;
  setup?: { graphHash: string; reference: string };
  remote?: boolean;
  storageWaitNoticeMs?: number;
  storagePath: string;
  temporaryStoragePath?: string;
  storeSchema: StoreSchema;
  wasm?: WasmSource;
}): Promise<WorkerState> {
  const runtimeEvent = options.onRuntimeEvent;
  const holder: { state?: WorkerState } = {};
  const debug = (phase: string, detail?: unknown): void => {
    postDebug(options.debug, phase, detail);
    options.onDebug?.(phase, detail);
    if (runtimeEvent) {
      const event = runtimeEventFromDebug(phase, detail);
      if (event) runtimeEvent(event);
    }
  };
  const instanceDebug =
    (generation: number) =>
    (phase: string, detail?: unknown): void => {
      if (phase === "worker:wasm:thread:error" || phase === "worker:wasm:thread:messageerror") {
        holder.state?.recovery?.reportThreadError(generation);
      }
      debug(phase, detail);
    };
  const openStartedAt = getTimerTime();
  const slowOpenTimer = runtimeEvent
    ? setTimeout(() => {
        runtimeEvent(runtimeDegradation("slow-open", { waitedMs: getTimerTime() - openStartedAt }));
      }, options.storageWaitNoticeMs ?? STORAGE_WAIT_NOTICE_MS)
    : undefined;
  const opfs = new OpfsDirectory((phase, detail) => debug(phase, detail));
  let store: WasmStore | undefined;
  try {
    const opened = await openStoreInstance(opfs, {
      debug: instanceDebug(0),
      storagePath: options.storagePath,
      temporaryStoragePath: options.temporaryStoragePath,
      wasm: options.wasm,
    });
    store = opened.store;
    const runnerOptions = {
      deferNotify: (run: () => void) => {
        setTimeout(run, 0);
      },
      emit: options.emit,
      localModules: options.localModules,
      moduleGraphHash: options.moduleGraphHash,
      manifest: options.manifest,
      remote: options.remote,
    };
    let runner: Runner;
    runtimeEvent?.({ at: getTimerTime(), phase: "store-setup", type: "runtime" });
    if (options.setup !== undefined && options.setup.graphHash !== options.moduleGraphHash) {
      throw new Error("Candidate setup graph identity does not match the worker runtime.");
    }
    const candidate = await openCandidate<Runner>(store, {
      createRunner: ({ schema: runnerSchema, mode, remote }) =>
        createRunner(options.modules, store!, runnerSchema, { ...runnerOptions, mode, remote }),
      localReady: async (candidateRunner) => {
        await candidateRunner.localReady;
      },
      progress: () => runtimeEvent?.({ at: getTimerTime(), phase: "store-setup", type: "runtime" }),
      remote: options.remote === true,
      runnerSchema: options.storeSchema,
      setup:
        options.setup === undefined
          ? undefined
          : {
              compatibilitySchemas: options.compatibilitySchemas ?? [],
              run: async (setupRunner) => {
                await setupRunner.runAction(
                  options.setup!.reference,
                  {},
                  { allowInternal: true, auth: null },
                );
              },
            },
      targetSchema: options.setupSchema,
    });
    runner = candidate.runner;
    if (slowOpenTimer !== undefined) clearTimeout(slowOpenTimer);
    runtimeEvent?.({ at: getTimerTime(), phase: "ready", type: "runtime" });
    const state: WorkerState = {
      emit: options.emit,
      emitRemote: options.emitRemote,
      opfs,
      pthreads: opened.pthreads,
      runner,
      stops: new Map(),
      store,
      wasmApiVersion: opened.wasmApiVersion,
    };
    holder.state = state;
    return state;
  } catch (error) {
    if (slowOpenTimer !== undefined) clearTimeout(slowOpenTimer);
    runtimeEvent?.(
      runtimeDegradation(isUnreadableStoreError(error) ? "corrupt" : "failed", {
        error: errorMessage(error),
      }),
    );
    await store?.close().catch(() => undefined);
    opfs.closeAll();
    throw error;
  }
}

async function localModuleCompatibilitySchemas(
  modules: import("../runtime/runner").LocalModuleMap | undefined,
): Promise<ConvexEmbeddedSchema[]> {
  if (modules === undefined) return [];
  const schemas = new Set<ConvexEmbeddedSchema>();
  for (const load of Object.values(modules)) {
    const module = await load();
    if (typeof module !== "object" || module === null) continue;
    for (const value of Object.values(module as Record<string, unknown>)) {
      const schema = localCompatibilitySchema(value);
      if (schema !== undefined) schemas.add(schema);
    }
  }
  return [...schemas];
}

/**
 * Constructs a fresh physical store instance over the given OPFS bridge: WASM re-instantiation,
 * OPFS re-registration, WAL replay, and a truncating checkpoint. Contract preparation and
 * candidate publication belong to {@link initRuntime}; recovery can therefore replace the
 * physical instance without accidentally running application setup twice. The caller owns the
 * {@link OpfsDirectory} lifecycle.
 *
 * @internal
 */
export async function openStoreInstance(
  opfs: OpfsDirectory,
  options: {
    debug?: (phase: string, detail?: unknown) => void;
    storagePath: string;
    temporaryStoragePath?: string;
    wasm?: WasmSource;
  },
): Promise<{
  store: WasmStore;
  pthreads: PthreadRegistry;
  storagePath: string;
  wasmApiVersion: number;
}> {
  const debug = options.debug ?? (() => undefined);
  const pthreads = new PthreadRegistry();
  let storagePath = options.storagePath;
  if (!isTemporaryStoragePath(storagePath)) {
    debug("worker:opfs:register:start");
    try {
      await registerTursoFiles(opfs, storagePath);
      debug("worker:opfs:register:done");
    } catch (error) {
      if (options.temporaryStoragePath === undefined || !isUnavailableOpfsError(error)) throw error;
      storagePath = options.temporaryStoragePath;
      debug("worker:storage:temporary", { error: errorMessage(error) });
    }
  }
  debug("worker:wasm:load:start");
  const wasm = await loadWasmModule(options.wasm, {
    debug: (phase, detail) => debug(phase, detail),
    opfs,
    registry: pthreads,
  });
  const wasmApiVersion = wasm.apiVersion();
  debug("worker:wasm:load:done");
  const openAndSetup = async (): Promise<WasmStore> => {
    debug("worker:store:open:start");
    const opened = await WasmStore.openWith(wasm.Store, storagePath, {
      defaultIdentityKey: EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
      selectorKey: storagePath,
    });
    debug("worker:store:open:done");
    return opened;
  };
  const store = await openAndSetup();
  try {
    debug("worker:store:wal-write:start");
    await store.wal.write();
    debug("worker:store:wal-write:done");
  } catch (error) {
    debug("worker:store:wal-write:error", describeError(error));
  }
  return {
    pthreads,
    storagePath,
    store,
    wasmApiVersion,
  };
}

function isTemporaryStoragePath(path: string): boolean {
  return path.startsWith(":memory:");
}

/** Distinguishes unavailable storage from a live-owner conflict that must fail closed. @internal */
export function isUnavailableOpfsError(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (
    name === "InvalidStateError" ||
    name === "NotAllowedError" ||
    name === "NotSupportedError" ||
    name === "QuotaExceededError" ||
    name === "SecurityError" ||
    name === "UnknownError"
  ) {
    return true;
  }
  const message = errorMessage(error);
  return (
    message.includes("requires navigator.storage.getDirectory") ||
    message.includes("storage is unavailable in this browsing context") ||
    message.includes("requires OPFS createSyncAccessHandle support")
  );
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

/**
 * A store-open failure that means the on-disk bytes are not a readable current-format store: a
 * corrupt header or a file that is not a database at all. These are the turso `LimboError::Corrupt`
 * and `NotADB` messages the Rust storage layer surfaces verbatim across the wasm boundary. A
 * same-format integrity failure discovered after a clean open does not match, so it stays fail-closed.
 */
function isUnreadableStoreError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("Corrupt database") || message.includes("File is not a database");
}

export function rejectPendingRemoteAuth(state: WorkerState, error: unknown): void {
  const pending = state.remoteAuthPending;
  if (!pending) return;
  state.remoteAuthPending = undefined;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
