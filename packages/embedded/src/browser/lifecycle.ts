import type { UserIdentity } from "convex/server";

import type { EmbeddedEventListener } from "../events";
import type { FunctionReference } from "../runtime/functions";
import type {
  Runner,
  RunnerDevtoolsRequest,
  RunnerRoute,
  RunMutationOptions,
  RunOptions,
  StopOnUpdate,
} from "../runtime/runner";
import type { RemoteIdentity } from "../storage/types";
import type { WorkerRunner } from "./proxy";

/** One disposable worker generation behind a stable browser client. @internal */
export interface BrowserRunnerHandle {
  close(): Promise<void> | void;
  closeNow(): Promise<void> | void;
  eagerRunner: WorkerRunner;
  runner: WorkerRunner | Promise<WorkerRunner>;
}

interface RetainedWatch {
  args: Record<string, unknown>;
  callback(value: unknown): void;
  generation: number;
  onError(error: unknown): void;
  options: RunOptions;
  ref: FunctionReference;
  stop?: StopOnUpdate;
  stopped: boolean;
}

/**
 * Stable runner facade whose disposable worker generation can be replaced after page suspension.
 * Watches belong to this facade, not to a worker, so a resumed page reattaches them in place.
 *
 * @internal
 */
export class BrowserLifecycleRunner implements Runner {
  private active: BrowserRunnerHandle | undefined;
  private closed = false;
  private eventStop: StopOnUpdate | undefined;
  private generation = 0;
  private initial: Promise<WorkerRunner>;
  private readonly listeners = new Set<EmbeddedEventListener>();
  private networkOnline: boolean | undefined;
  private temporaryStorage = false;
  private suspended = false;
  private readonly watches = new Set<RetainedWatch>();

  constructor(private readonly open: () => BrowserRunnerHandle) {
    const active = this.open();
    this.active = active;
    this.bindEvents(active);
    this.initial = Promise.resolve(active.runner);
  }

  initialized(): Promise<WorkerRunner> {
    return this.initial;
  }

  get localConfigured(): boolean {
    return this.active?.eagerRunner.localConfigured === true;
  }

  readonly identity = {
    read: async (): Promise<{ identity: UserIdentity | null; identityKey: string } | undefined> =>
      await (await this.current()).identity.read(),
    write: async (identityKey: string): Promise<void> => {
      await (await this.current()).identity.write(identityKey);
    },
  };

  readonly remote = {
    identity: {
      read: async (): Promise<RemoteIdentity | undefined> =>
        await (await this.current()).remote.identity.read(),
    },
    network: {
      write: async (online: boolean): Promise<void> => {
        this.networkOnline = online;
        const active = this.active;
        if (!active || this.suspended || this.closed) return;
        await active.eagerRunner.remote.network.write(online);
      },
    },
    scope: {
      write: async (): Promise<void> => {
        await (await this.current()).remote.scope.write();
      },
    },
  };

  readonly storage = {
    owner: {
      write: async (): Promise<void> => {
        await (await this.current()).storage.owner.write();
      },
    },
  };

  async route(
    ref: FunctionReference,
    args: Record<string, unknown>,
    kind: "query" | "mutation" | "action",
  ): Promise<RunnerRoute> {
    return await (await this.current()).route(ref, args, kind);
  }

  async runQuery(
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    options: RunOptions = {},
  ): Promise<unknown> {
    return await (await this.current()).runQuery(ref, args, options);
  }

  async runMutation(
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    options: RunMutationOptions = {},
  ): Promise<unknown> {
    return await (await this.current()).runMutation(ref, args, options);
  }

  async runAction(
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    options: RunOptions = {},
  ): Promise<unknown> {
    return await (await this.current()).runAction(ref, args, options);
  }

  async handleUpload(url: string, blob: Blob): Promise<{ storageId: string }> {
    return await (await this.current()).handleUpload(url, blob);
  }

  async devtools(request: RunnerDevtoolsRequest): Promise<unknown> {
    return await (await this.current()).devtools(request);
  }

  subscribeEvents(listener: EmbeddedEventListener): StopOnUpdate {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  invalidate(_changedTables: string[], _source: "local" | "remote"): void {
    this.active?.eagerRunner.invalidate();
  }

  rerunResults(_keys: string[]): void {
    this.active?.eagerRunner.rerunResults();
  }

  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: (value: unknown) => void,
    onError: (error: unknown) => void = () => undefined,
    options: RunOptions = {},
  ): StopOnUpdate {
    this.ensureOpen();
    const watch: RetainedWatch = {
      args,
      callback,
      generation: this.generation,
      onError,
      options,
      ref,
      stopped: false,
    };
    this.watches.add(watch);
    const active = this.active;
    if (active && !this.suspended) this.attachWatch(watch, active.eagerRunner);
    return () => {
      if (watch.stopped) return;
      watch.stopped = true;
      watch.stop?.();
      watch.stop = undefined;
      this.watches.delete(watch);
    };
  }

  /** Releases the current worker and its exclusive OPFS handles before the page can freeze. */
  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    this.generation += 1;
    this.eventStop?.();
    this.eventStop = undefined;
    for (const watch of this.watches) {
      watch.stop?.();
      watch.stop = undefined;
    }
    // A temporary store has no shared OPFS handles and must stay alive to preserve its in-memory
    // data. The facade still suspends so hidden-page calls fail and watches stop publishing.
    if (this.temporaryStorage) return;
    const active = this.active;
    this.active = undefined;
    void active?.closeNow();
  }

  /** Opens a fresh worker generation and reattaches retained watches without reloading the page. */
  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    const generation = ++this.generation;
    if (this.temporaryStorage) {
      const active = this.active;
      if (!active) return;
      this.bindEvents(active);
      for (const watch of this.watches) this.attachWatch(watch, active.eagerRunner);
      if (this.networkOnline !== undefined) {
        await active.eagerRunner.remote.network.write(this.networkOnline);
      }
      return;
    }
    const active = this.open();
    this.active = active;
    this.bindEvents(active);
    for (const watch of this.watches) this.attachWatch(watch, active.eagerRunner);
    try {
      const runner = await active.runner;
      if (this.closed || this.suspended || this.generation !== generation) return;
      if (this.networkOnline !== undefined) {
        await runner.remote.network.write(this.networkOnline);
      }
    } catch {
      if (this.generation !== generation || this.closed) return;
      this.suspended = true;
      this.active = undefined;
      this.eventStop?.();
      this.eventStop = undefined;
      void active.closeNow();
      for (const watch of this.watches) watch.stop = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.suspended = false;
    this.generation += 1;
    this.eventStop?.();
    this.eventStop = undefined;
    for (const watch of this.watches) {
      watch.stopped = true;
      watch.stop?.();
    }
    this.watches.clear();
    const active = this.active;
    this.active = undefined;
    await active?.close();
  }

  private attachWatch(watch: RetainedWatch, runner: WorkerRunner): void {
    if (watch.stopped) return;
    watch.stop?.();
    const generation = this.generation;
    watch.generation = generation;
    watch.stop = runner.onUpdate(
      watch.ref,
      watch.args,
      (value) => {
        if (!watch.stopped && !this.suspended && watch.generation === generation) {
          watch.callback(value);
        }
      },
      (error) => {
        if (!watch.stopped && !this.suspended && watch.generation === generation) {
          watch.onError(error);
        }
      },
      watch.options,
    );
  }

  private bindEvents(active: BrowserRunnerHandle): void {
    this.eventStop?.();
    const generation = this.generation;
    this.eventStop = active.eagerRunner.subscribeEvents((event) => {
      if (this.suspended || this.closed || generation !== this.generation) return;
      if (event.type === "runtime" && event.degradation === "temporary-storage") {
        this.temporaryStorage = true;
      }
      for (const listener of Array.from(this.listeners)) {
        try {
          listener(event);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    });
  }

  private async current(): Promise<WorkerRunner> {
    this.ensureOpen();
    const active = this.active;
    if (!active || this.suspended) {
      throw new Error("ConvexEmbeddedClient browser runtime is suspended.");
    }
    return await active.runner;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("ConvexEmbeddedClient has already been closed.");
  }
}

type PageLifecycleEvent = "freeze" | "pagehide" | "pageshow" | "resume" | "visibilitychange";

interface PageLifecycleGlobal {
  addEventListener?: (
    type: PageLifecycleEvent,
    callback: (event: { persisted?: boolean }) => void,
  ) => void;
  document?: {
    addEventListener?: (
      type: "visibilitychange",
      callback: (event: { persisted?: boolean }) => void,
    ) => void;
    removeEventListener?: (
      type: "visibilitychange",
      callback: (event: { persisted?: boolean }) => void,
    ) => void;
    visibilityState?: string;
  };
  removeEventListener?: (
    type: PageLifecycleEvent,
    callback: (event: { persisted?: boolean }) => void,
  ) => void;
}

/** Releases storage while hidden and recreates the worker in place when the page returns. @internal */
export function installPageLifecycle(
  suspend: () => void,
  resume: () => void,
  global: PageLifecycleGlobal = globalThis as typeof globalThis & PageLifecycleGlobal,
): () => void {
  if (
    typeof global.addEventListener !== "function" ||
    typeof global.removeEventListener !== "function"
  ) {
    return () => undefined;
  }
  const onVisibilityChange = () => {
    if (global.document?.visibilityState === "hidden") suspend();
    else if (global.document?.visibilityState === "visible") resume();
  };
  global.addEventListener("freeze", suspend);
  global.addEventListener("pagehide", suspend);
  global.addEventListener("pageshow", resume);
  global.addEventListener("resume", resume);
  global.document?.addEventListener?.("visibilitychange", onVisibilityChange);
  if (global.document?.visibilityState === "hidden") queueMicrotask(onVisibilityChange);
  return () => {
    global.removeEventListener?.("freeze", suspend);
    global.removeEventListener?.("pagehide", suspend);
    global.removeEventListener?.("pageshow", resume);
    global.removeEventListener?.("resume", resume);
    global.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
  };
}
