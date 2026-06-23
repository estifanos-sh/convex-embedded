import type { EmbeddedClient } from "../../client";
import type { EmbeddedInternalEvent } from "../../events";
import type {
  RunnerDevtoolsRequest,
  RunnerDevtoolsRows,
  RunnerDevtoolsSnapshot,
} from "../../runtime/runner";
import type {
  EmbeddedDevtoolsClient,
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
  return new ClientDevtoolsSource(client as unknown as EmbeddedDevtoolsClient);
}

class ClientDevtoolsSource implements EmbeddedDevtoolsSource {
  private readonly listeners = new Map<
    EmbeddedDevtoolsView,
    Set<(event?: EmbeddedInternalEvent) => void>
  >();
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
  private readonly pendingViewEvents = new Map<EmbeddedDevtoolsView, EmbeddedInternalEvent[]>();
  private readonly unsubscribe: () => void;

  constructor(private readonly client: EmbeddedDevtoolsClient) {
    this.unsubscribe =
      client.subscribeInternalEvents?.((event) => {
        this.queueEvent(event);
      }) ?? (() => undefined);
    this.rebuild();
    void this.readRuntime();
  }

  getSnapshot(_view: EmbeddedDevtoolsView): EmbeddedDevtoolsSnapshot {
    if (!this.disposed && !this.runtime && !this.refreshPromise) void this.readRuntime();
    return this.snapshot;
  }

  subscribe(
    view: EmbeddedDevtoolsView,
    callback: (event?: EmbeddedInternalEvent) => void,
  ): () => void {
    let set = this.listeners.get(view);
    if (!set) {
      set = new Set();
      this.listeners.set(view, set);
    }
    set.add(callback);
    void this.readRuntime();
    return () => {
      set?.delete(callback);
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
    if (!this.client.__devtoolsRunFunction) {
      throw new Error("This embedded client does not expose devtools function controls.");
    }
    const fn = await this.readFunction(input.path);
    return this.client.__devtoolsRunFunction({ ...input, kind: fn.kind });
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
    this.client.__devtoolsClearActivity?.();
    this.rebuild();
    this.emit("activity");
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.pendingViewEvents.clear();
    this.unsubscribe();
    this.listeners.clear();
  }

  private async runtimeRequest(request: RunnerDevtoolsRequest): Promise<unknown> {
    if (!this.client.__devtoolsRuntime) {
      throw new Error("This embedded client does not expose runtime devtools controls.");
    }
    return this.client.__devtoolsRuntime(request);
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

  private scheduleEventFlush(): void {
    if (this.disposed || this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      this.flushEvents();
    }, 0);
  }

  private queueView(view: EmbeddedDevtoolsView, event: EmbeddedInternalEvent): void {
    if (!this.hasViewListeners(view)) return;
    this.pendingClientRebuild = true;
    let events = this.pendingViewEvents.get(view);
    if (!events) {
      events = [];
      this.pendingViewEvents.set(view, events);
    }
    events.push(event);
    this.scheduleEventFlush();
  }

  private flushEvents(): void {
    if (this.disposed) return;
    if (this.pendingClientRebuild) {
      this.pendingClientRebuild = false;
      this.rebuild();
    }
    const events = [...this.pendingViewEvents];
    this.pendingViewEvents.clear();
    for (const [view, viewEvents] of events) {
      for (const event of viewEvents) this.emit(view, event);
    }
  }

  private rebuild(): void {
    const client = this.client.__devtoolsSnapshot?.();
    if (!client || !this.runtime) {
      this.snapshot = emptySnapshot();
      if (client) {
        this.snapshot = {
          ...this.snapshot,
          activity: {
            operations: client.operations,
            queries: client.queries,
            uploads: client.uploads,
          },
          runtime: {
            ...this.snapshot.runtime,
            clientId: client.clientId,
            closed: client.closed,
            error: this.runtimeError,
            status: this.runtimeStatus,
          },
        };
      }
      return;
    }
    this.snapshot = mergeSnapshots(client, this.runtime, this.runtimeStatus, this.runtimeError);
  }

  private emit(view: EmbeddedDevtoolsView, event?: EmbeddedInternalEvent): void {
    for (const listener of this.listeners.get(view) ?? []) listener(event);
  }

  private emitAll(event?: EmbeddedInternalEvent): void {
    for (const view of this.listeners.keys()) this.emit(view, event);
  }

  private queueEvent(event: EmbeddedInternalEvent): void {
    if (event.type === "operation" || event.type === "span") this.queueView("activity", event);
    if (event.type === "data") {
      this.queueView("data", event);
      if (this.hasViewListeners("data")) this.scheduleRuntimeRefresh();
    }
    if (event.type === "storage") {
      this.queueView("storage", event);
      if (this.hasViewListeners("storage")) this.scheduleRuntimeRefresh();
    }
    if (event.type === "scheduler") {
      this.queueView("scheduler", event);
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
