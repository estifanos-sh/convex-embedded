import type { EmbeddedClient } from "../../client";
import type { DiagnosticEvent } from "../../events";
import { readDevtoolsBridge, type DevtoolsBridge } from "../bridge";
import type {
  RunnerDevtoolsRequest,
  RunnerDevtoolsRows,
  RunnerDevtoolsSnapshot,
} from "../../runtime/runner";
import type {
  EmbeddedDevtoolsRuntime,
  EmbeddedDevtoolsRunFunctionInput,
  EmbeddedDevtoolsSnapshot,
  EmbeddedDevtoolsSource,
  EmbeddedDevtoolsView,
} from "./types";
import { emptySnapshot, mergeSnapshots } from "./types";

/**
 * Creates a structured devtools source from an embedded client.
 *
 * @param client - Embedded client instance.
 * @returns Source consumed by the devtools UI.
 * @public
 */
export function createEmbeddedDevtoolsSource(client: EmbeddedClient): EmbeddedDevtoolsSource {
  return new ClientDevtoolsSource(readDevtoolsBridge(client));
}

class ClientDevtoolsSource implements EmbeddedDevtoolsSource {
  private readonly listeners = new Map<EmbeddedDevtoolsView, Set<() => void>>();
  private runtime: RunnerDevtoolsSnapshot | undefined;
  private runtimeError: string | null = null;
  private runtimeStatus: EmbeddedDevtoolsRuntime["status"] = "loading";
  private snapshot: EmbeddedDevtoolsSnapshot = emptySnapshot();
  private disposed = false;
  private refreshPromise: Promise<void> | undefined;
  private refreshRequestId = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private eventTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingClientRebuild = false;
  private readonly pendingViews = new Set<EmbeddedDevtoolsView>();
  private readonly unsubscribe: () => void;

  constructor(private readonly bridge: DevtoolsBridge) {
    this.unsubscribe = bridge.subscribe((event) => this.queueDiagnostic(event));
    this.rebuild();
    void this.readRuntime();
  }

  getSnapshot(_view: EmbeddedDevtoolsView): EmbeddedDevtoolsSnapshot {
    if (!this.disposed && !this.runtime && !this.refreshPromise) void this.readRuntime();
    return this.snapshot;
  }

  subscribe(view: EmbeddedDevtoolsView, callback: () => void): () => void {
    let callbacks = this.listeners.get(view);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(view, callbacks);
    }
    callbacks.add(callback);
    void this.readRuntime();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      callbacks?.delete(callback);
    };
  }

  async refresh(): Promise<void> {
    return this.readRuntime(true);
  }

  async listTableRows(
    table: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<RunnerDevtoolsRows> {
    return (await this.runtimeRequest({
      cursor: options.cursor ?? null,
      kind: "listRows",
      limit: options.limit,
      table,
    })) as RunnerDevtoolsRows;
  }

  async runFunction(input: EmbeddedDevtoolsRunFunctionInput): Promise<unknown> {
    const fn = await this.readFunction(input.path);
    return this.bridge.runFunction({ ...input, kind: fn.kind });
  }

  async patchDocument(table: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.runtimeRequest({ fields, id, kind: "patchDocument", table });
    await this.refresh();
    this.emit("data");
  }

  async deleteDocument(table: string, id: string): Promise<void> {
    await this.runtimeRequest({ id, kind: "deleteDocument", table });
    await this.refresh();
    this.emit("data");
  }

  async clearLocalData(): Promise<void> {
    await this.runtimeRequest({ kind: "clearData" });
    await this.refresh();
    this.emitAll();
  }

  clearActivity(): void {
    this.bridge.clearActivity();
    this.rebuild();
    this.emit("activity");
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.pendingViews.clear();
    this.unsubscribe();
    this.listeners.clear();
  }

  private async runtimeRequest(request: RunnerDevtoolsRequest): Promise<unknown> {
    return this.bridge.runtime(request);
  }

  private async readFunction(path: string) {
    await this.readRuntime();
    let fn = this.snapshot.functions.find((entry) => entry.path === path);
    if (!fn) {
      await this.refresh();
      fn = this.snapshot.functions.find((entry) => entry.path === path);
    }
    if (!fn) throw new Error(`Unknown embedded function: ${path}`);
    return fn;
  }

  private async readRuntime(force = false): Promise<void> {
    if (this.disposed) return;
    if (this.refreshPromise && !force) return this.refreshPromise;
    const requestId = ++this.refreshRequestId;
    this.runtimeError = null;
    this.runtimeStatus = "loading";
    this.rebuild();
    this.emitAll();
    const refresh = this.runtimeRequest({ kind: "snapshot" })
      .then((snapshot) => {
        if (requestId !== this.refreshRequestId) return;
        this.runtime = snapshot as RunnerDevtoolsSnapshot;
        this.runtimeError = null;
        this.runtimeStatus = "ready";
        this.rebuild();
        this.emitAll();
      })
      .catch((error) => {
        if (requestId !== this.refreshRequestId) return;
        this.runtimeError = formatRuntimeError(error);
        this.runtimeStatus = "error";
        this.rebuild();
        this.emitAll();
      })
      .finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = undefined;
      });
    this.refreshPromise = refresh;
    return refresh;
  }

  private scheduleRuntimeRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 100);
  }

  private scheduleInvalidation(): void {
    if (this.disposed || this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      this.flushInvalidations();
    }, 0);
  }

  private queueView(view: EmbeddedDevtoolsView): void {
    if (!this.hasViewListeners(view)) return;
    this.pendingClientRebuild = true;
    this.pendingViews.add(view);
    this.scheduleInvalidation();
  }

  private flushInvalidations(): void {
    if (this.disposed) return;
    if (this.pendingClientRebuild) {
      this.pendingClientRebuild = false;
      this.rebuild();
    }
    const views = [...this.pendingViews];
    this.pendingViews.clear();
    for (const view of views) this.emit(view);
  }

  private rebuild(): void {
    const client = this.bridge.snapshot();
    if (!this.runtime) {
      this.snapshot = {
        ...emptySnapshot(),
        activity: {
          operations: client.operations,
          queries: client.queries,
          uploads: client.uploads,
        },
        runtime: {
          ...emptySnapshot().runtime,
          clientId: client.clientId,
          closed: client.closed,
          error: this.runtimeError,
          status: this.runtimeStatus,
        },
      };
      return;
    }
    this.snapshot = mergeSnapshots(client, this.runtime, this.runtimeStatus, this.runtimeError);
  }

  private emit(view: EmbeddedDevtoolsView): void {
    for (const callback of Array.from(this.listeners.get(view) ?? [])) {
      try {
        callback();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  private emitAll(): void {
    for (const view of this.listeners.keys()) this.emit(view);
  }

  private queueDiagnostic(event: DiagnosticEvent): void {
    if (event.type === "operation" || event.type === "span") this.queueView("activity");
    if (event.type === "operation" && event.kind === "upload") this.queueView("storage");
    if (event.type === "data") {
      this.queueView("data");
      if (this.hasViewListeners("data")) this.scheduleRuntimeRefresh();
    }
    if (event.type === "storage") {
      this.queueView("storage");
      if (this.hasViewListeners("storage")) this.scheduleRuntimeRefresh();
    }
    if (event.type === "scheduler") {
      this.queueView("scheduler");
      if (this.hasViewListeners("scheduler")) this.scheduleRuntimeRefresh();
    }
  }

  private hasViewListeners(view: EmbeddedDevtoolsView): boolean {
    return (this.listeners.get(view)?.size ?? 0) > 0;
  }
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (value: unknown) => void }).reportError;
  if (report) {
    report(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}
