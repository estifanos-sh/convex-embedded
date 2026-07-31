import type { UserIdentity } from "convex/server";
import type {
  Runner,
  RunnerDevtoolsRequest,
  RunnerRoute,
  RunMutationTiming,
  RunMutationOptions,
  RunOptions,
  StopOnUpdate,
} from "../runtime/runner";
import { functionName } from "../runtime/service";
import type { EmbeddedEvent, EmbeddedEventListener, EmbeddedRuntimeEvent } from "../events";
import type { ConvexEmbeddedRemoteOptions } from "../client";
import type { FunctionReference } from "../runtime/functions";
import { getTimerTime } from "../time";
import { randomId } from "../id/random";
import { EMBEDDED_PROTOCOL_VERSION } from "../protocol";
import type { RemoteIdentity } from "../storage/types";
import {
  deserializeError,
  serializeError,
  type EmbeddedWorker,
  type EmbeddedWorkerSource,
  type RuntimeIdentity,
  type WatchPatch,
  WorkerCommand,
  type WorkerCommandCode,
  WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";

export interface WorkerRunnerInit {
  acceptedResultTimeoutMs?: number;
  closeTimeoutMs?: number;
  debug?: boolean;
  identity?: RuntimeIdentity;
  initTimeoutMs?: number;
  onDispose?: () => void;
  remote?: ConvexEmbeddedRemoteOptions;
  remoteAuth?: (args: { forceRefreshToken: boolean }) => Promise<string | null> | string | null;
  requestTimeoutMs?: number;
  storagePath: string;
  storageOwner?: boolean | Promise<boolean>;
}

interface PendingRequest {
  accepted: boolean;
  onAccepted: ((this: void, mutationId: string) => void) | undefined;
  onTiming: ((this: void, timing: RunMutationTiming) => void) | undefined;
  requestStartedAt: number;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  timeoutMs: number | undefined;
  timeoutPolicy: "fatal" | "reject" | undefined;
  op: WorkerCommandCode;
}

interface WatchCallbacks {
  callback(value: unknown): void;
  lastValue: unknown;
  onError(error: unknown): void;
  started: boolean;
  stopped: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_ACCEPTED_RESULT_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

const INIT_PROGRESS_PHASES = new Set([
  "opfs-register",
  "remote-attach",
  "ready",
  "store-wal-write",
  "store-open",
  "store-setup",
  "wasm-load",
]);

const INIT_PROGRESS_DEGRADATIONS = new Set([
  "opfs-acquire-reclaimed",
  "opfs-acquire-retry",
  "temporary-storage",
  "slow-open",
]);

type WorkerEventHandler = (runner: WorkerRunner, message: Partial<WorkerResponse>) => void;

const workerEventHandlers = new Map<number, WorkerEventHandler>([
  [WorkerEvent.Result, (runner, message) => runner.handleResult(message)],
  [WorkerEvent.MutationAccepted, (runner, message) => runner.handleMutationAccepted(message)],
  [WorkerEvent.WatchUpdated, (runner, message) => runner.handleWatchUpdated(message)],
  [WorkerEvent.WatchPatched, (runner, message) => runner.handleWatchPatched(message)],
  [WorkerEvent.WatchFailed, (runner, message) => runner.handleWatchFailed(message)],
  [WorkerEvent.Debug, (runner, message) => runner.handleDebug(message)],
  [WorkerEvent.Event, (runner, message) => runner.handleEvent(message)],
  [WorkerEvent.AuthTokenRequest, (runner, message) => runner.handleAuthTokenRequest(message)],
  [WorkerEvent.Terminal, (runner, message) => runner.handleTerminal(message)],
]);

/**
 * Raised when a mutation was accepted by the browser runtime but the client lost transport before
 * observing the final result.
 *
 * @internal
 */
export class IndeterminateMutationError extends Error {
  constructor(message = "Mutation was accepted but its final result is indeterminate.") {
    super(message);
    this.name = "ConvexEmbeddedMutationIndeterminateError";
  }
}

/**
 * Main-thread proxy for a worker-owned embedded runtime.
 *
 * @internal
 */
export class WorkerRunner implements Runner {
  /** Reported by the worker once initialization settles; false until then. */
  localConfigured = false;
  private readonly clientId = randomId("client");
  private closed = false;
  private closedError = new Error("ConvexEmbeddedClient has already been closed.");
  private nextId = 1;
  private nextWatchId = 1;
  private readonly acceptedResultTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<unknown>;
  private readonly initTimeoutMs: number;
  private readonly onDispose: (() => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly eventListeners = new Set<EmbeddedEventListener>();
  private readonly remoteAuth:
    | ((args: { forceRefreshToken: boolean }) => Promise<string | null> | string | null)
    | undefined;
  private readonly watches = new Map<number, WatchCallbacks>();
  private readonly worker: EmbeddedWorker;
  constructor(source: EmbeddedWorkerSource, init?: WorkerRunnerInit) {
    this.worker = typeof source === "function" ? source() : source;
    debugHook()?.({
      detail: { clientId: this.clientId },
      phase: "main:worker:init",
      source: "worker",
    });
    this.acceptedResultTimeoutMs =
      init?.acceptedResultTimeoutMs ?? DEFAULT_ACCEPTED_RESULT_TIMEOUT_MS;
    this.closeTimeoutMs = init?.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.onDispose = init?.onDispose;
    this.requestTimeoutMs = init?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // Opening an existing store may include WAL recovery and pre-release format replacement.
    // Initialization can legitimately take longer than an ordinary operation, and killing the
    // worker at the generic request deadline only makes it repeat that work on every reload.
    this.initTimeoutMs = init?.initTimeoutMs ?? init?.requestTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.remoteAuth = init?.remoteAuth;
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerError);
    this.worker.start?.();
    this.ready = init
      ? Promise.resolve(init.storageOwner ?? false).then(async (storageOwner) => {
          const localConfigured = await this.request<boolean | undefined>(
            {
              clientId: this.clientId,
              debug: init.debug ?? debugHook() !== undefined,
              id: this.allocateId(),
              identity: init.identity,
              remote: init.remote
                ? {
                    authFetchToken: init.remoteAuth !== undefined,
                    clientId: this.clientId,
                    moduleGraphHash: init.identity?.moduleGraphHash ?? "local",
                    operationTimeoutMs: init.remote.operationTimeoutMs,
                    protocolVersion: init.identity?.protocolVersion ?? EMBEDDED_PROTOCOL_VERSION,
                    receiveTimeoutMs: init.remote.receiveTimeoutMs,
                    schemaHash: init.identity?.schemaHash ?? "local",
                    url: init.remote.url,
                  }
                : undefined,
              storagePath: init.storagePath,
              storageOwner,
              op: WorkerCommand.Init,
            },
            { timeoutMs: this.initTimeoutMs },
          );
          this.localConfigured = localConfigured === true;
        })
      : Promise.resolve();
    this.ready.catch(() => undefined);
  }

  initialized(): Promise<unknown> {
    return this.ready;
  }

  readonly identity = {
    read: async () => {
      await this.ready;
      return await this.request<{ identity: UserIdentity | null; identityKey: string } | undefined>(
        {
          clientId: this.clientId,
          id: this.allocateId(),
          op: WorkerCommand.IdentityRead,
        },
        { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
      );
    },
    write: async (identityKey: string) => {
      await this.ready;
      await this.request(
        {
          clientId: this.clientId,
          id: this.allocateId(),
          identityKey,
          op: WorkerCommand.IdentityWrite,
        },
        { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
      );
    },
  };

  readonly remote = {
    identity: {
      read: async () => {
        await this.ready;
        return await this.request<RemoteIdentity | undefined>(
          {
            clientId: this.clientId,
            id: this.allocateId(),
            op: WorkerCommand.RemoteIdentityRead,
          },
          { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
        );
      },
    },
    network: {
      write: async (online: boolean) => {
        await this.ready;
        await this.request(
          {
            clientId: this.clientId,
            id: this.allocateId(),
            online,
            op: WorkerCommand.RemoteNetworkWrite,
          },
          { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
        );
      },
    },
    scope: { write: async () => undefined },
  };

  /** Main-thread storage ownership hand-off. @internal */
  readonly storage = {
    owner: {
      write: async () => {
        await this.ready;
        await this.request(
          {
            clientId: this.clientId,
            id: this.allocateId(),
            op: WorkerCommand.StorageOwnerWrite,
          },
          { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
        );
      },
    },
  };

  async route(
    ref: FunctionReference,
    args: Record<string, unknown>,
    kind: "query" | "mutation" | "action",
  ): Promise<RunnerRoute> {
    await this.ready;
    return this.request<RunnerRoute>(
      {
        args,
        clientId: this.clientId,
        id: this.allocateId(),
        kind,
        name: functionName(ref),
        op: WorkerCommand.Route,
      },
      { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
    );
  }

  async runQuery(
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    options: RunOptions = {},
  ): Promise<unknown> {
    await this.ready;
    return this.request(
      {
        args,
        auth: options.auth,
        clientId: this.clientId,
        id: this.allocateId(),
        name: functionName(ref),
        op: WorkerCommand.Query,
      },
      { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
    );
  }

  async runMutation(
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    options: RunMutationOptions = {},
  ): Promise<unknown> {
    await this.ready;
    const id = this.allocateId();
    const generatedMutationId = options.mutationId === undefined;
    return this.request(
      {
        args,
        auth: options.auth,
        clientId: this.clientId,
        id,
        mutationIsFresh: generatedMutationId,
        mutationId: options.mutationId ?? `${this.clientId}:${id}`,
        name: functionName(ref),
        op: WorkerCommand.Mutation,
        rngSeed: randomId("rng"),
      },
      {
        onAccepted: options.onAccepted,
        onTiming: options.onTiming,
        timeoutMs: this.requestTimeoutMs,
      },
    );
  }

  async runAction(
    _ref: FunctionReference,
    _args: Record<string, unknown> = {},
    _options: RunOptions = {},
  ): Promise<unknown> {
    throw new Error("Actions are hosted-only and cannot execute in the embedded browser worker.");
  }

  async handleUpload(url: string, blob: Blob): Promise<{ storageId: string }> {
    await this.ready;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return this.request<{ storageId: string }>(
      {
        bytes,
        clientId: this.clientId,
        contentType: blob.type || undefined,
        id: this.allocateId(),
        op: WorkerCommand.Upload,
        url,
      },
      {
        timeoutMs: this.requestTimeoutMs,
        timeoutPolicy: "reject",
        transfer: [bytes.buffer],
      },
    );
  }

  async devtools(request: RunnerDevtoolsRequest): Promise<unknown> {
    await this.ready;
    return this.request(
      {
        clientId: this.clientId,
        id: this.allocateId(),
        op: WorkerCommand.Devtools,
        request,
      },
      { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
    );
  }

  subscribeEvents(listener: EmbeddedEventListener): StopOnUpdate {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  invalidate(): void {}

  rerunResults(): void {}

  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: (value: unknown) => void,
    onError: (error: unknown) => void = () => undefined,
    options: RunOptions = {},
  ): () => void {
    this.ensureOpen();
    const watchId = this.nextWatchId++;
    const watch: WatchCallbacks = {
      callback,
      lastValue: undefined,
      onError,
      started: false,
      stopped: false,
    };
    this.watches.set(watchId, watch);
    void this.ready
      .then(async () => {
        if (watch.stopped || this.closed) return;
        watch.started = true;
        await this.request(
          {
            args,
            auth: options.auth,
            clientId: this.clientId,
            id: this.allocateId(),
            name: functionName(ref),
            op: WorkerCommand.WatchStart,
            watchId,
          },
          {},
        );
        if (watch.stopped && !this.closed) {
          await this.request(
            {
              clientId: this.clientId,
              id: this.allocateId(),
              op: WorkerCommand.WatchStop,
              watchId,
            },
            { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
          ).catch(() => undefined);
        }
      })
      .catch((error) => {
        this.watches.delete(watchId);
        onError(error);
      });
    return () => {
      const current = this.watches.get(watchId);
      if (!current) return;
      current.stopped = true;
      this.watches.delete(watchId);
      if (this.closed || !current.started) return;
      void this.ready
        .then(() =>
          this.request(
            {
              clientId: this.clientId,
              id: this.allocateId(),
              op: WorkerCommand.WatchStop,
              watchId,
            },
            { timeoutMs: this.requestTimeoutMs, timeoutPolicy: "reject" },
          ),
        )
        .catch(() => undefined);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    let graceful = false;
    try {
      await this.request(
        {
          clientId: this.clientId,
          id: this.allocateId(),
          op: WorkerCommand.Close,
        },
        { allowClosed: true, timeoutMs: this.closeTimeoutMs },
      );
      graceful = true;
    } catch {
      // A lost close response means the worker may be wedged, so disposal below still terminates it.
    } finally {
      this.dispose(new Error("ConvexEmbeddedClient has already been closed."), {
        terminate: !graceful,
      });
    }
  }

  /** Immediately terminates the worker so page teardown cannot strand its storage ownership. */
  terminate(): void {
    this.dispose(new Error("ConvexEmbeddedClient worker was terminated during page teardown."));
  }

  private request<T = unknown>(
    message: WorkerRequest,
    options: {
      allowClosed?: boolean;
      onAccepted?(this: void, mutationId: string): void;
      onTiming?(this: void, timing: RunMutationTiming): void;
      timeoutMs?: number;
      /**
       * What a timeout means: `"fatal"` (default) treats a lost response as a wedged worker
       * and disposes the runner; `"reject"` fails only this request.
       */
      timeoutPolicy?: "fatal" | "reject";
      /** Buffers moved into the worker for one-way ownership transfers. */
      transfer?: object[];
    } = {},
  ): Promise<T> {
    if (!options.allowClosed) this.ensureOpen();
    return new Promise((resolve, reject) => {
      const resolveUnknown = (value: unknown) => resolve(value as T);
      const requestStartedAt = getTimerTime();
      const pending: PendingRequest = {
        accepted: false,
        onAccepted: options.onAccepted,
        onTiming: options.onTiming,
        requestStartedAt,
        reject,
        resolve: resolveUnknown,
        timer: undefined,
        timeoutMs: options.timeoutMs,
        timeoutPolicy: options.timeoutPolicy,
        op: message.op,
      };
      this.pending.set(message.id, pending);
      pending.timer = this.requestTimeout(message.id);
      try {
        // Query/mutation args remain caller-owned after the send. Upload bytes are the one safe
        // transfer point: the caller has already materialized a Blob body and no longer needs the
        // ArrayBuffer after the runtime owns it.
        this.worker.postMessage(message, options.transfer);
      } catch (error) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }

  private requestTimeout(id: number): ReturnType<typeof setTimeout> | undefined {
    const pending = this.pending.get(id);
    if (!pending || pending.timeoutMs === undefined) return undefined;
    return setTimeout(() => {
      const current = this.pending.get(id);
      if (!current) return;
      if (current.op === WorkerCommand.Mutation && current.accepted) {
        this.rejectAcceptedMutation(id);
        return;
      }
      const timeout = new Error(
        `ConvexEmbeddedClient worker request "${commandName(current.op)}" timed out after ${current.timeoutMs}ms${current.op === WorkerCommand.Init ? " without progress" : ""}.`,
      );
      if (current.timeoutPolicy === "reject") {
        this.pending.delete(id);
        current.reject(timeout);
        return;
      }
      this.dispose(new Error(`${timeout.message} Worker was terminated.`));
    }, pending.timeoutMs);
  }

  private writeInitProgress(): void {
    for (const [id, pending] of this.pending) {
      if (pending.op !== WorkerCommand.Init || pending.timeoutMs === undefined) continue;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = this.requestTimeout(id);
    }
  }

  private allocateId(): number {
    return this.nextId++;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw this.closedError;
    }
  }

  private dispose(error: Error, options: { terminate?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.closedError = error;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerError);
    if (options.terminate ?? true) {
      this.worker.close?.();
      this.worker.terminate?.();
    }
    try {
      this.onDispose?.();
    } catch {}
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(
        pending.op === WorkerCommand.Mutation && pending.accepted
          ? new IndeterminateMutationError()
          : error,
      );
    }
    this.pending.clear();
    for (const watch of this.watches.values()) {
      if (!watch.stopped) callWatchError(watch, error);
    }
    this.watches.clear();
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    const message = event.data as Partial<WorkerResponse>;
    const handler =
      typeof message.op === "number" ? workerEventHandlers.get(message.op) : undefined;
    if (handler) {
      handler(this, message);
      return;
    }

    const hook = debugHook();
    if (hook) {
      hook({ detail: message, phase: "worker:protocol:unknown-message", source: "worker" });
      console.warn("ConvexEmbeddedClient ignored unknown worker message.", message);
    }
  };

  handleResult(message: Partial<WorkerResponse>): void {
    if (message.op === WorkerEvent.Result && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (message.timing) pending.onTiming?.(message.timing);
      if (message.error) pending.reject(deserializeError(message.error));
      else pending.resolve(message.result);
    }
  }

  handleMutationAccepted(message: Partial<WorkerResponse>): void {
    if (
      message.op === WorkerEvent.MutationAccepted &&
      typeof message.id === "number" &&
      typeof message.mutationId === "string"
    ) {
      const id = message.id;
      const pending = this.pending.get(id);
      if (!pending || pending.op !== WorkerCommand.Mutation) return;
      // A cross-epoch ledger replay can re-deliver MutationAccepted for an already-accepted
      // mutation; the accepted-result timer is already armed and onAccepted already fired.
      if (pending.accepted) return;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.accepted = true;
      pending.onAccepted?.(message.mutationId);
      pending.timer = setTimeout(() => {
        this.rejectAcceptedMutation(id);
      }, this.acceptedResultTimeoutMs);
    }
  }

  handleWatchUpdated(message: Partial<WorkerResponse>): void {
    if (message.op === WorkerEvent.WatchUpdated && typeof message.watchId === "number") {
      const watch = this.watches.get(message.watchId);
      if (!watch || watch.stopped) return;
      watch.lastValue = message.value;
      watch.callback(message.value);
    }
  }

  handleWatchPatched(message: Partial<WorkerResponse>): void {
    if (
      message.op !== WorkerEvent.WatchPatched ||
      typeof message.watchId !== "number" ||
      !message.patch
    ) {
      return;
    }
    const watch = this.watches.get(message.watchId);
    if (!watch || watch.stopped) return;
    try {
      const value = applyWatchPatch(watch.lastValue, message.patch);
      watch.lastValue = value;
      watch.callback(value);
    } catch (error) {
      watch.onError(error);
    }
  }

  handleWatchFailed(message: Partial<WorkerResponse>): void {
    if (
      message.op === WorkerEvent.WatchFailed &&
      typeof message.watchId === "number" &&
      message.error
    ) {
      const watch = this.watches.get(message.watchId);
      if (!watch?.stopped) watch?.onError(deserializeError(message.error));
    }
  }

  handleDebug(message: Partial<WorkerResponse>): void {
    if (message.op === WorkerEvent.Debug && typeof message.phase === "string") {
      debugHook()?.({ detail: message.detail, phase: message.phase, source: "worker" });
    }
  }

  handleEvent(message: Partial<WorkerResponse>): void {
    if (message.op !== WorkerEvent.Event || !message.event) return;
    if (isInitProgress(message.event)) this.writeInitProgress();
    for (const listener of Array.from(this.eventListeners)) {
      try {
        listener(message.event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  handleAuthTokenRequest(message: Partial<WorkerResponse>): void {
    if (message.op !== WorkerEvent.AuthTokenRequest || typeof message.authRequestId !== "number") {
      return;
    }
    const id = this.allocateId();
    const forceRefreshToken = message.forceRefreshToken === true;
    void Promise.resolve()
      .then(async () => (await this.remoteAuth?.({ forceRefreshToken })) ?? null)
      .then(
        (token) => {
          this.worker.postMessage({
            authRequestId: message.authRequestId,
            clientId: this.clientId,
            id,
            op: WorkerCommand.AuthTokenResult,
            token,
          });
        },
        (error) => {
          this.worker.postMessage({
            authRequestId: message.authRequestId,
            clientId: this.clientId,
            error: serializeError(error),
            id,
            op: WorkerCommand.AuthTokenResult,
          });
        },
      );
  }

  handleTerminal(message: Partial<WorkerResponse>): void {
    if (message.op !== WorkerEvent.Terminal || !message.error) return;
    this.dispose(deserializeError(message.error));
  }

  private readonly onWorkerError = (event: unknown): void => {
    const error = workerEventError(event);
    this.emitRuntimeFailed(error);
    this.dispose(error);
  };

  private emitRuntimeFailed(error: Error): void {
    if (this.closed) return;
    const event: EmbeddedRuntimeEvent = {
      at: getTimerTime(),
      degradation: "failed",
      error: error.message,
      type: "runtime",
    };
    for (const listener of Array.from(this.eventListeners)) {
      try {
        listener(event);
      } catch (listenerError) {
        queueMicrotask(() => {
          throw listenerError;
        });
      }
    }
  }

  private rejectAcceptedMutation(id: number): void {
    const pending = this.pending.get(id);
    if (!pending || pending.op !== WorkerCommand.Mutation || !pending.accepted) return;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.reject(
      new IndeterminateMutationError(
        `Mutation was accepted but did not return a final result within ${this.acceptedResultTimeoutMs}ms.`,
      ),
    );
  }
}

function isInitProgress(event: EmbeddedEvent): boolean {
  if (event.type !== "runtime") return false;
  if (event.phase !== undefined && INIT_PROGRESS_PHASES.has(event.phase)) return true;
  return event.degradation !== undefined && INIT_PROGRESS_DEGRADATIONS.has(event.degradation);
}

function commandName(op: WorkerCommandCode): string {
  return workerCommandNames.get(op) ?? `unknown:${op}`;
}

const workerCommandNames = new Map<WorkerCommandCode, string>([
  [WorkerCommand.Init, "init"],
  [WorkerCommand.Query, "query"],
  [WorkerCommand.Mutation, "mutation"],
  [WorkerCommand.Upload, "upload"],
  [WorkerCommand.Devtools, "devtools"],
  [WorkerCommand.WatchStart, "watchStart"],
  [WorkerCommand.WatchStop, "watchStop"],
  [WorkerCommand.Close, "close"],
  [WorkerCommand.AuthTokenResult, "authTokenResult"],
  [WorkerCommand.Route, "route"],
  [WorkerCommand.IdentityRead, "identityRead"],
  [WorkerCommand.IdentityWrite, "identityWrite"],
  [WorkerCommand.RemoteIdentityRead, "remoteIdentityRead"],
  [WorkerCommand.RemoteNetworkWrite, "remoteNetworkWrite"],
  [WorkerCommand.StorageOwnerWrite, "storageOwnerWrite"],
]);

function workerEventError(event: unknown): Error {
  const value = event as {
    colno?: unknown;
    error?: unknown;
    filename?: unknown;
    lineno?: unknown;
    message?: unknown;
    type?: unknown;
  };
  if (value.error instanceof Error) return value.error;
  const message = typeof value.message === "string" ? value.message : "";
  const location = workerEventLocation(value);
  if (message.length > 0) {
    return new Error(location ? `${message} (${location})` : message);
  }
  const type = typeof value.type === "string" && value.type.length > 0 ? value.type : "error";
  return new Error(
    `ConvexEmbeddedClient worker failed: ${type}${location ? ` (${location})` : ""}.`,
  );
}

function workerEventLocation(value: {
  colno?: unknown;
  filename?: unknown;
  lineno?: unknown;
}): string {
  if (typeof value.filename !== "string" || value.filename.length === 0) return "";
  const line = typeof value.lineno === "number" ? value.lineno : undefined;
  const column = typeof value.colno === "number" ? value.colno : undefined;
  if (line === undefined) return value.filename;
  return column === undefined ? `${value.filename}:${line}` : `${value.filename}:${line}:${column}`;
}

function callWatchError(watch: WatchCallbacks, error: Error): void {
  try {
    watch.onError(error);
  } catch {}
}

function applyWatchPatch(value: unknown, patch: WatchPatch): unknown {
  if (patch.kind !== "arrayRows" || !Array.isArray(value) || value.length !== patch.length) {
    throw new Error("Embedded watch patch cannot be applied to the cached query result.");
  }
  const next = value.slice();
  for (const change of patch.changes) {
    if (!Number.isInteger(change.index) || change.index < 0 || change.index >= next.length) {
      throw new Error("Embedded watch patch contains an invalid row index.");
    }
    next[change.index] = change.value;
  }
  return next;
}

function debugHook():
  | ((event: { detail?: unknown; phase: string; source: "worker" }) => void)
  | undefined {
  const global = globalThis as typeof globalThis & {
    __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: {
      detail?: unknown;
      phase: string;
      source: "worker";
    }) => void;
  };
  return global.__CONVEX_EMBEDDED_DEBUG_LOG__;
}
