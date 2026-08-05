/**
 * Shared types and the platform-neutral embedded Convex client base.
 *
 * @remarks
 * Most applications import {@link ConvexEmbeddedClient} from
 * `@convex-dev/embedded/browser` or from the separate
 * `@convex-dev/embedded/node` entrypoint. This module holds the shared types and
 * base client implementation used by those public entrypoints and by internal
 * test runtimes.
 *
 * @packageDocumentation
 */
import { convexToJson, type Value } from "convex/values";
import { getFunctionName } from "convex/server";
import type {
  ArgsAndOptions,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
  UserIdentity,
} from "convex/server";
import { ConvexClient, type AuthTokenFetcher, type QueryJournal } from "convex/browser";
import { freezeNormalizedTree, normalizeObject } from "./runtime/codec";
import {
  createRunner,
  LOCAL_UNCONFIGURED_ERROR,
  type LocalModuleMap,
  type ModuleMap,
  type Runner,
  type RunnerDevtoolsRequest,
  type RunnerRoute,
  type RuntimeFunctionManifest,
  type RunMutationTiming,
  type StopOnUpdate,
} from "./runtime/runner";
import {
  isLocalFunction,
  localReferenceName,
  type LocalFunctionArgs,
  type LocalFunctionReturns,
  type LocalAction,
  type LocalMutation,
  type LocalQuery,
} from "./local";
import { localGraphHash, localFunctionSchema } from "./local/internal";
import { consumeRemoteTick, remotePendingIsEmpty, REMOTE_PULL_DIAGNOSTIC_ERROR } from "./rev";
import { toRuntimeStoreSchema, type ConvexEmbeddedSchema } from "./schema";
import { openCandidate } from "./candidate";
import type {
  RemoteStartOptions,
  RemoteSurface,
  RemoteTick,
  StorageBackend,
  StoreSchema,
} from "./storage/types";
import { getElapsedTime, getTimerTime } from "./time";
import {
  EmbeddedClientRetiredError,
  EmbeddedClosedError,
  EmbeddedNotOpenError,
  EmbeddedOpenMismatchError,
  EmbeddedHostedDependencyError,
  EmbeddedHostedWriteIndeterminateError,
  EmbeddedOfflineError,
  errorMessage,
} from "./error";
import { randomId } from "./id/random";
import { REMOTE_CLIENT_RETIRED_PREFIX, RotationBreaker } from "./retirement";
import { EMBEDDED_PROTOCOL_VERSION, EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "./protocol";
import type {
  EmbeddedEvent as EmbeddedInternalEvent,
  EmbeddedEventListener as EmbeddedInternalEventListener,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedPublicEventListener,
  EmbeddedRemoteEvent,
  EmbeddedRuntimeEvent,
  EmbeddedSpanEvent,
} from "./events";
import { mapPublicEvent } from "./events";

export type { ConvexEmbeddedSchema } from "./schema";
export type { AuthTokenFetcher } from "convex/browser";
export type {
  EmbeddedPublicEvent as EmbeddedEvent,
  EmbeddedPublicEventListener as EmbeddedEventListener,
} from "./events";
export type {
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
  EmbeddedMutationTiming,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedOperationPhase,
  EmbeddedRemoteEvent,
  EmbeddedRemoteStatus,
  EmbeddedRuntimeDegradation,
  EmbeddedRuntimeEvent,
  EmbeddedRuntimePhase,
  EmbeddedSchedulerEvent,
  EmbeddedSpanEvent,
  EmbeddedSpanPhase,
  EmbeddedStorageEvent,
} from "./events";

/**
 * Internal options carrying the benchmark diagnostic hook.
 *
 * @typeParam Args - Convex mutation argument object accepted by the mutation.
 *
 * @internal
 */
interface MutationOptions<_Args extends Record<string, Value>> {
  /** Internal diagnostic hook used by the benchmark suite. @internal */
  onTiming?: ((timing: EmbeddedClientMutationTiming) => void) | undefined;
}

/** Client-side mutation phase timings used by internal benchmarks. @internal */
export interface EmbeddedClientMutationTiming {
  authMs: number;
  idMs: number;
  normalizeMs: number;
  operationMs: number;
  runnerMs: number;
  stateMs: number;
  totalMs: number;
}

/**
 * Reserved options object accepted by {@link EmbeddedClient.mutation}.
 *
 * @typeParam Args - Convex mutation argument object accepted by the mutation.
 *
 * @public
 */
export interface ConvexEmbeddedMutationOptions<_Args extends Record<string, Value>> {
  readonly __convexEmbeddedMutationOptionsBrand?: never;
}

/**
 * A watched query handle.
 *
 * @remarks
 * Watches are lazy. Calling {@link Watch.onUpdate} starts the underlying local
 * or hosted subscription, and the returned cleanup function stops that
 * subscription when the last listener is removed.
 *
 * @typeParam T - Return type of the watched Convex query.
 *
 * @example
 * ```ts
 * const watch = client.watchQuery(api.todos.list);
 * const unsubscribe = watch.onUpdate(() => {
 *   console.log(watch.localQueryResult());
 * });
 * ```
 *
 * @public
 */
export interface Watch<T> {
  /**
   * Registers a callback that runs after the local query result changes.
   *
   * @param callback - Function invoked after the local query result changes.
   * @returns A function that unsubscribes this callback.
   */
  onUpdate(callback: () => void): () => void;

  /**
   * Returns the latest query result, or `undefined` while no result has been produced.
   *
   * @returns The most recent query result, or `undefined` before the first result.
   * @throws The latest query error when the watched query is currently in an error state.
   */
  localQueryResult(): T | undefined;

  /**
   * Returns the latest local query log lines when available.
   *
   * @returns Query log lines captured during the latest local execution.
   */
  localQueryLogs(): string[] | undefined;
}

/**
 * Convex function modules keyed by module path.
 *
 * @remarks
 * Internal non-browser runtimes receive this map directly. The browser client
 * usually gets it from the Vite/unplugin adapter through the generated virtual
 * module.
 *
 * @public
 */
export type ConvexModules = ModuleMap;

/**
 * Device-only function modules keyed by namespaced local module id.
 *
 * @remarks
 * Bundler-driven runtimes receive this map from the generated virtual module. Node passes it
 * directly.
 *
 * @public
 */
export type ConvexLocalModules = LocalModuleMap;

/**
 * The only application code accepted by {@link EmbeddedClient.open}. It is an imported, stamped,
 * private local action with no arguments and a `null` result; arbitrary callbacks and hosted
 * function references are intentionally not representable here.
 *
 * @public
 */
export type LocalSetupAction = LocalAction<"internal", any, any>;

type ValidLocalSetup<Setup extends LocalSetupAction> = keyof LocalFunctionArgs<Setup> extends never
  ? Awaited<LocalFunctionReturns<Setup>> extends null
    ? Setup
    : never
  : never;

/** Arguments accepted by a device-only function at the app surface. @public */
export type LocalArgs<Fn> =
  LocalFunctionArgs<Fn> extends Record<string, never>
    ? [args?: Record<string, never>]
    : [args: LocalFunctionArgs<Fn>];

/** Arguments and mutation options accepted by a device-only mutation. @public */
export type LocalArgsAndOptions<Fn, Options> =
  LocalFunctionArgs<Fn> extends Record<string, never>
    ? [args?: Record<string, never>, options?: Options]
    : [args: LocalFunctionArgs<Fn>, options?: Options];

/**
 * Mutable authentication state shared by the app client and its remote driver.
 *
 * @internal
 */
export interface EmbeddedAuthState {
  fetchToken?: AuthTokenFetcher;
  onChange?: (isAuthenticated: boolean) => void;
  identity: UserIdentity | null;
}

/**
 * Native Convex remote replication options.
 *
 * @remarks
 * Function paths are intentionally not configurable. Native remote replication
 * always uses the canonical `convex/embedded.ts` exports `pull` and `push`.
 *
 * @public
 */
export interface ConvexEmbeddedRemoteOptions {
  /** Convex deployment URL, such as `https://example.convex.cloud`. */
  url: string;
  /** Receive timeout for one remote protocol tick. */
  receiveTimeoutMs?: number;
  /** Operation timeout for remote query/mutation/action protocol work. */
  operationTimeoutMs?: number;
}

/**
 * Platform-neutral embedded client configuration.
 *
 * @remarks
 * Platform clients adapt this shape to browser WASM/OPFS storage or Node
 * native storage before constructing the shared client.
 *
 * @internal
 */
interface EmbeddedClientBaseOptions {
  /** Convex function modules executed by the local runtime. */
  modules: ConvexModules;
  /** Device-only function modules imported when the runtime starts. */
  localModules?: ConvexLocalModules;
  /** Schemas carried by imported local registrations, collected by platform adapters. @internal */
  localSchemas?: readonly ConvexEmbeddedSchema[];
  /** Build-stamped setup identities actually present in the loaded local registry. @internal */
  localSetupIdentities?: Readonly<Record<string, string>>;
  /** Storage backend, or a promise for one, owned by the client. */
  store: StorageBackend | Promise<StorageBackend>;
  /** Mutable auth state shared with the remote driver. */
  authState?: EmbeddedAuthState;
  /** Optional native remote replication configuration. */
  remote?: ConvexEmbeddedRemoteOptions;
}

/** Platform-neutral embedded client configuration. @internal */
export type EmbeddedClientOptions = EmbeddedClientBaseOptions &
  (
    | {
        /** Live Convex schema analyzed while constructing the client. */
        schema: ConvexEmbeddedSchema;
        manifest?: never;
        moduleGraphHash?: never;
        storeSchema?: never;
      }
    | {
        /** Trusted build-time function placement metadata. */
        manifest: RuntimeFunctionManifest;
        /** Build-time hash of the complete device module graph. */
        moduleGraphHash: string;
        schema?: never;
        /** Generated literal storage schema for native clients without a TS evaluator. */
        storeSchema: StoreSchema;
      }
  );

/**
 * Platform-neutral embedded client configuration for a prebuilt runtime.
 *
 * @remarks
 * Browser clients use this form when a worker-backed runner owns the runtime
 * and storage lifecycle.
 *
 * @internal
 */
export interface EmbeddedRuntimeClientOptions {
  /** Optional cleanup hook invoked by {@link EmbeddedClient.close}. */
  close?: () => Promise<void> | void;
  /**
   * Synchronously available runner whose events are observed before {@link runner} resolves, so
   * boot-lifecycle runtime events flow to {@link EmbeddedClient.onRuntimeEvent} before ready.
   */
  eagerRunner?: Runner;
  /** Prebuilt runner used to execute Convex functions. */
  runner: Runner | Promise<Runner>;
  /** Mutable auth state shared with the remote driver. */
  authState?: EmbeddedAuthState;
  /** Hosted function transport owned by the shared client; replication remains worker-owned. */
  hosted?: ConvexEmbeddedRemoteOptions;
  /** Whether the prebuilt runtime owns a configured remote replication lifecycle. */
  remoteConfigured?: boolean;
}

/** A platform adapter whose expensive runtime acquisition is deferred to `client.open()`. @internal */
export interface DeferredEmbeddedClientOptions {
  authState?: EmbeddedAuthState;
  /** Hosted configuration recorded before opening; no network work starts until `open()`. */
  hosted?: ConvexEmbeddedRemoteOptions;
  start(setup?: LocalSetupAction): Promise<EmbeddedClientOptions | EmbeddedRuntimeClientOptions>;
}

interface ClientState {
  close: () => Promise<void> | void;
  remote?: RemoteSurface;
  /**
   * Whether a remote was configured and started for this client. The storage backend always
   * exposes a {@link RemoteSurface}, so presence of `remote` alone does not mean the client is
   * replicating. Only configured remote options start the push/pull loop.
   */
  remoteConfigured: boolean;
  runner: Runner;
  store?: StorageBackend;
}

/** Local and remote readiness reported by {@link EmbeddedClient.connectionState}. @public */
type EmbeddedLocalConnectionState = "idle" | "starting" | "ready" | "failed" | "closed";

export type EmbeddedConnectionState = {
  local: EmbeddedLocalConnectionState;
  localError?: string;
} & (
  | { remote: "disabled" | "starting" | "connected" | "ready" | "offline" | "closed" }
  | { remote: "error"; remoteError: string }
);

/** Embedded client activity captured for devtools. @internal */
export interface EmbeddedClientDebugOperation {
  args: unknown;
  durationMs?: number;
  error?: string;
  id: number;
  kind: EmbeddedOperationKind;
  name: string;
  result?: unknown;
  resultSize?: number;
  startedAt: number;
  status: "pending" | "success" | "error";
  timing?: RunMutationTiming;
}

/** Watched query state captured for devtools. @internal */
export interface EmbeddedClientDebugQuery {
  args: unknown;
  error?: string;
  hasValue: boolean;
  key: string;
  name: string;
  subscribers: number;
  value?: unknown;
}

/** Local upload state captured for devtools. @internal */
export interface EmbeddedClientDebugUpload {
  contentType?: string;
  durationMs?: number;
  error?: string;
  size: number;
  startedAt: number;
  status: "pending" | "success" | "error";
  storageId?: string;
  url: string;
}

/** Snapshot consumed by the optional devtools package entrypoint. @internal */
export interface EmbeddedClientDebugSnapshot {
  clientId: string;
  closed: boolean;
  operations: EmbeddedClientDebugOperation[];
  queries: EmbeddedClientDebugQuery[];
  uploads: EmbeddedClientDebugUpload[];
}

/**
 * State per watched query. `baseValue`/`baseError` come from the runtime and are published as the
 * current watched value/error.
 */
interface QueryState<T = unknown> {
  args: Record<string, unknown>;
  baseError: unknown;
  baseValue: T | undefined;
  callbacks: Set<() => void>;
  error: unknown;
  key: string;
  journal: QueryJournal | undefined;
  logs: string[] | undefined;
  name: string;
  ref: FunctionReference<"query"> | LocalQuery<"public", any, any>;
  stop: StopOnUpdate | undefined;
  value: T | undefined;
}

const REMOTE_REPLICATE_ERROR_DELAY_MS = 5_000;
const REMOTE_REPLICATE_ERROR_MAX_DELAY_MS = 60_000;

/**
 * Platform-neutral embedded Convex client.
 *
 * @remarks
 * Convex functions execute in JavaScript; storage is supplied by a platform
 * backend. Applications should use the platform-specific
 * `ConvexEmbeddedClient` exports instead of constructing this base class.
 *
 * @internal
 */
export class EmbeddedClient {
  private closed = false;
  private opened = false;
  private clientId = randomId("client");
  private closePromise: Promise<void> | undefined;
  private nextMutationId = 1;
  private readonly localRoutes = new Map<string, "replicated" | "local">();
  private readonly queries = new Map<string, QueryState>();
  private state!: Promise<ClientState>;
  private readonly start: (
    setup?: LocalSetupAction,
  ) => Promise<EmbeddedClientOptions | EmbeddedRuntimeClientOptions>;
  private openIdentity: string | undefined;
  private openSetup: LocalSetupAction | undefined;
  private readonly auth: EmbeddedAuthState;
  private readonly hosted: ConvexEmbeddedRemoteOptions | undefined;
  private hostedClient: ConvexClient | undefined;
  private authGeneration = 0;
  private acceptedAuthGeneration = -1;
  private identityReady: Promise<void> = Promise.resolve();
  private identityRefresh: { generation: number; promise: Promise<boolean> } | undefined;
  private localState: EmbeddedConnectionState["local"] = "idle";
  private remoteState: EmbeddedConnectionState["remote"] = "disabled";
  private remoteError: string | undefined;
  private remotePullError: string | undefined;
  private remoteStart: Promise<void> | undefined;
  private remoteIncarnation: string | undefined;
  private remoteGeneration = -1;
  private remoteSequence = -1;
  private localError: string | undefined;
  private nextDebugOperationId = 1;
  private nextSpanId = 1;
  private readonly eventListeners = new Set<EmbeddedInternalEventListener>();
  private readonly debugOperations: EmbeddedClientDebugOperation[] = [];
  private readonly debugUploads: EmbeddedClientDebugUpload[] = [];
  constructor(
    options: EmbeddedClientOptions | EmbeddedRuntimeClientOptions | DeferredEmbeddedClientOptions,
  ) {
    this.auth = options.authState ?? createEmbeddedAuthState();
    const hostedOptions =
      "start" in options ? options.hosted : "runner" in options ? options.hosted : options.remote;
    this.hosted = hostedOptions;
    this.start = "start" in options ? (setup) => options.start(setup) : async () => options;
    this.remoteState = "disabled";
    // A prebuilt runner is an internal handoff from a worker/lifecycle owner that has already
    // acquired its resources. Keep that test/adapter seam eager; all public platform clients use
    // the deferred `start` form and remain inert until `open()`.
    if ("runner" in options) {
      this.opened = true;
      this.localState = "starting";
      this.openSetup = undefined;
      this.openIdentity = "none";
      this.remoteState = options.remoteConfigured === true ? "starting" : "disabled";
      this.state = this.init(options);
      void this.state.then(
        () => {
          this.localState = "ready";
        },
        (error) => {
          this.localState = "failed";
          this.localError = errorMessage(error);
        },
      );
      void this.state.catch(() => undefined);
    }
  }

  /**
   * Opens storage and starts the local runtime. Construction is inert: no worker, native store,
   * scheduler, or remote connection is created before this call.
   */
  open(): Promise<void>;
  open<Setup extends LocalSetupAction>(setup: ValidLocalSetup<Setup>): Promise<void>;
  open(setup?: LocalSetupAction): Promise<void> {
    if (this.closed) return Promise.reject(new EmbeddedClosedError());
    if (this.opened) {
      const same =
        this.openIdentity === undefined
          ? this.openSetup === setup
          : this.openIdentity === setupIdentity(setup);
      if (!same) return Promise.reject(new EmbeddedOpenMismatchError());
      return this.state.then(() => undefined);
    }
    let identity: string;
    try {
      // Validate the semantic setup identity before a platform adapter can acquire a worker,
      // storage lease, or native handle. A rejected setup must leave this client unopened.
      identity = setupIdentity(setup);
      this.configureOpen(setup, identity);
    } catch (error) {
      return Promise.reject(error);
    }
    this.opened = true;
    this.localState = "starting";
    this.openSetup = setup;
    this.openIdentity = identity;
    this.remoteState = this.hosted === undefined ? "disabled" : "starting";
    this.state = Promise.resolve()
      .then(async () => {
        if (this.closed) throw new EmbeddedClosedError();
        return await this.start(setup);
      })
      .then((options) => this.init(options, setup));
    void this.state.then(
      () => {
        this.localState = "ready";
      },
      (error) => {
        this.localState = "failed";
        this.localError = errorMessage(error);
        if (this.remoteState === "starting") {
          this.remoteState = "error";
          this.remoteError = `Embedded runtime failed to start: ${errorMessage(error)}`;
        }
      },
    );
    void this.state.catch(() => undefined);
    return this.state.then(() => undefined);
  }

  /** Platform adapters may snapshot a validated setup before deferred resources are acquired. */
  protected configureOpen(_setup: LocalSetupAction | undefined, _identity: string): void {}

  /** Uses the normal Convex token fetcher for future hosted exchanges. */
  setAuth(fetchToken: AuthTokenFetcher, onChange?: (isAuthenticated: boolean) => void): void {
    this.ensureNotClosed();
    this.auth.fetchToken = fetchToken;
    this.auth.onChange = onChange;
    this.hostedClient?.setAuth(fetchToken);
    const generation = ++this.authGeneration;
    if (this.opened) void this.refreshIdentity(generation);
  }

  /** Immediately switches local execution to the unauthenticated partition. */
  clearAuth(): void {
    this.ensureNotClosed();
    this.auth.fetchToken = undefined;
    this.auth.identity = null;
    this.auth.onChange?.(false);
    this.auth.onChange = undefined;
    this.hostedClient?.setAuth(async () => null);
    const generation = ++this.authGeneration;
    if (this.opened) this.identityReady = this.clearIdentity(generation);
  }

  /** Returns the current local and remote readiness snapshot. */
  connectionState(): EmbeddedConnectionState {
    const localError = this.localState === "failed" ? this.localError : undefined;
    if (this.remoteState === "error") {
      return {
        local: this.localState,
        localError,
        remote: "error",
        remoteError: this.remoteError ?? "Remote replication failed.",
      };
    }
    return { local: this.localState, localError, remote: this.remoteState };
  }

  /**
   * Executes a Convex query against the embedded runtime.
   *
   * @typeParam Query - Convex query function reference type.
   * @param query - Convex query function reference.
   * @param args - Query arguments.
   * @returns The query return value.
   * @throws An error thrown by the query handler, argument validation, return
   * validation, storage setup, or a closed client.
   *
   * @example
   * ```ts
   * const todos = await client.query(api.todos.list, {});
   * ```
   */
  query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
  query<Query extends LocalQuery<"public", any, any>>(
    query: Query,
    ...args: LocalArgs<Query>
  ): LocalFunctionReturns<Query>;
  async query(
    query: FunctionReference<"query"> | LocalQuery<"public", any, any>,
    ...args: [Record<string, Value>?]
  ): Promise<unknown> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    const reference = toReference(query, runner.localConfigured);
    const normalized = toArgs(args[0]);
    // A one-shot `query()` returns to its caller only — it never feeds the reactive cache. The
    // watcher loop is the sole producer of `baseValue`/`baseError`, so a concurrent watched read
    // cannot tear against this result. Mirrors Convex's `client.query()`.
    return await this.recordOperation("query", getFunctionName(reference), normalized, async () => {
      const cachedPlacement = this.cachedLocalRoute(reference, "query");
      const route = cachedPlacement
        ? ({ execution: "local", placement: cachedPlacement } as const)
        : await this.resolveRoute(runner, reference, normalized, "query");
      if (route.execution === "hosted") {
        return this.runHosted("query", reference, route.args);
      }
      return runner.runQuery(reference, normalized, { auth: await this.currentAuth() });
    });
  }

  /**
   * Executes a Convex mutation against the embedded runtime.
   *
   * @typeParam Mutation - Convex mutation function reference type.
   * @param mutation - Convex mutation function reference.
   * @param argsAndOptions - Mutation arguments followed by optional mutation options.
   * @returns The mutation return value.
   * @throws An error thrown by the mutation handler, validation, storage commit, or a closed client.
   *
   * @example
   * ```ts
   * await client.mutation(api.todos.create, { text: "Write docs" });
   * ```
   */
  mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...argsAndOptions: ArgsAndOptions<
      Mutation,
      ConvexEmbeddedMutationOptions<FunctionArgs<Mutation>>
    >
  ): Promise<FunctionReturnType<Mutation>>;
  mutation<Mutation extends LocalMutation<"public", any, any>>(
    mutation: Mutation,
    ...argsAndOptions: LocalArgsAndOptions<
      Mutation,
      ConvexEmbeddedMutationOptions<LocalFunctionArgs<Mutation>>
    >
  ): LocalFunctionReturns<Mutation>;
  async mutation(
    mutation: FunctionReference<"mutation"> | LocalMutation<"public", any, any>,
    ...argsAndOptions: [
      Record<string, Value>?,
      ConvexEmbeddedMutationOptions<Record<string, Value>>?,
    ]
  ): Promise<unknown> {
    const timingOptions = argsAndOptions[1] as MutationOptions<Record<string, Value>> | undefined;
    const timingStartedAt = timingOptions?.onTiming ? getTimerTime() : 0;
    let timingPhaseStartedAt = timingStartedAt;
    const clientTiming: EmbeddedClientMutationTiming | undefined = timingOptions?.onTiming
      ? {
          authMs: 0,
          idMs: 0,
          normalizeMs: 0,
          operationMs: 0,
          runnerMs: 0,
          stateMs: 0,
          totalMs: 0,
        }
      : undefined;
    this.ensureOpen();
    const { runner } = await this.state;
    if (clientTiming) {
      clientTiming.stateMs = getTimerTime() - timingPhaseStartedAt;
      timingPhaseStartedAt = getTimerTime();
    }
    this.ensureOpen();
    const reference = toReference(mutation, runner.localConfigured);
    const [args] = argsAndOptions;
    const normalized = toArgs(args);
    if (clientTiming) {
      clientTiming.normalizeMs = getTimerTime() - timingPhaseStartedAt;
      timingPhaseStartedAt = getTimerTime();
    }
    let runnerTiming: RunMutationTiming | undefined;
    const result = await this.recordOperation(
      "mutation",
      getFunctionName(reference),
      normalized,
      async () => {
        const cachedPlacement = this.cachedLocalRoute(reference, "mutation");
        const route = cachedPlacement
          ? ({ execution: "local", placement: cachedPlacement } as const)
          : await this.resolveRoute(runner, reference, normalized, "mutation");
        if (route.execution === "hosted") {
          return this.runHosted("mutation", reference, route.args);
        }
        if (clientTiming) {
          clientTiming.operationMs += getTimerTime() - timingPhaseStartedAt;
          timingPhaseStartedAt = getTimerTime();
        }
        const auth = await this.currentAuth();
        if (clientTiming) {
          clientTiming.authMs += getTimerTime() - timingPhaseStartedAt;
          timingPhaseStartedAt = getTimerTime();
        }
        if (route.placement === "local") {
          const value = await runner.runMutation(reference, normalized, {
            auth,
            onTiming: (value) => {
              runnerTiming = value;
            },
          });
          if (clientTiming) {
            clientTiming.runnerMs += getTimerTime() - timingPhaseStartedAt;
            timingPhaseStartedAt = getTimerTime();
          }
          return value;
        }
        const mutationId = this.allocateMutationId();
        if (clientTiming) {
          clientTiming.idMs += getTimerTime() - timingPhaseStartedAt;
          timingPhaseStartedAt = getTimerTime();
        }
        const value = await runner.runMutation(reference, normalized, {
          auth,
          mutationIsFresh: true,
          mutationId,
          pushCall: {
            fn: getFunctionName(reference),
            rngSeed: randomId("rng"),
          },
          onTiming: (value) => {
            runnerTiming = value;
          },
        });
        if (clientTiming) {
          clientTiming.runnerMs += getTimerTime() - timingPhaseStartedAt;
          timingPhaseStartedAt = getTimerTime();
        }
        return value;
      },
      (operation) => {
        if (runnerTiming) operation.timing = runnerTiming;
      },
    );
    if (clientTiming) {
      clientTiming.totalMs = getTimerTime() - timingStartedAt;
      timingOptions?.onTiming?.(clientTiming);
    }
    return result;
  }

  /**
   * Executes a Convex action against the embedded runtime.
   *
   * @typeParam Action - Convex action function reference type.
   * @param action - Convex action function reference.
   * @param args - Action arguments.
   * @returns The action return value.
   * @throws An error thrown by the action handler, argument validation, return validation, or a
   * closed client.
   */
  async action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    const normalized = toArgs(args[0]);
    return (await this.recordOperation("action", getFunctionName(action), normalized, async () => {
      const route = await this.resolveRoute(runner, action, normalized, "action");
      if (route.execution !== "hosted") {
        throw new Error("Actions must resolve to hosted execution.");
      }
      return this.runHosted("action", action, route.args);
    })) as FunctionReturnType<Action>;
  }

  /**
   * Handles a local embedded upload URL returned by `ctx.storage.generateUploadUrl()`.
   *
   * @param url - Local upload URL.
   * @param blob - Blob body to store locally.
   * @returns The local `_storage` id.
   * @internal
   */
  protected async handleUploadUrl(url: string, blob: Blob): Promise<{ storageId: string }> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    const startedAt = getTimerTime();
    const startedTimerAt = getTimerTime();
    const upload: EmbeddedClientDebugUpload = {
      contentType: blob.type || undefined,
      size: blob.size,
      startedAt,
      status: "pending",
      url,
    };
    this.debugUploads.unshift(upload);
    this.trimDebug();
    try {
      const result = await this.recordOperation("upload", "storage.upload", { url }, () =>
        runner.handleUpload(url, blob),
      );
      upload.durationMs = getElapsedTime(startedTimerAt);
      upload.status = "success";
      upload.storageId = result.storageId;
      return result;
    } catch (error) {
      upload.durationMs = getElapsedTime(startedTimerAt);
      upload.error = errorMessage(error);
      upload.status = "error";
      throw error;
    }
  }

  /**
   * Subscribes to the public embedded observability event stream.
   *
   * @remarks
   * The listener receives the stable {@link EmbeddedEvent} union: runtime, operation, remote, data,
   * crdt, upload, schedule, and retention events. Richer internal detail is available to devtools
   * through the internal channel and is not part of this contract.
   *
   * @param listener - Callback invoked for each public observability event emitted by this client.
   * @returns A function that unsubscribes the listener.
   * @public
   */
  subscribeEvents(listener: EmbeddedPublicEventListener): () => void {
    return this.subscribeInternalEvents((event) => {
      const mapped = mapPublicEvent(event);
      if (mapped) listener(mapped);
    });
  }

  /**
   * Subscribes to the rich internal observability channel used by devtools and boot diagnostics.
   *
   * @remarks
   * Unlike {@link subscribeEvents}, this exposes benchmark timings, spans, and per-tick replication
   * detail. It is not a stable app contract; app code uses {@link subscribeEvents}.
   *
   * @param listener - Callback invoked for each internal event.
   * @returns A function that unsubscribes the listener.
   * @internal
   */
  subscribeInternalEvents(listener: EmbeddedInternalEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Observes boot-lifecycle transitions and runtime degradation signals.
   *
   * @remarks
   * A convenience view over {@link subscribeEvents} filtered to `runtime` events: store open,
   * remote attach, and ready phases, plus slow-open and OPFS acquire-contention degradations. An
   * app can render boot progress or a still-loading notice instead of a dead spinner. The channel
   * is inert when unused.
   *
   * @param listener - Callback invoked for each runtime lifecycle or degradation event.
   * @returns A function that unsubscribes the listener.
   * @public
   */
  onRuntimeEvent(listener: (event: EmbeddedRuntimeEvent) => void): () => void {
    return this.subscribeInternalEvents((event) => {
      if (event.type === "runtime") listener(event);
    });
  }

  /**
   * Creates a watched query handle.
   *
   * @remarks
   * The watch starts when a callback is registered with {@link Watch.onUpdate}.
   * Call {@link Watch.localQueryResult} from the callback to read the latest
   * result. Locally executable functions are watched against the embedded store;
   * server-only functions are watched against the configured Convex deployment.
   *
   * @typeParam Query - Convex query function reference type.
   * @param query - Convex query function reference.
   * @param argsAndOptions - Query arguments followed by optional watch options.
   * @returns A watch handle for reading local query state and registering update callbacks.
   * @throws A synchronous error if the client has already been closed.
   *
   * @example
   * ```ts
   * const watch = client.watchQuery(api.todos.list);
   * const stop = watch.onUpdate(() => {
   *   render(watch.localQueryResult() ?? []);
   * });
   * ```
   */
  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Watch<FunctionReturnType<Query>>;
  watchQuery<Query extends LocalQuery<"public", any, any>>(
    query: Query,
    ...args: LocalArgs<Query>
  ): Watch<Awaited<LocalFunctionReturns<Query>>>;
  watchQuery(
    query: FunctionReference<"query"> | LocalQuery<"public", any, any>,
    ...args: [Record<string, Value>?]
  ): Watch<unknown> {
    this.ensureOpen();
    const normalized = toArgs(args[0]);
    const key = queryKey(referenceKey(query), normalized);
    return {
      onUpdate: (callback) => this.listen(query, key, normalized, callback),
      localQueryResult: () => {
        const state = this.queries.get(key);
        if (state?.error) throw state.error;
        return state?.value;
      },
      localQueryLogs: () => this.queries.get(key)?.logs,
    };
  }

  /**
   * Closes the embedded store and stops active watched queries.
   *
   * @remarks
   * Closing is idempotent. After close begins, query and mutation calls reject
   * or throw because the client no longer accepts work.
   *
   * @returns A promise that settles after storage/runtime cleanup has run.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.localState = "closed";
    this.remoteState = this.remoteState === "disabled" ? "disabled" : "closed";
    this.remoteError = undefined;
    this.remotePullError = undefined;
    for (const state of this.queries.values()) {
      state.stop?.();
      state.stop = undefined;
      state.callbacks.clear();
    }
    this.queries.clear();
    this.closePromise = (
      this.opened
        ? this.state.then(async ({ close }) => {
            await Promise.all([close(), this.hostedClient?.close()]);
          })
        : Promise.resolve(this.hostedClient?.close()).then(() => undefined)
    ).catch(() => undefined);
    return this.closePromise;
  }

  /** @internal */
  protected __devtoolsSnapshot(): EmbeddedClientDebugSnapshot {
    return {
      clientId: this.clientId,
      closed: this.closed,
      operations: this.debugOperations.map((operation) => ({ ...operation })),
      queries: [...this.queries.values()].map((query) => ({
        args: toDebugValue(query.args),
        error: query.error === undefined ? undefined : errorMessage(query.error),
        hasValue: query.value !== undefined,
        key: query.key,
        name: query.name,
        subscribers: query.callbacks.size,
        value: query.value === undefined ? undefined : toDebugValue(query.value),
      })),
      uploads: this.debugUploads.map((upload) => ({ ...upload })),
    };
  }

  /** @internal */
  protected async __devtoolsRuntime(request: RunnerDevtoolsRequest): Promise<unknown> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    return runner.devtools(request);
  }

  /** @internal */
  protected async __devtoolsRunFunction(input: {
    args: Record<string, unknown>;
    kind: "query" | "mutation" | "action";
    path: string;
  }): Promise<unknown> {
    if (input.kind === "query") return this.query(input.path as never, input.args as never);
    if (input.kind === "mutation") return this.mutation(input.path as never, input.args as never);
    return this.action(input.path as never, input.args as never);
  }

  /** @internal */
  protected __devtoolsClearActivity(): void {
    this.debugOperations.length = 0;
  }

  /** @internal */
  protected async __pullRemoteOnce(): Promise<RemoteTick | undefined> {
    this.ensureOpen();
    const { remote, runner } = await this.state;
    this.ensureOpen();
    if (!remote?.pull) return undefined;
    const tick = await remote.pull(true);
    consumeRemoteTick(tick, runner, (event) => this.emitEvent(event));
    this.emitEvent(remoteTickEvent(tick));
    return tick;
  }

  private async init(
    options: EmbeddedClientOptions | EmbeddedRuntimeClientOptions,
    setup?: LocalSetupAction,
  ): Promise<ClientState> {
    if ("runner" in options) {
      const eagerUnsubscribe = options.eagerRunner?.subscribeEvents?.((event) =>
        this.emitEvent(event),
      );
      const runner = await options.runner;
      const unsubscribeEvents =
        eagerUnsubscribe ?? runner.subscribeEvents?.((event) => this.emitEvent(event));
      if (this.closed) {
        unsubscribeEvents?.();
        await options.close?.();
        throw new EmbeddedClosedError();
      }
      await this.readCachedIdentity(runner, this.authGeneration);
      // Worker-backed runtimes execute candidate setup as part of their Init protocol before this
      // runner resolves. Never execute it again against the now-published generation.
      if (options.remoteConfigured === true) {
        void this.refreshRunnerIdentity(runner, this.authGeneration);
      }
      return {
        close: async () => {
          unsubscribeEvents?.();
          await options.close?.();
        },
        remote: undefined,
        remoteConfigured: options.remoteConfigured === true,
        runner,
      };
    }

    const baseSchema = options.storeSchema ?? toRuntimeStoreSchema(options.schema);
    // This is persisted as a store-contract setup identity, not derived from executable source.
    // It makes a changed imported setup graph create a new candidate without changing hosted schema
    // identity or hashing `Function#toString()`.
    const schema =
      setup === undefined ? baseSchema : { ...baseSchema, setupHash: this.openIdentity ?? "" };
    const moduleGraphHash = options.moduleGraphHash ?? "direct-runtime";
    validateLoadedSetupIdentity(setup, options.localSetupIdentities, options.moduleGraphHash);
    const store = await options.store;
    let runner: Runner;
    try {
      const localSchemas =
        setup === undefined
          ? []
          : [
              ...(options.localSchemas ?? []),
              ...[localFunctionSchema(setup)].filter(
                (value): value is ConvexEmbeddedSchema => value !== undefined,
              ),
            ];
      const opened = await openCandidate<Runner>(store, {
        createRunner: (runnerSchema, remote) =>
          createRunner(options.modules, store, runnerSchema, {
            emit: (event) => this.emitEvent(event),
            hasEventListeners: () => this.eventListeners.size > 0,
            localModules: options.localModules,
            manifest: options.manifest,
            moduleGraphHash,
            remote,
          }),
        localReady: async (candidateRunner) => {
          await candidateRunner.localReady;
        },
        remote: options.remote !== undefined,
        runnerSchema: schema,
        setup:
          setup === undefined
            ? undefined
            : {
                localSchemas,
                run: async (setupRunner) => {
                  await setupRunner.runAction(
                    toReference(setup, setupRunner.localConfigured),
                    {},
                    { allowInternal: true, auth: null },
                  );
                },
              },
        targetSchema: schema,
      });
      runner = opened.runner;
    } catch (error) {
      await store.close();
      throw error;
    }
    let stopRemoteLoop: (() => void) | undefined;
    let remoteRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let remoteStartAttempt = 0;
    try {
      const generation = this.authGeneration;
      await this.readCachedIdentity(runner, generation);
      if (options.remote) {
        if (!store.remote) {
          throw new Error(
            "Native remote replication requires a storage backend with remote support.",
          );
        }
        const remote = store.remote;
        const startRemote = async () => {
          await remote.start({
            ...toRemoteStartOptions(options.remote!, this.auth, this.clientId, {
              schemaHash: schema.hash ?? "local",
              moduleGraphHash,
              protocolVersion: EMBEDDED_PROTOCOL_VERSION,
            }),
            notify: (tick) => {
              consumeRemoteTick(tick, runner, (event) => this.emitEvent(event));
              this.emitEvent(remoteTickEvent(tick));
            },
          });
          await this.refreshRunnerIdentity(runner, this.authGeneration);
          await runner.remote?.scope.write();
        };
        const launchRemoteLoop = () => {
          stopRemoteLoop = startRemoteLoop(
            remote,
            runner,
            async () => {
              if (!(await this.refreshIdentity(this.authGeneration))) {
                throw new Error("Remote replication is waiting for identity negotiation.");
              }
            },
            (event) => this.emitEvent(event),
            async () => {
              await remote.close().catch(() => undefined);
              this.clientId = randomId("client");
              await startRemote();
            },
          );
        };
        const attemptRemoteStart = async (): Promise<void> => {
          if (this.closed) return;
          try {
            await startRemote();
          } catch (error) {
            if (this.closed) return;
            this.remoteState = "error";
            this.remoteError = `Embedded remote replication failed to start: ${errorMessage(error)}`;
            await remote.close().catch(() => undefined);
            if (this.closed || remoteRetryTimer !== undefined) return;
            remoteStartAttempt += 1;
            const delay = Math.min(
              REMOTE_REPLICATE_ERROR_MAX_DELAY_MS,
              REMOTE_REPLICATE_ERROR_DELAY_MS * 2 ** (remoteStartAttempt - 1),
            );
            remoteRetryTimer = setTimeout(() => {
              remoteRetryTimer = undefined;
              if (this.closed) return;
              this.remoteState = "starting";
              this.remoteError = undefined;
              this.remoteStart = attemptRemoteStart();
              void this.remoteStart.catch(() => undefined);
            }, delay);
            return;
          }
          if (this.closed) return;
          remoteStartAttempt = 0;
          launchRemoteLoop();
        };
        this.remoteStart = attemptRemoteStart();
        void this.remoteStart.catch(() => undefined);
      }
    } catch (error) {
      await store.remote?.close().catch(() => undefined);
      await store.close();
      throw error;
    }
    return {
      close: async () => {
        if (remoteRetryTimer !== undefined) {
          clearTimeout(remoteRetryTimer);
          remoteRetryTimer = undefined;
        }
        stopRemoteLoop?.();
        await store.remote?.close().catch(() => undefined);
        await this.remoteStart?.catch(() => undefined);
        await store.close();
      },
      remote: store.remote,
      remoteConfigured: options.remote !== undefined,
      runner,
      store,
    };
  }

  private listen(
    query: FunctionReference<"query"> | LocalQuery<"public", any, any>,
    key: string,
    args: Record<string, unknown>,
    callback: () => void,
  ): () => void {
    this.ensureOpen();
    const state = this.queryState(key, referenceKey(query), args, query);
    state.callbacks.add(callback);
    void this.startQuery(query, args, state);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      state.callbacks.delete(callback);
      // Only tear down if this exact state still occupies the key. If it was already evicted and a
      // fresh state took its place (same key, new subscription), deleting here would orphan the
      // newcomer.
      if (this.queries.get(state.key) !== state) return;
      if (!state.callbacks.size) {
        state.stop?.();
        state.stop = undefined;
        this.queries.delete(state.key);
      }
    };
  }

  private async startQuery(
    query: FunctionReference<"query"> | LocalQuery<"public", any, any>,
    args: Record<string, unknown>,
    state: QueryState,
  ): Promise<void> {
    try {
      if (state.stop) return;
      const { runner } = await this.state;
      if (this.closed || state.stop || !state.callbacks.size) return;
      // A device-only function only carries its name once the runtime has imported the module it
      // came from, so the watch resolves it here rather than in the synchronous `watchQuery` call.
      const reference = toReference(query, runner.localConfigured);
      state.name = getFunctionName(reference);
      const cachedPlacement = this.cachedLocalRoute(reference, "query");
      const route = cachedPlacement
        ? ({ execution: "local", placement: cachedPlacement } as const)
        : await this.resolveRoute(runner, reference, args, "query");
      if (
        this.closed ||
        state.stop ||
        !state.callbacks.size ||
        this.queries.get(state.key) !== state
      ) {
        return;
      }
      if (route.execution === "hosted") {
        const hosted = this.hosted;
        if (!hosted) throw new EmbeddedOfflineError();
        const client = this.hostedClient ?? this.createHostedClient(hosted);
        state.stop = client.onUpdate(
          reference,
          route.args as FunctionArgs<FunctionReference<"query">>,
          (value) => {
            if (this.closed || this.queries.get(state.key) !== state) return;
            state.baseError = undefined;
            state.baseValue = value;
            state.logs = undefined;
            this.publish(state);
          },
          (error) => {
            if (this.closed || this.queries.get(state.key) !== state) return;
            state.baseError = error;
            state.logs = undefined;
            this.publish(state);
          },
        );
        return;
      }
      state.stop = runner.onUpdate(
        reference,
        args,
        (value) => {
          state.baseError = undefined;
          state.baseValue = value;
          this.publish(state);
        },
        (error) => {
          state.baseError = error;
          this.publish(state);
        },
        { auth: await this.currentAuth() },
      );
    } catch (error) {
      state.baseError = error;
      this.publish(state);
    }
  }

  private queryState(
    key: string,
    name: string,
    args: Record<string, unknown>,
    ref: FunctionReference<"query"> | LocalQuery<"public", any, any>,
  ): QueryState {
    let state = this.queries.get(key);
    if (!state) {
      state = {
        args,
        baseError: undefined,
        baseValue: undefined,
        callbacks: new Set(),
        error: undefined,
        key,
        journal: undefined,
        logs: undefined,
        name,
        ref,
        stop: undefined,
        value: undefined,
      };
      this.queries.set(key, state);
    }
    return state;
  }

  private emit(state: QueryState): void {
    for (const callback of Array.from(state.callbacks)) {
      try {
        callback();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private publish(state: QueryState): void {
    state.value = state.baseValue;
    state.error = state.baseError;
    this.emit(state);
  }

  private async recordOperation<T>(
    kind: EmbeddedOperationKind,
    name: string,
    args: unknown,
    run: () => Promise<T>,
    finish?: (operation: EmbeddedClientDebugOperation) => void,
  ): Promise<T> {
    if (this.eventListeners.size === 0) return run();
    const startedAt = getTimerTime();
    const id = this.nextDebugOperationId;
    const spanId = `client:${this.nextSpanId}`;
    this.nextSpanId += 1;
    const operation: EmbeddedClientDebugOperation = {
      args: toDebugValue(args),
      id,
      kind,
      name,
      startedAt,
      status: "pending",
    };
    this.nextDebugOperationId += 1;
    this.debugOperations.unshift(operation);
    this.trimDebug();
    this.emitEvent(operationEvent(operation, "start", startedAt));
    this.emitEvent(spanEvent(spanId, `client.${kind}`, "start", startedAt));
    const startedTimerAt = getTimerTime();
    try {
      const result = await run();
      finish?.(operation);
      const endedAt = getTimerTime();
      operation.durationMs = getElapsedTime(startedTimerAt);
      operation.result = toDebugValue(result);
      operation.resultSize = debugSize(operation.result);
      operation.status = "success";
      this.emitEvent(operationEvent(operation, "finish", endedAt));
      this.emitEvent(spanEvent(spanId, `client.${kind}`, "finish", endedAt, operation.durationMs));
      return result;
    } catch (error) {
      const endedAt = getTimerTime();
      operation.durationMs = getElapsedTime(startedTimerAt);
      operation.error = errorMessage(error);
      operation.status = "error";
      this.emitEvent(operationEvent(operation, "finish", endedAt));
      this.emitEvent(
        spanEvent(
          spanId,
          `client.${kind}`,
          "finish",
          endedAt,
          operation.durationMs,
          operation.error,
        ),
      );
      throw error;
    }
  }

  private trimDebug(): void {
    this.debugOperations.length = Math.min(this.debugOperations.length, 100);
    this.debugUploads.length = Math.min(this.debugUploads.length, 50);
  }

  private emitEvent(event: EmbeddedInternalEvent): void {
    if (event.type === "remote") {
      if (event.incarnation !== undefined && event.incarnation !== this.remoteIncarnation) {
        this.remoteIncarnation = event.incarnation;
        this.remoteGeneration = -1;
        this.remoteSequence = -1;
      }
      if (event.generation !== undefined) {
        if (event.generation < this.remoteGeneration) return;
        if (event.generation > this.remoteGeneration) {
          this.remoteGeneration = event.generation;
          this.remoteSequence = -1;
        }
        if (event.sequence !== undefined) {
          if (event.sequence <= this.remoteSequence) return;
          this.remoteSequence = event.sequence;
        }
      }
      if ((event.tick?.pullSnapshots ?? 0) > 0) this.remotePullError = undefined;
      if ((event.tick?.pullDiagnostics ?? 0) > 0) {
        this.remotePullError = event.error ?? event.tick?.pullError ?? REMOTE_PULL_DIAGNOSTIC_ERROR;
      }
      if (event.status === "error") {
        this.remoteState = "error";
        this.remoteError =
          event.error?.includes("remote command channel closed") && this.remotePullError
            ? this.remotePullError
            : event.error;
      } else if (this.remotePullError !== undefined && event.status !== "closed") {
        this.remoteState = "error";
        this.remoteError = this.remotePullError;
      } else if (event.status === "offline") {
        this.remoteState = "offline";
        this.remoteError = undefined;
      } else if (event.status === "closed") {
        this.remoteState = "closed";
        this.remoteError = undefined;
      } else if (event.status === "starting") {
        this.remoteState = "starting";
        this.remoteError = undefined;
      } else if (event.status === "started") {
        if (
          this.remoteState !== "offline" &&
          this.remoteState !== "connected" &&
          this.remoteState !== "ready"
        ) {
          this.remoteState = "starting";
        }
        this.remoteError = undefined;
      } else if (event.status === "connected") {
        if (remotePendingIsEmpty(event.tick?.pending)) {
          this.remoteState = "ready";
        } else if (event.tick?.pending !== undefined || this.remoteState !== "ready") {
          this.remoteState = "connected";
        }
        this.remoteError = undefined;
      } else if (event.status === "tick") {
        if (this.remoteState !== "offline") {
          if (remotePendingIsEmpty(event.tick?.pending)) {
            this.remoteState = "ready";
          } else if (event.tick?.pending !== undefined || this.remoteState !== "ready") {
            this.remoteState = "connected";
          }
        }
        this.remoteError = undefined;
      } else if (event.status === "idle") {
        this.remoteState = remotePendingIsEmpty(event.tick?.pending) ? "ready" : "connected";
        this.remoteError = undefined;
      }
    }
    for (const listener of Array.from(this.eventListeners)) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private ensureOpen(): void {
    this.ensureNotClosed();
    if (!this.opened) throw new EmbeddedNotOpenError();
  }

  private ensureNotClosed(): void {
    if (this.closed) throw new EmbeddedClosedError();
  }

  private async resolveRoute(
    runner: Runner,
    ref: FunctionReference<"query" | "mutation" | "action">,
    args: Record<string, unknown>,
    kind: "query" | "mutation" | "action",
  ): Promise<Exclude<RunnerRoute, { execution: "blocked" }>> {
    const deadline = getTimerTime() + (this.hosted?.operationTimeoutMs ?? 30_000);
    while (true) {
      let wake: (() => void) | undefined;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = runner.subscribeEvents?.((event) => {
        if (event.type === "data" && event.source === "remote") wake?.();
      });
      const route = await runner.route(ref, args, kind).catch((error) => {
        unsubscribe?.();
        throw error;
      });
      if (route.execution !== "blocked") {
        unsubscribe?.();
        if (route.execution === "local") {
          this.localRoutes.set(this.routeKey(ref, kind), route.placement);
        }
        return route;
      }
      if (!this.hosted) {
        unsubscribe?.();
        throw new EmbeddedOfflineError();
      }
      const remaining = deadline - getTimerTime();
      if (remaining <= 0) {
        unsubscribe?.();
        throw new EmbeddedHostedDependencyError();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        changed,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new EmbeddedHostedDependencyError()), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
      });
    }
  }

  private cachedLocalRoute(
    ref: FunctionReference<"query" | "mutation" | "action">,
    kind: "query" | "mutation" | "action",
  ): "replicated" | "local" | undefined {
    return this.localRoutes.get(this.routeKey(ref, kind));
  }

  private routeKey(
    ref: FunctionReference<"query" | "mutation" | "action">,
    kind: "query" | "mutation" | "action",
  ): string {
    return `${kind}:${getFunctionName(ref)}`;
  }

  private async runHosted(
    kind: "query" | "mutation" | "action",
    ref: FunctionReference<"query" | "mutation" | "action">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const hosted = this.hosted;
    if (!hosted) throw new EmbeddedOfflineError();
    const client = this.hostedClient ?? this.createHostedClient(hosted);
    try {
      const operation =
        kind === "query"
          ? client.query(ref as never, args as never)
          : kind === "mutation"
            ? client.mutation(ref as never, args as never)
            : client.action(ref as never, args as never);
      return await hostedOperation(operation, hosted.operationTimeoutMs);
    } catch (error) {
      if (kind === "query" || !(error instanceof HostedTransportError)) throw error;
      throw new EmbeddedHostedWriteIndeterminateError(
        `Hosted ${kind} did not return a definitive result: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private createHostedClient(options: ConvexEmbeddedRemoteOptions): ConvexClient {
    const client = new ConvexClient(options.url, { logger: false });
    if (this.auth.fetchToken) client.setAuth(this.auth.fetchToken);
    this.hostedClient = client;
    return client;
  }

  private allocateMutationId(): string {
    const id = `${this.clientId}:${this.nextMutationId}`;
    this.nextMutationId += 1;
    return id;
  }

  private refreshIdentity(generation: number): Promise<boolean> {
    if (this.acceptedAuthGeneration === generation) return Promise.resolve(true);
    if (this.identityRefresh?.generation === generation) return this.identityRefresh.promise;
    const promise = this.refreshIdentityOnce(generation).finally(() => {
      if (this.identityRefresh?.promise === promise) this.identityRefresh = undefined;
    });
    this.identityRefresh = { generation, promise };
    return promise;
  }

  private async refreshIdentityOnce(generation: number): Promise<boolean> {
    const { runner } = await this.state;
    return await this.refreshRunnerIdentity(runner, generation);
  }

  private async refreshRunnerIdentity(runner: Runner, generation: number): Promise<boolean> {
    try {
      if (generation !== this.authGeneration) return false;
      const accepted = await runner.remote?.identity.read();
      if (!accepted) return false;
      if (generation !== this.authGeneration) return false;
      this.auth.identity = accepted.identity;
      this.acceptedAuthGeneration = generation;
      this.auth.onChange?.(accepted.identity !== null);
      return true;
    } catch {
      if (generation !== this.authGeneration) return false;
      this.auth.onChange?.(this.auth.identity !== null);
      return false;
    }
  }

  private async clearIdentity(generation: number): Promise<void> {
    const { runner } = await this.state;
    if (generation !== this.authGeneration) return;
    await runner.identity.write(EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY);
  }

  private async currentAuth(): Promise<UserIdentity | null> {
    await this.identityReady;
    return this.auth.identity;
  }

  private async readCachedIdentity(runner: Runner, generation: number): Promise<void> {
    const accepted = await runner.identity.read();
    if (!accepted || generation !== this.authGeneration) return;
    this.auth.identity = accepted.identity;
    this.auth.onChange?.(accepted.identity !== null);
  }
}

/** @internal */
export function createEmbeddedAuthState(): EmbeddedAuthState {
  return { identity: null };
}

function toRemoteStartOptions(
  options: ConvexEmbeddedRemoteOptions,
  auth: EmbeddedAuthState,
  clientId: string,
  runtime: { schemaHash: string; moduleGraphHash: string; protocolVersion: number },
): RemoteStartOptions {
  return {
    auth: async (request) =>
      (await auth.fetchToken?.({ forceRefreshToken: request?.forceRefreshToken ?? false })) ?? null,
    clientId,
    moduleGraphHash: runtime.moduleGraphHash,
    operationTimeoutMs: options.operationTimeoutMs,
    protocolVersion: runtime.protocolVersion,
    receiveTimeoutMs: options.receiveTimeoutMs,
    schemaHash: runtime.schemaHash,
    url: options.url,
  };
}

async function hostedOperation<T>(operation: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HostedTransportError(new Error("Hosted operation timed out."))),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class HostedTransportError extends Error {
  constructor(cause: unknown) {
    super(`Hosted transport failed: ${errorMessage(cause)}`, { cause });
    this.name = "ConvexEmbeddedHostedTransportError";
  }
}

export function startRemoteLoop(
  remote: RemoteSurface,
  runner: Runner,
  ensureIdentity: () => Promise<void>,
  emit: (event: EmbeddedInternalEvent) => void,
  rotateRetiredClient?: () => Promise<void>,
): () => void {
  if (!remote.pull) return () => undefined;
  let stopped = false;
  let running = false;
  let wakePending = false;
  let nextAllowedRunAt = 0;
  const rotationBreaker = new RotationBreaker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let microtaskPending = false;
  let attempt = 0;
  let consecutiveErrors = 0;
  let pullDiagnostic: string | undefined;
  const schedule = (delay: number) => {
    if (stopped) return;
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
    if (stopped) return;
    if (running) {
      wakePending = true;
      return;
    }
    schedule(Math.max(0, nextAllowedRunAt - getTimerTime()));
  };
  const scope = remote.scope;
  const scopeWrite = scope?.write.bind(scope);
  let scheduledScopeWrite:
    | ((next: Parameters<NonNullable<typeof scopeWrite>>[0]) => Promise<void>)
    | undefined;
  if (scope && scopeWrite) {
    scheduledScopeWrite = async (next) => {
      await scopeWrite(next);
      wake();
    };
    scope.write = scheduledScopeWrite;
  }
  const unsubscribeEvents = runner.subscribeEvents?.((event) => {
    if (event.type === "data" && event.source === "local") wake();
  });
  const unsubscribeRemoteWake = runner.remote?.wake?.subscribe(wake);
  const run = () => {
    if (stopped || running || !remote.pull) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    wakePending = false;
    attempt += 1;
    let nextDelay: number | undefined;
    void ensureIdentity()
      .then(() => remote.pull!(true))
      .then((tick) => {
        nextAllowedRunAt = 0;
        consecutiveErrors = 0;
        if (tick.pullSnapshots > 0) pullDiagnostic = undefined;
        if (tick.pullDiagnostics > 0) {
          pullDiagnostic = tick.pullError ?? REMOTE_PULL_DIAGNOSTIC_ERROR;
        }
        if (!stopped) consumeRemoteTick(tick, runner, emit);
        // The native actor owns websocket ingress after this bounded wake turn. JavaScript enters
        // it again only for new local durable work or a changed authored-query scope.
        const delay = wakePending ? 0 : undefined;
        if (pullDiagnostic) {
          emit({
            at: getTimerTime(),
            attempt,
            error: pullDiagnostic,
            ...(delay === undefined ? {} : { nextRunAt: getTimerTime() + delay }),
            status: "error",
            tick: toRemoteEventTick(tick),
            type: "remote",
          });
          nextDelay = delay;
          return;
        }
        if (tick.connected === false) {
          emit({
            at: getTimerTime(),
            attempt,
            status: "offline",
            tick: toRemoteEventTick(tick),
            type: "remote",
          });
          nextDelay = delay;
          return;
        }
        if (tick.connected === true) {
          emit({
            at: getTimerTime(),
            attempt,
            status: remotePendingIsEmpty(tick.pending) ? "idle" : "connected",
            tick: toRemoteEventTick(tick),
            type: "remote",
          });
          nextDelay = delay;
          return;
        }
        emit({
          at: getTimerTime(),
          attempt,
          ...(delay === undefined ? {} : { nextRunAt: getTimerTime() + delay }),
          status: remotePendingIsEmpty(tick.pending) ? "idle" : "tick",
          tick: toRemoteEventTick(tick),
          type: "remote",
        });
        nextDelay = delay;
      })
      .catch(async (error: unknown) => {
        let failure = error;
        if (rotateRetiredClient && errorMessage(error).startsWith(REMOTE_CLIENT_RETIRED_PREFIX)) {
          const retired = errorMessage(new EmbeddedClientRetiredError());
          if (rotationBreaker.record(getTimerTime())) {
            stopped = true;
            emit({ at: getTimerTime(), attempt, error: retired, status: "error", type: "remote" });
            return;
          }
          emit({ at: getTimerTime(), attempt, error: retired, status: "error", type: "remote" });
          try {
            await rotateRetiredClient();
            nextAllowedRunAt = 0;
            consecutiveErrors = 0;
            nextDelay = 0;
            return;
          } catch (rotationError) {
            failure = rotationError;
          }
        }
        consecutiveErrors += 1;
        const delay = Math.min(
          REMOTE_REPLICATE_ERROR_DELAY_MS * 2 ** (consecutiveErrors - 1),
          REMOTE_REPLICATE_ERROR_MAX_DELAY_MS,
        );
        nextAllowedRunAt = getTimerTime() + delay;
        emit({
          at: getTimerTime(),
          attempt,
          error: errorMessage(failure),
          nextRunAt: getTimerTime() + delay,
          status: "error",
          type: "remote",
        });
        nextDelay = delay;
      })
      .finally(() => {
        running = false;
        if (wakePending) {
          schedule(Math.max(0, nextAllowedRunAt - getTimerTime()));
        } else if (nextDelay !== undefined) {
          schedule(nextDelay);
        }
      });
  };
  emit({ at: getTimerTime(), attempt, status: "started", type: "remote" });
  queueMicrotask(run);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (scope && scopeWrite && scope.write === scheduledScopeWrite) scope.write = scopeWrite;
    unsubscribeEvents?.();
    unsubscribeRemoteWake?.();
    emit({ at: getTimerTime(), attempt, status: "closed", type: "remote" });
  };
}

/** Project a native tick into the observability event shape. */
function toRemoteEventTick(tick: RemoteTick): NonNullable<EmbeddedRemoteEvent["tick"]> {
  return { ...tick, retainedRevisions: tick.retainedRevisions.length };
}

/** Report progress completed autonomously by the native remote actor. */
function remoteTickEvent(tick: RemoteTick): EmbeddedRemoteEvent {
  if (tick.pullDiagnostics > 0) {
    return {
      at: getTimerTime(),
      attempt: 0,
      error: tick.pullError ?? REMOTE_PULL_DIAGNOSTIC_ERROR,
      status: "error",
      tick: toRemoteEventTick(tick),
      type: "remote",
    };
  }
  if (tick.connected === false) {
    return {
      at: getTimerTime(),
      attempt: 0,
      status: "offline",
      tick: toRemoteEventTick(tick),
      type: "remote",
    };
  }
  if (tick.connected === true) {
    return {
      at: getTimerTime(),
      attempt: 0,
      status: remotePendingIsEmpty(tick.pending) ? "idle" : "connected",
      tick: toRemoteEventTick(tick),
      type: "remote",
    };
  }
  return {
    at: getTimerTime(),
    attempt: 0,
    status: remotePendingIsEmpty(tick.pending) ? "idle" : "tick",
    tick: toRemoteEventTick(tick),
    type: "remote",
  };
}

function queryKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, args: convexToJson(args as Value) });
}

function toArgs(args: unknown): Record<string, unknown> {
  const normalized = normalizeObject((args ?? {}) as Record<string, unknown>);
  freezeNormalizedTree(normalized);
  return normalized;
}

/**
 * The identity a watched query is tracked under. A stamped device-only registration keys on its
 * namespaced name, so separate copies of one registration share a single subscription. A copy the
 * runtime has not named yet keys on the value itself and stays stable across that transition; the
 * name still decides dispatch once {@link toReference} can read it.
 */
function referenceKey(ref: unknown): string {
  if (!isLocalFunction(ref)) return getFunctionName(ref as FunctionReference<any>);
  const name = localReferenceName(ref);
  if (name !== undefined) return name;
  let key = localWatchKeys.get(ref as object);
  if (key === undefined) {
    nextLocalWatchKey += 1;
    key = `local#${nextLocalWatchKey}`;
    localWatchKeys.set(ref as object, key);
  }
  return key;
}

const localWatchKeys = new WeakMap<object, string>();
let nextLocalWatchKey = 0;

/**
 * Dispatches a device-only function by the namespaced name it was stamped with. A page-bundle copy
 * carries that name from the bundler; a single-graph app holds the registration the runtime itself
 * stamped, so both reach the runtime identically. Convex references pass through untouched.
 */
function toReference(ref: unknown, localConfigured: boolean): FunctionReference<any> {
  if (!isLocalFunction(ref)) return ref as FunctionReference<any>;
  const name = localReferenceName(ref);
  if (name === undefined) {
    throw new Error(
      localConfigured
        ? "This device-only function is not registered under the configured local directories, or the embedded client has not finished starting."
        : LOCAL_UNCONFIGURED_ERROR,
    );
  }
  return name as unknown as FunctionReference<any>;
}

function setupIdentity(setup: LocalSetupAction | undefined): string {
  if (setup === undefined) return "none";
  if (!isLocalFunction(setup) || setup.kind !== "action" || setup.visibility !== "internal") {
    throw new TypeError("client.open() accepts only a stamped internal local action.");
  }
  const definition = setup as unknown as { args?: unknown; returns?: { kind?: unknown } };
  if (!isEmptySetupArgs(definition.args) || definition.returns?.kind !== "null") {
    throw new TypeError(
      "client.open() setup must declare empty arguments and a null return validator.",
    );
  }
  const reference = localReferenceName(setup);
  const graphHash = localGraphHash(setup);
  if (reference === undefined || graphHash === undefined) {
    throw new TypeError(
      "client.open() setup must be imported from a bundled local module; callbacks and unstamped references are not supported.",
    );
  }
  return `${reference}\u0000${graphHash}`;
}

/** Verify that setup is the stamped registration loaded by this platform runtime. @internal */
export function validateLoadedSetupIdentity(
  setup: LocalSetupAction | undefined,
  loaded: Readonly<Record<string, string>> | undefined,
  moduleGraphHash?: string,
): void {
  if (setup === undefined) return;
  const reference = localReferenceName(setup)!;
  const graphHash = localGraphHash(setup)!;
  if (loaded?.[reference] !== graphHash) {
    throw new Error(
      `Candidate setup ${reference} does not match the loaded local module graph. Import the setup action from this application build.`,
    );
  }
  if (moduleGraphHash !== undefined && graphHash !== moduleGraphHash) {
    throw new Error("Candidate setup graph identity does not match the native runtime.");
  }
}

function isEmptySetupArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
  );
}

function toDebugValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(convexToJson(value as Value)));
  } catch {
    return String(value);
  }
}

function debugSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function operationEvent(
  operation: EmbeddedClientDebugOperation,
  phase: EmbeddedOperationEvent["phase"],
  at: number,
): EmbeddedOperationEvent {
  return {
    args: operation.args,
    at,
    durationMs: operation.durationMs,
    error: operation.error,
    id: operation.id,
    kind: operation.kind,
    name: operation.name,
    phase,
    result: operation.result,
    resultSize: operation.resultSize,
    status: operation.status,
    timing: operation.timing,
    type: "operation",
  };
}

function spanEvent(
  id: string,
  name: string,
  phase: EmbeddedSpanEvent["phase"],
  at: number,
  durationMs?: number,
  error?: string,
): EmbeddedSpanEvent {
  return {
    at,
    durationMs,
    error,
    id,
    name,
    phase,
    type: "span",
  };
}
