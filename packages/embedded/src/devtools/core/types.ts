import type {
  EmbeddedClientDebugOperation,
  EmbeddedClientDebugQuery,
  EmbeddedClientDebugSnapshot,
  EmbeddedClientDebugUpload,
} from "../../client";
import type { EmbeddedInternalEvent, EmbeddedInternalEventListener } from "../../events";
import type {
  RunnerDevtoolsFunction,
  RunnerDevtoolsRequest,
  RunnerDevtoolsRows,
  RunnerDevtoolsSchemaTable,
  RunnerDevtoolsSnapshot,
  RunnerDevtoolsStorage,
  RunnerDevtoolsTable,
} from "../../runtime/runner";
import type { ScheduledJob } from "../../storage/types";

/** Devtools pane that can emit source updates. @public */
export type EmbeddedDevtoolsView = "activity" | "data" | "functions" | "scheduler" | "storage";

/** Client activity entry rendered by the Activity tab. @public */
export type EmbeddedDevtoolsOperation = EmbeddedClientDebugOperation;

/** Watched query entry rendered by the Activity/Data tabs. @public */
export type EmbeddedDevtoolsQuery = EmbeddedClientDebugQuery;

/** Upload activity entry rendered by the Storage tab. @public */
export type EmbeddedDevtoolsUpload = EmbeddedClientDebugUpload;

/** Table summary rendered by the Data tab sidebar. @public */
export type EmbeddedDevtoolsTable = RunnerDevtoolsTable;

/** Table row page returned by {@link EmbeddedDevtoolsSource.listTableRows}. @public */
export type EmbeddedDevtoolsRows = RunnerDevtoolsRows;

/** Schema table metadata rendered by the Data tab. @public */
export type EmbeddedDevtoolsSchemaTable = RunnerDevtoolsSchemaTable;

/** Storage metadata rendered by the Storage tab. @public */
export interface EmbeddedDevtoolsStorage {
  dirtyHeads: RunnerDevtoolsStorage["dirtyHeads"];
  files: Record<string, unknown>[];
  idMappings: Record<string, unknown>[];
  projections: Record<string, unknown>[];
  uploads: Record<string, unknown>[];
}

/** Scheduler metadata rendered by the Scheduler tab. @public */
export interface EmbeddedDevtoolsScheduler {
  jobs: ScheduledJob[];
}

/** Function metadata rendered by the Functions tab. @public */
export type EmbeddedDevtoolsFunction = RunnerDevtoolsFunction;

/** Runtime metadata included in the devtools snapshot. @public */
export interface EmbeddedDevtoolsRuntime {
  clientId: string;
  closed: boolean;
  error: string | null;
  role: string;
  status: "error" | "loading" | "ready";
  tableCount: number;
  /** Retained-result cache observability (Cut 7 §7). */
  cacheEntries?: number;
  cacheServes?: number;
  cacheMisses?: number;
  foreignEvaluations?: number;
}

/** Full devtools snapshot. @public */
export interface EmbeddedDevtoolsSnapshot {
  activity: {
    operations: EmbeddedDevtoolsOperation[];
    queries: EmbeddedDevtoolsQuery[];
    uploads: EmbeddedDevtoolsUpload[];
  };
  data: EmbeddedDevtoolsTable[];
  functions: EmbeddedDevtoolsFunction[];
  runtime: EmbeddedDevtoolsRuntime;
  scheduler: EmbeddedDevtoolsScheduler;
  schema: EmbeddedDevtoolsSchemaTable[];
  storage: EmbeddedDevtoolsStorage;
}

/** Function invocation issued from the Functions tab. @public */
export interface EmbeddedDevtoolsRunFunctionInput {
  args: Record<string, unknown>;
  path: string;
}

/** Devtools data/control source. @public */
export interface EmbeddedDevtoolsSource {
  clearActivity(): void;
  clearLocalData(): Promise<void>;
  deleteDocument(table: string, id: string): Promise<void>;
  dispose(): void;
  refresh(): Promise<void>;
  getSnapshot(view: EmbeddedDevtoolsView): EmbeddedDevtoolsSnapshot;
  listTableRows(
    table: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<EmbeddedDevtoolsRows>;
  patchDocument(table: string, id: string, fields: Record<string, unknown>): Promise<void>;
  runFunction(input: EmbeddedDevtoolsRunFunctionInput): Promise<unknown>;
  subscribe(
    view: EmbeddedDevtoolsView,
    callback: (event?: EmbeddedInternalEvent) => void,
  ): () => void;
}

/** Client hooks consumed by the source implementation. @internal */
export interface EmbeddedDevtoolsClient {
  __devtoolsClearActivity?(): void;
  __devtoolsRunFunction?(
    input: EmbeddedDevtoolsRunFunctionInput & {
      kind: EmbeddedDevtoolsFunction["kind"];
    },
  ): Promise<unknown>;
  __devtoolsRuntime?(request: RunnerDevtoolsRequest): Promise<unknown>;
  __devtoolsSnapshot?(): EmbeddedClientDebugSnapshot;
  subscribeInternalEvents?(listener: EmbeddedInternalEventListener): () => void;
}

/** Empty snapshot used before the runtime has answered. @internal */
export function emptySnapshot(): EmbeddedDevtoolsSnapshot {
  return mergeSnapshots(emptyClientSnapshot(), emptyRuntimeSnapshot(), "loading");
}

/** Merge client-side activity with runtime-backed storage state. @internal */
export function mergeSnapshots(
  client: EmbeddedClientDebugSnapshot,
  runtime: RunnerDevtoolsSnapshot,
  status: EmbeddedDevtoolsRuntime["status"] = "ready",
  error: string | null = null,
): EmbeddedDevtoolsSnapshot {
  return {
    activity: {
      operations: client.operations,
      queries: client.queries,
      uploads: client.uploads,
    },
    data: runtime.data,
    functions: runtime.functions,
    runtime: {
      clientId: client.clientId,
      closed: client.closed,
      error,
      role: runtime.runtime.role,
      status,
      tableCount: runtime.runtime.tableCount,
    },
    scheduler: runtime.scheduler,
    schema: runtime.schema,
    storage: runtime.storage,
  };
}

function emptyClientSnapshot(): EmbeddedClientDebugSnapshot {
  return {
    clientId: "unknown",
    closed: false,
    operations: [],
    queries: [],
    uploads: [],
  };
}

function emptyRuntimeSnapshot(): RunnerDevtoolsSnapshot {
  return {
    data: [],
    functions: [],
    runtime: { role: "unknown", tableCount: 0 },
    scheduler: { jobs: [] },
    schema: [],
    storage: {
      crdtHeads: [],
      dirtyHeads: [],
      files: [],
      idMappings: [],
      projections: [],
      uploads: [],
    },
  };
}
