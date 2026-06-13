import { getFunctionName } from "convex/server";
import type { Runner, RunMutationOptions } from "../runtime/runner";
import type { FunctionReference } from "../runtime/functions";
import { randomId } from "../util";
import {
  deserializeError,
  type EmbeddedWorker,
  type EmbeddedWorkerSource,
  type RuntimeIdentity,
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
  requestTimeoutMs?: number;
  storagePath: string;
}

interface PendingRequest {
  accepted: boolean;
  onAccepted: ((this: void, mutationId: string) => void) | undefined;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  op: WorkerCommandCode;
}

interface WatchCallbacks {
  callback(value: unknown): void;
  onError(error: unknown): void;
  started: boolean;
  stopped: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ACCEPTED_RESULT_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

type WorkerEventHandler = (runner: WorkerRunner, message: Partial<WorkerResponse>) => void;

const workerEventHandlers = new Map<number, WorkerEventHandler>([
  [WorkerEvent.Result, (runner, message) => runner.handleResult(message)],
  [WorkerEvent.MutationAccepted, (runner, message) => runner.handleMutationAccepted(message)],
  [WorkerEvent.WatchUpdated, (runner, message) => runner.handleWatchUpdated(message)],
  [WorkerEvent.WatchFailed, (runner, message) => runner.handleWatchFailed(message)],
  [WorkerEvent.Debug, (runner, message) => runner.handleDebug(message)],
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
  private readonly clientId = randomId("client");
  private closed = false;
  private nextId = 1;
  private nextWatchId = 1;
  private readonly acceptedResultTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<unknown>;
  private readonly requestTimeoutMs: number;
  private readonly watches = new Map<number, WatchCallbacks>();
  private readonly worker: EmbeddedWorker;

  constructor(source: EmbeddedWorkerSource, init?: WorkerRunnerInit) {
    this.worker = typeof source === "function" ? source() : source;
    this.acceptedResultTimeoutMs =
      init?.acceptedResultTimeoutMs ?? DEFAULT_ACCEPTED_RESULT_TIMEOUT_MS;
    this.closeTimeoutMs = init?.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.requestTimeoutMs = init?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerError);
    this.worker.start?.();
    this.ready = init
      ? this.request(
          {
            clientId: this.clientId,
            debug: init.debug ?? debugHook() !== undefined,
            id: this.allocateId(),
            identity: init.identity,
            storagePath: init.storagePath,
            op: WorkerCommand.Init,
          },
          { timeoutMs: this.requestTimeoutMs },
        )
      : Promise.resolve();
    this.ready.catch(() => undefined);
    if (init?.identity) {
      this.ready
        .then(() => {
          if (this.closed) return;
          this.heartbeatTimer = setInterval(() => {
            try {
              this.worker.postMessage({
                clientId: this.clientId,
                id: this.allocateId(),
                op: WorkerCommand.Heartbeat,
              });
            } catch (error) {
              this.dispose(workerEventError(error));
            }
          }, HEARTBEAT_INTERVAL_MS);
        })
        .catch(() => undefined);
    }
  }

  async runQuery(ref: FunctionReference, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    return this.request(
      {
        args,
        clientId: this.clientId,
        id: this.allocateId(),
        name: functionName(ref),
        op: WorkerCommand.Query,
      },
      // A slow query rejects only itself; it must not dispose the whole runner. Disposal is
      // reserved for Init/protocol failures (default "fatal").
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
    return this.request(
      {
        args,
        clientId: this.clientId,
        id,
        mutationId: options.mutationId ?? `${this.clientId}:${id}`,
        name: functionName(ref),
        op: WorkerCommand.Mutation,
      },
      {
        onAccepted: options.onAccepted,
        timeoutMs: this.requestTimeoutMs,
      },
    );
  }

  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: (value: unknown) => void,
    onError: (error: unknown) => void = () => undefined,
  ): () => void {
    this.ensureOpen();
    const watchId = this.nextWatchId++;
    const watch: WatchCallbacks = { callback, onError, started: false, stopped: false };
    this.watches.set(watchId, watch);
    void this.ready
      .then(async () => {
        if (watch.stopped || this.closed) return;
        watch.started = true;
        await this.request(
          {
            args,
            clientId: this.clientId,
            id: this.allocateId(),
            name: functionName(ref),
            op: WorkerCommand.WatchStart,
            watchId,
          },
          { timeoutMs: this.requestTimeoutMs },
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
    try {
      await this.request(
        {
          clientId: this.clientId,
          id: this.allocateId(),
          op: WorkerCommand.Close,
        },
        { allowClosed: true, timeoutMs: this.closeTimeoutMs },
      ).catch(() => undefined);
    } finally {
      this.dispose(new Error("ConvexEmbeddedClient has already been closed."));
    }
  }

  private request(
    message: WorkerRequest,
    options: {
      allowClosed?: boolean;
      onAccepted?(this: void, mutationId: string): void;
      timeoutMs?: number;
      /**
       * What a timeout means: `"fatal"` (default) treats a lost response as a wedged worker
       * and disposes the runner; `"reject"` fails only this request.
       */
      timeoutPolicy?: "fatal" | "reject";
    } = {},
  ): Promise<unknown> {
    if (!options.allowClosed) this.ensureOpen();
    return new Promise((resolve, reject) => {
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const pending = this.pending.get(message.id);
              if (!pending) return;
              if (pending.op === WorkerCommand.Mutation && pending.accepted) {
                this.rejectAcceptedMutation(message.id);
                return;
              }
              const timeout = new Error(
                `ConvexEmbeddedClient worker request "${commandName(pending.op)}" timed out after ${options.timeoutMs}ms.`,
              );
              if (options.timeoutPolicy === "reject") {
                this.pending.delete(message.id);
                pending.reject(timeout);
                return;
              }
              this.dispose(new Error(`${timeout.message} Worker was terminated.`));
            }, options.timeoutMs);
      this.pending.set(message.id, {
        accepted: false,
        onAccepted: options.onAccepted,
        reject,
        resolve,
        timer,
        op: message.op,
      });
      try {
        // Do not transfer buffers here: query/mutation args remain caller-owned after the send.
        this.worker.postMessage(message);
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }

  private allocateId(): number {
    return this.nextId++;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("ConvexEmbeddedClient has already been closed.");
    }
  }

  private dispose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerError);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.worker.close?.();
    this.worker.terminate?.();
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
      if (!watch?.stopped) watch?.callback(message.value);
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

  private readonly onWorkerError = (event: unknown): void => {
    this.dispose(workerEventError(event));
  };

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

function functionName(ref: FunctionReference): string {
  return typeof ref === "string" ? ref : getFunctionName(ref);
}

function commandName(op: WorkerCommandCode): string {
  return workerCommandNames.get(op) ?? `unknown:${op}`;
}

const workerCommandNames = new Map<WorkerCommandCode, string>([
  [WorkerCommand.Init, "init"],
  [WorkerCommand.Query, "query"],
  [WorkerCommand.Mutation, "mutation"],
  [WorkerCommand.WatchStart, "watchStart"],
  [WorkerCommand.WatchStop, "watchStop"],
  [WorkerCommand.Close, "close"],
  [WorkerCommand.Heartbeat, "heartbeat"],
]);

function workerEventError(event: unknown): Error {
  const value = event as { error?: unknown; message?: string; type?: string };
  if (value.error instanceof Error) return value.error;
  if (typeof value.message === "string" && value.message.length > 0) {
    return new Error(value.message);
  }
  return new Error(`ConvexEmbeddedClient worker failed${value.type ? `: ${value.type}` : ""}.`);
}

function callWatchError(watch: WatchCallbacks, error: Error): void {
  try {
    watch.onError(error);
  } catch {
    // User callbacks cannot be allowed to interrupt worker cleanup.
  }
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
