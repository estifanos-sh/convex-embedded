import type { GenericDataModel, UserIdentity } from "convex/server";
import { convexToJson } from "convex/values";
import type {
  GenericValidator,
  JSONValue,
  PropertyValidators,
  Value,
  ValidatorJSON,
} from "convex/values";
import type {
  CommitOptions,
  CrdtSnapshot,
  DirtyHeadDebug,
  OneDocWriteCommit,
  RemoteIdentity,
  RemoteMutationSettlement,
  RemoteScope,
  RemoteSubscription,
  RuntimeStorageWriter,
  ScheduledFunctionKind,
  ScheduledJob,
  StoreSchema,
  WriteBatch,
} from "../storage/types";
import type {
  DiagnosticEvent,
  DiagnosticEventListener,
  EmbeddedRemoteEvent,
  EmbeddedMutationTiming,
  EmbeddedSpanEvent,
} from "../events";
import { getElapsedTime, getTimerTime } from "../time";
import { withEntropy } from "../entropy";
import { canonicalJson, hashValue, resultCacheKey } from "../hash";
import {
  pointerPart,
  validatorIdReferences,
  validatorIdValues,
  type ValidatorIdReference,
  type ValidatorIdValue,
} from "../id/path";
import { EmbeddedUnsupportedError } from "../error";
import { isLocalFunction, stampLocal } from "../local/internal";
import { normalizeMutationResult } from "../result";
import { embeddedComponentModules } from "../component/local";
import { embeddedComponentStoreSchema } from "../schema";
import { isLocalIdShape, tableFromId } from "./doc";
import {
  assertValueWalk,
  cloneTree,
  decode,
  decodeError,
  encode,
  encodeError,
  equals,
  normalizeCopy,
} from "./codec";
import { assertNoPendingCommitTs, hasPendingCommitTs, pendingCommitTsRead } from "./pending";
import { pageCursorBoundary } from "./query";
import {
  createReadAuthority,
  hasLocalOptimism,
  outputAgrees,
  readDisclosure,
  reconstruct,
  type CrdtFieldsByTable,
  type ReadAuthority,
} from "./cache";
import {
  createReader,
  createWriter,
  hostedToLocal,
  toSchema,
  type DatabaseReader,
  type Schema,
} from "./database";
import {
  batchInvalidationKeys,
  invalidationKey,
  namespaceBatch,
  namespaceStore,
  ROOT_INSTANCE,
  type ComponentInstancePath,
} from "./components";
import type { FunctionPlacement, FunctionReference, RegisteredFunction } from "./functions";
import { createLedgerReader } from "./ledger";
import type { RunnerMode } from "./mode";
import type { BaseVersion, ReadBound, ReadTracker } from "./query";
import { validateFields, validateJson, validateValue } from "./validate";
import { emitCommit, emitDeletes } from "./emit";
import {
  createSchedulerPump,
  createSchedulerService,
  type SchedulerPump,
  type SchedulerService,
} from "./scheduler";
import {
  createStorageService,
  type StorageReaderService,
  type StorageWriterService,
  type UploadUrl,
} from "./storage/service";
import { fullStore, functionName, type RuntimeCalls } from "./service";
import { CURRENT_WIRE_CONTRACT_ID, EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";

/**
 * Convex function modules keyed by module path.
 *
 * @internal
 */
export type ModuleMap = Record<string, ModuleEntry>;

/**
 * A loaded Convex module.
 *
 * @internal
 */
export type ModuleExports = Record<string, unknown>;

/**
 * A Convex module or lazy module loader.
 *
 * @internal
 */
export type ModuleEntry = ModuleExports | (() => Promise<ModuleExports>);

/**
 * Device-only function modules keyed by namespaced local module id, such as `local/sync/drafts`.
 *
 * @internal
 */
export type LocalModuleMap = Record<string, () => Promise<unknown>>;

/** Namespace every device-only function name carries. @internal */
export const LOCAL_FUNCTION_PREFIX = "local/";

/** Raised when a device-only function is dispatched without any configured local root. @internal */
export const LOCAL_UNCONFIGURED_ERROR =
  "No local directory is configured; pass the local option to the bundler adapter.";

/**
 * Watched-query value callback.
 *
 * @internal
 */
export type OnUpdateCallback = (value: unknown, info?: WatchUpdateInfo) => void;

/** Watched-query update metadata. @internal */
export interface WatchUpdateInfo {
  changedDocIds?: Set<string>;
}

/**
 * Watched-query error callback.
 *
 * @internal
 */
export type OnUpdateErrorCallback = (error: unknown) => void;

/**
 * Stops a watched query.
 *
 * @internal
 */
export type StopOnUpdate = () => void;

/**
 * Metadata for a mutation execution.
 *
 * @internal
 */
export interface RunMutationOptions {
  allowInternal?: boolean;
  auth?: UserIdentity | null;
  /** Placement of the currently executing parent function. @internal */
  callerPlacement?: FunctionPlacement;
  mutationIsFresh?: boolean;
  mutationId?: string;
  onAccepted?(this: void, mutationId: string): void;
  onTiming?(this: void, timing: RunMutationTiming): void;
  /**
   * Client-captured call identity for mutation-replay push (contract §2). When present, the run
   * captures its read-set and id allocations and rides them, plus the run's HLC time, on the commit
   * as the determinism envelope. The runner stamps `mutationTimeHlc` (the value the run consumed).
   */
  pushCall?: RunMutationPushCall;
  revisionReplay?: RevisionReplay;
}

interface RevisionReplay {
  createdAt: number;
  mutationId: string;
  nextCheckpointOrdinal: number;
  nextOrdinal: number;
  checkpoints: Array<{
    ordinal: number;
    operation: "create" | "retain";
    rowId: string;
    table: string;
    snapshots: CrdtSnapshot[];
  }>;
}

/** The client-known half of the push envelope: function identity and deterministic RNG seed. */
export interface RunMutationPushCall {
  fn: string;
  rngSeed: string;
}

/** Per-mutation phase timings used by runtime diagnostics. @internal */
export type RunMutationTiming = EmbeddedMutationTiming;

/**
 * Metadata for query/action execution.
 *
 * @internal
 */
export interface RunOptions {
  allowInternal?: boolean;
  auth?: UserIdentity | null;
  /** Placement of the currently executing parent function. @internal */
  callerPlacement?: FunctionPlacement;
  remoteScope?: boolean | (() => boolean);
}

/** Options for the local Convex runner. @internal */
export interface RunnerOptions {
  deferNotify?(this: void, run: () => void): void;
  emit?: DiagnosticEventListener;
  hasEventListeners?(): boolean;
  /** Device-only modules imported eagerly during runner construction. */
  localModules?: LocalModuleMap;
  /** Candidate setup admits historical helpers; the published runner excludes them. */
  mode?: RunnerMode;
  moduleGraphHash?: string;
  /** Trusted build-time placement metadata, including hosted-only functions. */
  manifest?: RuntimeFunctionManifest;
  remote?: boolean;
}

/**
 * Build-time function metadata used to route functions omitted from the device bundle. Device-only
 * placement is never declared here: it belongs to modules under the bundler's local directory,
 * which dispatch by their stamped name instead.
 *
 * @internal
 */
export type RuntimeFunctionManifest = Record<
  string,
  Record<
    string,
    {
      kind: "query" | "mutation";
      placement: "replicated" | "remote";
      visibility: "public" | "internal";
    }
  >
>;

/** Runtime table summary exposed to devtools. @internal */
export interface RunnerDevtoolsTable {
  name: string;
  rowCount: number;
  system: boolean;
}

/** Runtime table page exposed to devtools. @internal */
export interface RunnerDevtoolsRows {
  cursor: string | null;
  isDone: boolean;
  rows: Record<string, unknown>[];
  table: string;
}

/** Runtime schema table exposed to devtools. @internal */
export interface RunnerDevtoolsSchemaTable {
  indexes: Array<{ fields: string[]; name: string }>;
  name: string;
}

/** Runtime storage snapshot exposed to devtools. @internal */
export interface RunnerDevtoolsStorage {
  crdtHeads: Array<{ field: string; headSeq: number; id: string; table: string }>;
  dirtyHeads: DirtyHeadDebug[];
  files: Record<string, unknown>[];
  idMappings: Record<string, unknown>[];
  projections: Record<string, unknown>[];
  uploads: Record<string, unknown>[];
}

/** Runtime scheduler snapshot exposed to devtools. @internal */
export interface RunnerDevtoolsScheduler {
  jobs: ScheduledJob[];
}

/** Runtime function metadata exposed to devtools. @internal */
export interface RunnerDevtoolsFunctionArg {
  name: string;
  optional: boolean;
  placeholder: unknown;
  type: string;
}

/** Runtime function metadata exposed to devtools. @internal */
export interface RunnerDevtoolsFunction {
  args: RunnerDevtoolsFunctionArg[];
  kind: "query" | "mutation" | "action";
  module: string;
  name: string;
  path: string;
  visibility: "public" | "internal";
}

/** Runtime status exposed to devtools. @internal */
export interface RunnerDevtoolsRuntime {
  role: string;
  tableCount: number;
  /** Retained-result cache observability (Cut 7 §7). */
  cacheEntries?: number;
  cacheServes?: number;
  cacheMisses?: number;
  foreignEvaluations?: number;
}

/** Runtime snapshot exposed to devtools. @internal */
export interface RunnerDevtoolsSnapshot {
  data: RunnerDevtoolsTable[];
  functions: RunnerDevtoolsFunction[];
  runtime: RunnerDevtoolsRuntime;
  scheduler: RunnerDevtoolsScheduler;
  schema: RunnerDevtoolsSchemaTable[];
  storage: RunnerDevtoolsStorage;
}

/** Internal devtools requests that cross the browser worker protocol. @internal */
export type RunnerDevtoolsRequest =
  | { kind: "snapshot" }
  | { cursor?: string | null; kind: "listRows"; limit?: number; table: string }
  | { fields: Record<string, unknown>; id: string; kind: "patchDocument"; table: string }
  | { id: string; kind: "deleteDocument"; table: string }
  | { kind: "clearData" };

/** Execution route and hosted arguments resolved before a public client operation starts. */
export type RunnerRoute =
  | { execution: "local"; placement: "replicated" | "local" }
  | { execution: "hosted"; args: Record<string, unknown> }
  | { execution: "blocked" };

/**
 * JavaScript Convex execution runner.
 *
 * @internal
 */
export interface Runner {
  readonly identity: {
    read(): Promise<{ identity: UserIdentity | null; identityKey: string } | undefined>;
    write(identityKey: string): Promise<void>;
  };
  /**
   * Whether this runtime owns device-only modules from a configured local root. Clients read it to
   * tell an unconfigured app apart from an unregistered device-only function.
   */
  readonly localConfigured: boolean;
  /**
   * Settles once every device-only module has been imported and every registration in it carries
   * its namespaced name. Absent when the runtime was built without device-only modules.
   */
  readonly localReady?: Promise<void>;
  route(
    ref: FunctionReference,
    args: Record<string, unknown>,
    kind: "query" | "mutation" | "action",
  ): Promise<RunnerRoute>;
  runQuery(
    ref: FunctionReference,
    args?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<unknown>;
  runMutation(
    ref: FunctionReference,
    args?: Record<string, unknown>,
    options?: RunMutationOptions,
  ): Promise<unknown>;
  runAction(
    ref: FunctionReference,
    args?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<unknown>;
  handleUpload(url: string, blob: Blob): Promise<{ storageId: string }>;
  devtools(request: RunnerDevtoolsRequest): Promise<unknown>;
  invalidate(changedTables: string[], source: "local" | "remote"): void;
  rerunResults(keys: string[]): void;
  readonly remote?: {
    readonly identity: {
      read(): Promise<RemoteIdentity | undefined>;
    };
    readonly scope: {
      write(): Promise<void>;
    };
    readonly wake?: {
      subscribe(listener: () => void): StopOnUpdate;
    };
  };
  subscribeEvents?(listener: DiagnosticEventListener): StopOnUpdate;
  /** Browser-worker-only terminal settlement transport; never exposed by the public client. */
  subscribeRemoteSettlements?(
    listener: (
      event: EmbeddedRemoteEvent,
      settlements: readonly RemoteMutationSettlement[],
    ) => void,
  ): StopOnUpdate;
  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: OnUpdateCallback,
    onError?: OnUpdateErrorCallback,
    options?: RunOptions,
  ): StopOnUpdate;
}

/**
 * The canonical identity of a watched query inside the runner: function name plus canonical args
 * JSON, used for the runner's watcher dedup. The browser leader keys cross-client watches with its
 * own variant (`coordinator/leader.ts`) that additionally folds in the auth context — keep the two
 * separate; they are not interchangeable.
 *
 * @internal
 */
function watchKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, args: convexToJson(args as Value) });
}

/**
 * The key a watched query invalidates on. Today this is a table name; the alias is the seam for
 * finer-grained dependency tracking later.
 *
 * @internal
 */
export type InvalidationKey = string;

interface RuntimeScope {
  instancePath: ComponentInstancePath;
  modules: ModuleMap;
  schema: Schema;
}

interface ScopedMutationTransaction {
  oneDocWrite(): OneDocWriteCommit | undefined;
  revisionRestore(expectation: RevisionRestoreExpectation): void;
  restore(snapshot: ScopedMutationSnapshot): void;
  snapshot(): ScopedMutationSnapshot;
  toBatch(watching?: boolean): ScopedMutationBatch;
  validateRevisionRestores(): Promise<void>;
  writer(scope: RuntimeScope): ReturnType<typeof createWriter>;
}

interface RevisionRestoreExpectation {
  deleted: boolean;
  rowId: string;
  table: string;
  value?: Record<string, unknown>;
}

interface ScopedMutationBatch {
  batch: WriteBatch;
  dataOnlyDocIds?: Map<InvalidationKey, Set<string>>;
  rootBatch: WriteBatch;
  touchedKeys: string[];
}

interface ScopedMutationSnapshot {
  revisionRestores: number;
  writers: Map<ComponentInstancePath, ReturnType<ReturnType<typeof createWriter>["snapshot"]>>;
}

interface PendingNotification {
  dataOnlyDocIds: Map<InvalidationKey, Set<string>>;
  tables: Set<InvalidationKey>;
}

/**
 * One CRDT op on the push wire: the client-produced Loro update bytes for one collaborative field,
 * base64 on the JSON envelope. The kind is the collaborative register the field is declared as.
 *
 * @internal
 */
type ReadWitness =
  | {
      kind: "point";
      table: string;
      rowId: string;
      plainHash: string;
      crdt: Extract<BaseVersion, { id: string }>["crdt"];
    }
  | {
      kind: "range";
      table: string;
      index: string;
      equality: Extract<BaseVersion, { index: string }>["equality"];
      limit?: number;
      lower?: ReadBound;
      upper?: ReadBound;
      order: "asc" | "desc";
      membersHash: string;
      members: string[];
      memberHashes: string[];
    };

function readWitness(base: BaseVersion): ReadWitness {
  if ("id" in base) {
    return {
      kind: "point",
      table: base.table,
      rowId: base.id,
      plainHash: base.contentHash,
      crdt: base.crdt,
    };
  }
  return {
    kind: "range",
    table: base.table,
    index: base.index,
    equality: base.equality,
    limit: base.limit,
    lower: base.lower,
    upper: base.upper,
    order: base.order,
    membersHash: base.membersHash,
    members: base.members,
    memberHashes: base.memberHashes,
  };
}

async function resultHash(
  store: RuntimeStorageWriter,
  fn: RunnableFunction,
  args: unknown,
  value: unknown,
  mutationId: string,
  freshIds: Array<{ table: string; id: string }>,
  schedules: string[],
  uploads: string[],
  crdtFields: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<string> {
  const inserts = freshIds.map((fresh, ordinal) => ({ ...fresh, ordinal }));
  const inserted = new Set(freshIds.map((fresh) => fresh.id));
  const references = validatorIdReferences(fn.returns ?? fn.returnsJson, value);
  const hostedIds: Record<string, string> = {};
  for (const reference of references) {
    const id = pointerRead(value, reference);
    if (id === undefined || inserted.has(id)) continue;
    const mapping = await store.id.read(reference.table, id);
    if (mapping?.mapping === "mapped") hostedIds[reference.path] = mapping.convexId;
  }
  return await hashValue(
    normalizeMutationResult(
      value,
      mutationId,
      inserts,
      schedules,
      uploads,
      references,
      hostedIds,
      crdtFields,
      validatorIdValues(fn.args ?? fn.argsJson, args),
    ),
  );
}

function pointerRead(value: unknown, reference: ValidatorIdReference): string | undefined {
  if (reference.path === "") return typeof value === "string" ? value : undefined;
  let current = value;
  for (const raw of reference.path.slice(1).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

async function crdtEffects(batch: WriteBatch): Promise<Record<string, unknown>[]> {
  return await Promise.all(
    (batch.crdtOps ?? []).map(async (op) => {
      const docWrite = batch.docWrites.find(
        (candidate) => candidate.table === op.table && candidate.id === op.id,
      );
      if (!docWrite) throw new Error(`CRDT effect target is missing: ${op.table}/${op.id}`);
      const projection = fieldValue(docWrite.data, op.field);
      const kind = op.kind === "count.add" ? "count" : op.kind.startsWith("text.") ? "text" : "set";
      return {
        table: op.table,
        rowId: op.id,
        field: op.field,
        kind,
        baseSeq: 0,
        projection,
        projectionHash: await hashValue(projection),
        payload: { $bytes: "" },
      };
    }),
  );
}

function afterImages(batch: WriteBatch): Array<
  | {
      content: "value";
      table: string;
      rowId: string;
      value: unknown;
      creationTime: number;
    }
  | { content: "deleted"; table: string; rowId: string }
> {
  const candidates = new Map<
    string,
    | {
        content: "value";
        table: string;
        rowId: string;
        value: unknown;
        creationTime: number;
      }
    | { content: "deleted"; table: string; rowId: string }
  >();
  const crdtOnly = new Set((batch.crdtOnlyIds ?? []).map((row) => `${row.table}\u0000${row.id}`));
  for (const docWrite of batch.docWrites) {
    if (crdtOnly.has(`${docWrite.table}\u0000${docWrite.id}`)) continue;
    candidates.set(`${docWrite.table}\u0000${docWrite.id}`, {
      content: "value",
      table: docWrite.table,
      rowId: docWrite.id,
      // The durable push envelope is JSON. Encode Convex leaves explicitly so BigInts and the
      // pending commit timestamp never invoke their throwing JavaScript `toJSON` methods.
      value: convexToJson(docWrite.data as Value),
      creationTime: docWrite.creationTime,
    });
  }
  for (const deleted of batch.deletes) {
    candidates.set(`${deleted.table}\u0000${deleted.id}`, {
      content: "deleted",
      table: deleted.table,
      rowId: deleted.id,
    });
  }
  return Array.from(candidates.values());
}

function fieldValue(document: Record<string, unknown>, field: string): unknown {
  let value: unknown = document;
  for (const segment of field.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/**
 * Creates a local JavaScript Convex execution runner backed by embedded storage.
 *
 * @internal
 */
export function createRunner(
  modules: ModuleMap,
  store: RuntimeStorageWriter,
  storeSchema: StoreSchema,
  options: RunnerOptions = {},
): Runner {
  const rootScope = createRootScope(modules, storeSchema);
  const runnerMode = options.mode ?? "active";
  const remoteEnabled = options.remote === true;
  const moduleGraphHash = options.moduleGraphHash ?? storeSchema.hash ?? "local";
  const deferNotify = options.deferNotify ?? ((run: () => void) => run());
  const allTables = new Set<InvalidationKey>(
    [...rootScope.schema.keys()].map((table) => invalidationKey(rootScope.instancePath, table)),
  );
  const crdtFieldsByTable: CrdtFieldsByTable = new Map(
    storeSchema.tables.map((table) => [
      table.name,
      new Set((table.crdtFields ?? []).map((field) => field.field)),
    ]),
  );
  const moduleCache = new Map<string, Promise<ModuleExports>>();
  const functionCache = new Map<string, Promise<RunnableFunction>>();
  const localFunctions = new Map<string, RunnableFunction>();
  const localConfigured = Object.keys(options.localModules ?? {}).length > 0;
  const localReady = options.localModules
    ? ingestLocalModules(options.localModules, localFunctions, runnerMode)
    : undefined;
  if (localReady) void localReady.catch(() => undefined);
  const watchers = new Map<string, Watcher>();
  const uploadUrls = new Map<string, UploadUrl>();
  const objectUrls = new Map<string, string>();
  const eventListeners = new Set<DiagnosticEventListener>();
  const remoteWakeListeners = new Set<() => void>();
  let nextSpanId = 1;
  let mutationQueue: Promise<void> | null = null;
  let entropySpan: Promise<void> | null = null;
  let notifyQueued = false;
  let pendingNotify = emptyPendingNotification();
  let remoteScopeKey: string | null = null;
  let remoteScopeVersion = 0;
  let wakeScheduler: SchedulerPump["wake"] = () => undefined;
  const cacheCounters = {
    cacheEntries: new Set<string>(),
    cacheServes: 0,
    cacheMisses: 0,
    foreignEvaluations: 0,
  };

  const hasEventListeners = (): boolean =>
    eventListeners.size > 0 ||
    options.hasEventListeners?.() === true ||
    (options.hasEventListeners === undefined && options.emit !== undefined);

  const emit = (event: DiagnosticEvent): void => {
    if (!hasEventListeners()) return;
    // Diagnostics observe runtime state; they never participate in the transaction that produced
    // it. In particular, a storage commit may already be durable when its data event is emitted.
    // Letting an observer throw here would report that successful mutation as failed and invite a
    // caller to replay it.
    callSafely(() => options.emit?.(event));
    for (const listener of Array.from(eventListeners)) {
      callSafely(() => listener(event));
    }
  };
  const runSpan = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (!hasEventListeners()) return run();
    const id = `runner:${nextSpanId}`;
    nextSpanId += 1;
    const startedAt = getTimerTime();
    emit({ at: startedAt, id, name, phase: "start", type: "span" });
    try {
      const result = await run();
      const endedAt = getTimerTime();
      emit({
        at: endedAt,
        durationMs: getElapsedTime(startedAt),
        id,
        name,
        phase: "finish",
        type: "span",
      } satisfies EmbeddedSpanEvent);
      return result;
    } catch (error) {
      const endedAt = getTimerTime();
      emit({
        at: endedAt,
        durationMs: getElapsedTime(startedAt),
        error: error instanceof Error ? error.message : String(error),
        id,
        name,
        phase: "finish",
        type: "span",
      } satisfies EmbeddedSpanEvent);
      throw error;
    }
  };

  const resolveFunction = async (scope: RuntimeScope, name: string): Promise<RunnableFunction> => {
    if (!name.startsWith(LOCAL_FUNCTION_PREFIX) || scope.instancePath !== ROOT_INSTANCE) {
      return await loadFunction(
        scope.modules,
        moduleCache,
        functionCache,
        scope.instancePath,
        name,
      );
    }
    if (localReady) await localReady;
    const local = localFunctions.get(name);
    if (!local) {
      throw new Error(
        localConfigured
          ? `${name} is not registered under the configured local directories.`
          : LOCAL_UNCONFIGURED_ERROR,
      );
    }
    return local;
  };

  const runQuery = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
    scope = rootScope,
    tracker?: ReadTracker,
    db?: DatabaseReader<GenericDataModel>,
    tx?: ScopedMutationTransaction,
    options: RunOptions = {},
  ): Promise<unknown> => {
    while (tx === undefined && entropySpan) await entropySpan;
    const resolved = resolveFunctionAddress(ref, scope);
    const scopeStore = namespaceStore(store, resolved.scope.instancePath);
    const fn = await resolveFunction(resolved.scope, resolved.name);
    if (fn.kind !== "query") throw kindMismatch(fn, ref, "query");
    ensureVisible(fn, ref, options);
    ensureSamePlacement(fn, ref, options.callerPlacement);
    const txDb = tx?.writer(resolved.scope).db;
    const activeDb =
      txDb ??
      (db && resolved.scope.instancePath === scope.instancePath
        ? db
        : createReader<GenericDataModel>(
            scopeStore,
            resolved.scope.schema,
            scopedTracker(resolved.scope, tracker),
            fn.placement === "local" ? "device" : "replicated",
          ));
    const checked = await resolveQueryArgs(scopeStore, fn, args);
    let storageService: StorageReaderService | undefined;
    const result = await fn.handler(
      {
        auth: authService(options.auth ?? null),
        db: activeDb,
        meta: {},
        runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
          runQuery(childRef, childArgs, resolved.scope, tracker, activeDb, tx, {
            ...options,
            allowInternal: true,
            callerPlacement: fn.placement,
          }),
        get storage(): StorageReaderService {
          if (fn.placement === "local") {
            throw new Error("Local functions cannot access file storage.");
          }
          return (storageService ??= createStorageService(
            namespaceStore(store, resolved.scope.instancePath),
            uploadUrls,
            objectUrls,
            "reader",
            emit,
          ));
        },
      },
      checked,
    );
    // A query nested inside a mutation participates in that mutation's commit and may therefore
    // carry its pending timestamp through a staged index read. A top-level query has no commit
    // boundary and continues to reject the placeholder.
    return validateReturn(fn, result, tx !== undefined);
  };

  const createMutationTransaction = (
    placement: "replicated" | "local",
    readSetTracker?: ReadTracker,
  ): ScopedMutationTransaction => {
    const writers = new Map<ComponentInstancePath, ReturnType<typeof createWriter>>();
    const revisionRestores: RevisionRestoreExpectation[] = [];
    const writer = (scope: RuntimeScope): ReturnType<typeof createWriter> => {
      let existing = writers.get(scope.instancePath);
      if (!existing) {
        existing = createWriter<GenericDataModel>(
          namespaceStore(store, scope.instancePath),
          scope.schema,
          scope.instancePath === ROOT_INSTANCE ? readSetTracker : undefined,
          placement === "local" ? "device" : "replicated",
        );
        writers.set(scope.instancePath, existing);
      }
      return existing;
    };
    return {
      oneDocWrite() {
        if (writers.size !== 1) return undefined;
        return writers.get(ROOT_INSTANCE)?.oneDocWrite();
      },
      revisionRestore(expectation) {
        revisionRestores.push(expectation);
      },
      restore(snapshot) {
        for (const instancePath of writers.keys()) {
          if (!snapshot.writers.has(instancePath)) writers.delete(instancePath);
        }
        for (const [instancePath, writerSnapshot] of snapshot.writers) {
          writers.get(instancePath)?.restore(writerSnapshot);
        }
        revisionRestores.length = snapshot.revisionRestores;
      },
      snapshot() {
        return {
          revisionRestores: revisionRestores.length,
          writers: new Map([...writers].map(([instancePath, w]) => [instancePath, w.snapshot()])),
        };
      },
      toBatch(watching = false) {
        if (writers.size === 1) {
          const rootWriter = writers.get(ROOT_INSTANCE);
          if (rootWriter) {
            const batch = rootWriter.toBatch();
            return {
              batch,
              dataOnlyDocIds: watching ? rootBatchDataOnlyDocIds(batch) : undefined,
              rootBatch: batch,
              touchedKeys: watching ? rootBatchInvalidationKeys(batch) : [],
            };
          }
        }
        const touchedKeys = new Set<string>();
        const crdtOps: NonNullable<WriteBatch["crdtOps"]> = [];
        const crdtOnlyIds: NonNullable<WriteBatch["crdtOnlyIds"]> = [];
        const crdtRestores: NonNullable<WriteBatch["crdtRestores"]> = [];
        const docWrites: WriteBatch["docWrites"] = [];
        const deletes: WriteBatch["deletes"] = [];
        const freshIds: NonNullable<WriteBatch["freshIds"]> = [];
        const dataOnlyIds: NonNullable<WriteBatch["dataOnlyIds"]> = [];
        const idMappings: NonNullable<WriteBatch["idMappings"]> = [];
        const localFieldWrites: NonNullable<WriteBatch["localFieldWrites"]> = [];
        const localFieldDeletes: NonNullable<WriteBatch["localFieldDeletes"]> = [];
        let pendingCommitTs = false;
        let rootBatch: WriteBatch = { deletes: [], docWrites: [] };
        for (const [instancePath, w] of writers) {
          const batch = w.toBatch();
          pendingCommitTs ||= batch.pendingCommitTs === true;
          if (instancePath === ROOT_INSTANCE) rootBatch = batch;
          if (watching) {
            for (const key of batchInvalidationKeys(instancePath, batch)) touchedKeys.add(key);
          }
          const namespaced = namespaceBatch(instancePath, batch);
          docWrites.push(...namespaced.docWrites);
          deletes.push(...namespaced.deletes);
          crdtOps.push(...(namespaced.crdtOps ?? []));
          crdtOnlyIds.push(...(namespaced.crdtOnlyIds ?? []));
          crdtRestores.push(...(namespaced.crdtRestores ?? []));
          freshIds.push(...(namespaced.freshIds ?? []));
          dataOnlyIds.push(...(namespaced.dataOnlyIds ?? []));
          idMappings.push(...(namespaced.idMappings ?? []));
          localFieldWrites.push(...(namespaced.localFieldWrites ?? []));
          localFieldDeletes.push(...(namespaced.localFieldDeletes ?? []));
        }
        return {
          batch: {
            crdtOnlyIds,
            crdtOps,
            crdtRestores,
            dataOnlyIds,
            deletes,
            freshIds,
            idMappings,
            localFieldWrites,
            localFieldDeletes,
            docWrites,
            pendingCommitTs,
          },
          rootBatch,
          touchedKeys: watching ? [...touchedKeys] : [],
        };
      },
      async validateRevisionRestores() {
        if (revisionRestores.length === 0) return;
        const db = writer(rootScope).db;
        for (const expectation of revisionRestores) {
          const current = (await db.get(
            expectation.table as never,
            expectation.rowId as never,
          )) as Record<string, unknown> | null;
          if (expectation.deleted) {
            if (current !== null) {
              throw new Error("rev.restore must be followed by the matching document delete.");
            }
            continue;
          }
          if (current === null || !equals(documentValue(current), expectation.value)) {
            throw new Error("rev.restore must be followed by the matching document replace.");
          }
        }
      },
      writer,
    };
  };

  const withEntropySpan = async <T>(
    time: number,
    seed: string,
    run: () => T | Promise<T>,
  ): Promise<T> => {
    let release!: () => void;
    const span = new Promise<void>((resolve) => (release = resolve));
    entropySpan = span;
    try {
      return await withEntropy(time, seed, run);
    } finally {
      release();
      if (entropySpan === span) entropySpan = null;
    }
  };

  const runMutationDirect = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
    scope = rootScope,
    options: RunMutationOptions = {},
    tx?: ScopedMutationTransaction,
    argsAreNormalized = false,
  ): Promise<unknown> => {
    const timing =
      !tx && options.onTiming
        ? {
            argsEncodeMs: 0,
            batchMs: 0,
            beginMs: 0,
            commitMs: 0,
            handlerMs: 0,
            mutationId: options.mutationId !== undefined,
            notifyMs: 0,
            prepareMs: 0,
            resultEncodeMs: 0,
            totalMs: 0,
          }
        : undefined;
    const timingStartedAt = timing ? getTimerTime() : 0;
    let timingPhaseStartedAt = timingStartedAt;
    const resolved = resolveFunctionAddress(ref, scope);
    const fn = await resolveFunction(resolved.scope, resolved.name);
    if (fn.kind !== "mutation") throw kindMismatch(fn, ref, "mutation");
    ensureVisible(fn, ref, options);
    ensureSamePlacement(fn, ref, options.callerPlacement);
    if (fn.placement === "remote") {
      throw new Error(
        `${describeRef(ref)} is remote-only and cannot execute in the local runtime.`,
      );
    }
    const readSetCollector = !tx && options.pushCall ? createReadSetCollector() : undefined;
    const root =
      tx ??
      createMutationTransaction(
        fn.placement === "local" ? "local" : "replicated",
        readSetCollector?.tracker,
      );
    const snapshot = tx?.snapshot();
    const revisionReplaySnapshot = options.revisionReplay
      ? {
          checkpointCount: options.revisionReplay.checkpoints.length,
          nextCheckpointOrdinal: options.revisionReplay.nextCheckpointOrdinal,
          nextOrdinal: options.revisionReplay.nextOrdinal,
        }
      : undefined;
    const resolvedWriter = root.writer(resolved.scope);
    const componentRevision =
      resolved.scope.instancePath === "embedded" && resolved.name.startsWith("rev:")
        ? resolved.name.slice(4)
        : undefined;
    const captureRevisionSnapshots = async (
      revision: Record<string, unknown>,
    ): Promise<CrdtSnapshot[]> => {
      const table = String(revision.table);
      const rowId = String(revision.rowId);
      const batch = root.toBatch().rootBatch;
      return await store.doc.crdt.snapshot.read(table, rowId, batch.crdtOps ?? []);
    };
    if (componentRevision === "create" && options.revisionReplay) {
      await validateRevisionCreate(root.writer(rootScope).db, args);
      const ordinal = options.revisionReplay.nextOrdinal;
      const checkpointOrdinal = options.revisionReplay.nextCheckpointOrdinal;
      const snapshots = await captureRevisionSnapshots(args);
      options.revisionReplay.checkpoints.push({
        ordinal: checkpointOrdinal,
        operation: "create",
        rowId: String(args.rowId),
        table: String(args.table),
        snapshots,
      });
      options.revisionReplay.nextCheckpointOrdinal += 1;
      const replay = {
        createdAt: options.revisionReplay.createdAt,
        mutationId: options.revisionReplay.mutationId,
        ordinal,
      };
      options.revisionReplay.nextOrdinal += 1;
      return await runMutationDirect(
        embeddedComponentReference("rev/createReplay"),
        { ...args, replay, snapshots },
        rootScope,
        { ...options, allowInternal: true },
        tx,
        argsAreNormalized,
      );
    }
    const checked = await resolveMutationArgs(
      namespaceStore(store, resolved.scope.instancePath),
      fn,
      args,
      argsAreNormalized,
      tx !== undefined,
    );
    if (componentRevision === "create") {
      await validateRevisionCreate(root.writer(rootScope).db, checked);
      const snapshots = await captureRevisionSnapshots(checked);
      return await runMutationDirect(
        embeddedComponentReference("rev/createLocal"),
        { ...checked, snapshots },
        rootScope,
        { ...options, allowInternal: true },
        tx,
      );
    } else if (componentRevision === "retain") {
      const snapshots = await captureRevisionSnapshots(checked);
      if (options.revisionReplay) {
        options.revisionReplay.checkpoints.push({
          ordinal: options.revisionReplay.nextCheckpointOrdinal,
          operation: "retain",
          rowId: String(checked.rowId),
          table: String(checked.table),
          snapshots,
        });
        options.revisionReplay.nextCheckpointOrdinal += 1;
      }
      return await runMutationDirect(
        embeddedComponentReference("rev/retainLocal"),
        { ...checked, snapshots },
        rootScope,
        { ...options, allowInternal: true },
        tx,
      );
    }
    const displaced =
      componentRevision === "restore"
        ? await revisionCurrent(root.writer(rootScope).db, checked)
        : undefined;
    if (componentRevision === "restore" && displaced !== undefined) {
      const target = (await runQuery(
        embeddedComponentReference("rev/get"),
        checked,
        rootScope,
        undefined,
        undefined,
        root,
        { ...options, allowInternal: true },
      )) as RevisionRestoreExpectation | null;
      if (
        target &&
        (target.deleted !== displaced.deleted || !equals(target.value, displaced.value))
      ) {
        await runMutationDirect(
          embeddedComponentReference("rev/retain"),
          { ...displaced, origin: "displaced" },
          rootScope,
          { ...options, allowInternal: true },
          root,
        );
      }
    }
    if (timing) timing.prepareMs = getTimerTime() - timingPhaseStartedAt;
    timingPhaseStartedAt = timing ? getTimerTime() : 0;
    const recordsMutation =
      options.mutationId !== undefined &&
      !(options.mutationIsFresh && options.pushCall !== undefined);
    const encodedMutationArgs = recordsMutation ? encode(checked) : undefined;
    if (timing) {
      timing.argsEncodeMs = getTimerTime() - timingPhaseStartedAt;
      timingPhaseStartedAt = getTimerTime();
    }
    if (!tx && options.mutationId && store.mutation && !options.mutationIsFresh) {
      const existing = await store.mutation.write({
        args: encodedMutationArgs!,
        mutationId: options.mutationId,
        name: resolved.name,
      });
      if (timing) {
        timing.beginMs = getTimerTime() - timingPhaseStartedAt;
        timingPhaseStartedAt = getTimerTime();
      }
      options.onAccepted?.(options.mutationId);
      if (existing.status === "committed") {
        // The result was already validated when first committed; returning the committed value
        // keeps local mutation retries idempotent without re-running the handler.
        if (timing) {
          timing.totalMs = getTimerTime() - timingStartedAt;
          options.onTiming?.(timing);
        }
        return existing.result === undefined ? null : decode(existing.result);
      }
      if (existing.status === "failed") {
        throw decodeError(existing.error ?? `mutation failed: ${options.mutationId}`);
      }
    } else if (!tx && options.mutationId) {
      options.onAccepted?.(options.mutationId);
    }
    if (timing && timing.beginMs === 0) timingPhaseStartedAt = getTimerTime();
    let validated: unknown;
    const pendingSchedules: Array<() => Promise<void>> = [];
    const pendingScheduleRows: ScheduledJob[] = [];
    const scheduledJobs: string[] = [];
    const generatedUploadUrls: string[] = [];
    let schedulerService: SchedulerService | undefined;
    let storageService: StorageWriterService | undefined;
    const pushEnvelopeTimeHlc = options.pushCall ? store.clock.read() : undefined;
    const revisionReplay =
      options.revisionReplay ??
      (pushEnvelopeTimeHlc !== undefined && options.mutationId
        ? {
            createdAt: pushEnvelopeTimeHlc,
            mutationId: options.mutationId,
            nextCheckpointOrdinal: 0,
            nextOrdinal: 0,
            checkpoints: [],
          }
        : undefined);
    try {
      const runHandler = () =>
        fn.handler(
          {
            auth: authService(options.auth ?? null),
            db: resolvedWriter.db,
            meta: {},
            runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
              runQuery(childRef, childArgs, resolved.scope, undefined, resolvedWriter.db, root, {
                ...options,
                allowInternal: true,
                callerPlacement: fn.placement,
              }),
            runSnapshotQuery: (
              childRef: FunctionReference,
              childArgs: Record<string, unknown> = {},
            ) =>
              runQuery(childRef, childArgs, resolved.scope, undefined, undefined, root, {
                ...options,
                allowInternal: true,
                callerPlacement: fn.placement,
              }),
            runMutation: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
              fn.placement === "replicated" && extractReferencePath(childRef) === null
                ? Promise.reject(
                    new Error(
                      "Embedded replicated mutations cannot call nested app mutations until their writes can join the parent replay capture.",
                    ),
                  )
                : runMutationDirect(
                    childRef,
                    childArgs,
                    resolved.scope,
                    {
                      ...options,
                      allowInternal: true,
                      callerPlacement: fn.placement,
                      revisionReplay,
                    },
                    // Same-placement is checked by the child before its handler runs.
                    root,
                  ),
            get scheduler(): SchedulerService {
              if (fn.placement === "local") {
                throw new Error("Local functions cannot schedule functions.");
              }
              return (schedulerService ??= createSchedulerService(
                store,
                emit,
                {
                  kind: functionKind,
                  runMutation: (childRef, childArgs = {}) =>
                    enqueueMutation(() =>
                      runMutationDirect(childRef, childArgs, resolved.scope, {
                        ...options,
                        allowInternal: true,
                        callerPlacement: fn.placement,
                      }),
                    ),
                  runQuery: (childRef, childArgs = {}) =>
                    runQuery(
                      childRef,
                      childArgs,
                      resolved.scope,
                      undefined,
                      resolvedWriter.db,
                      root,
                      {
                        ...options,
                        allowInternal: true,
                        callerPlacement: fn.placement,
                      },
                    ),
                },
                remoteEnabled,
                wakeScheduler,
                tx ? undefined : pendingSchedules,
                scheduledJobs,
                remoteEnabled ? undefined : pendingScheduleRows,
              ));
            },
            get storage(): StorageWriterService {
              if (fn.placement === "local") {
                throw new Error("Local functions cannot access file storage.");
              }
              return (storageService ??= createStorageService(
                namespaceStore(store, resolved.scope.instancePath),
                uploadUrls,
                objectUrls,
                "writer",
                emit,
                generatedUploadUrls,
              ));
            },
          },
          checked,
        );
      const result = await (!tx && options.pushCall && pushEnvelopeTimeHlc !== undefined
        ? withEntropySpan(pushEnvelopeTimeHlc, options.pushCall.rngSeed, runHandler)
        : runHandler());
      validated = validateReturn(fn, result, true);
      if (componentRevision === "restore") {
        const revision = validated as RevisionRestoreExpectation;
        const snapshots = (await runQuery(
          embeddedComponentReference("rev/restoreRead"),
          checked,
          rootScope,
          undefined,
          undefined,
          root,
          { ...options, allowInternal: true },
        )) as Array<{
          field: string;
          kind: "text" | "count" | "set";
          headSeq: number;
          projectionHash: string;
          bytes: ArrayBuffer;
          hash: string;
        }>;
        const restoredFields = new Set(snapshots.map((snapshot) => snapshot.field));
        for (const snapshot of snapshots) {
          root.writer(rootScope).crdtRestore({
            table: revision.table,
            id: revision.rowId,
            ...snapshot,
          });
        }
        const table = storeSchema.tables.find((candidate) => candidate.name === revision.table);
        for (const field of table?.crdtFields ?? []) {
          if (restoredFields.has(field.field)) continue;
          root.writer(rootScope).crdtRestore({
            table: revision.table,
            id: revision.rowId,
            field: field.field,
            kind: field.kind,
            headSeq: 0,
            projectionHash: "",
            bytes: new ArrayBuffer(0),
            hash: "",
          });
        }
        root.writer(rootScope).revisionRestore(revision);
        root.revisionRestore(revision);
      }
      if (timing) {
        timing.handlerMs = getTimerTime() - timingPhaseStartedAt;
        timingPhaseStartedAt = getTimerTime();
      }
    } catch (error) {
      // Deterministic failure (handler threw or the return validator rejected): it reproduces on
      // replay, so record it as the mutation's terminal `failed` outcome (preserving ConvexError).
      if (snapshot) root.restore(snapshot);
      if (!tx && options.mutationId && store.mutation && recordsMutation) {
        if (options.mutationIsFresh) {
          await store.mutation
            .write(
              {
                args: encodedMutationArgs!,
                mutationId: options.mutationId,
                name: resolved.name,
              },
              { fresh: true },
            )
            .catch(() => undefined);
        }
        await store.mutation.fail(options.mutationId, encodeError(error)).catch(() => undefined);
      }
      throw error;
    }
    if (tx) return validated;
    try {
      await root.validateRevisionRestores();
      const watching = watchers.size > 0;
      const localSchedules = !remoteEnabled && pendingScheduleRows.length > 0;
      const canCommitOneDocWrite =
        !watching &&
        !hasEventListeners() &&
        !!store.commitOneDocWrite &&
        !options.pushCall &&
        !localSchedules &&
        !hasPendingCommitTs(validated);
      const oneDocWrite = canCommitOneDocWrite ? root.oneDocWrite() : undefined;
      const batchInfo = oneDocWrite ? undefined : root.toBatch(watching);
      const resultHasCommitTs = hasPendingCommitTs(validated);
      const batchHasCommitTs = batchInfo?.batch.pendingCommitTs === true;
      const afterImagesHaveCommitTs =
        batchHasCommitTs === true &&
        batchInfo!.rootBatch.docWrites.some((write) => write.pendingCommitTs === true);
      const requiresCommitTs = resultHasCommitTs || batchHasCommitTs;
      if (timing) {
        timing.batchMs = getTimerTime() - timingPhaseStartedAt;
        timingPhaseStartedAt = getTimerTime();
      }
      const encodedMutationResult = recordsMutation ? encode(validated) : undefined;
      if (timing) {
        timing.resultEncodeMs = getTimerTime() - timingPhaseStartedAt;
        timingPhaseStartedAt = getTimerTime();
      }
      let pushEnvelopeJson: string | undefined;
      let pushEnvelopeNowMs: number | undefined;
      if (options.pushCall !== undefined && readSetCollector !== undefined) {
        const mutationId = options.mutationId;
        if (mutationId === undefined) {
          throw new Error("A remote push requires the local mutation ID.");
        }
        pushEnvelopeNowMs = pushEnvelopeTimeHlc ?? store.clock.read();
        pushEnvelopeJson = JSON.stringify({
          clientRuntime: {
            schemaHash: storeSchema.hash ?? "local",
            moduleGraphHash,
            contractId: CURRENT_WIRE_CONTRACT_ID,
          },
          mutationId,
          commitSeq: 0,
          localInserts: (batchInfo?.rootBatch.freshIds ?? []).map((fresh) => fresh.id),
          localSchedules: scheduledJobs,
          idPaths: idPathsForArgs(fn, checked),
          functionName: options.pushCall.fn,
          args: convexToJson(checked as Value),
          resultHash: await resultHash(
            store,
            fn,
            checked,
            validated ?? null,
            mutationId,
            batchInfo?.rootBatch.freshIds ?? [],
            scheduledJobs,
            generatedUploadUrls,
            new Map(
              storeSchema.tables.map((table) => [
                table.name,
                new Set((table.crdtFields ?? []).map((field) => field.field)),
              ]),
            ),
          ),
          argRefs: [],
          inserts: (batchInfo?.rootBatch.freshIds ?? []).map((fresh, ordinal) => ({
            mutationId,
            ordinal,
            table: fresh.table,
          })),
          reads: readSetCollector.readSet().map(readWitness),
          mutationTime: pushEnvelopeNowMs,
          randomSeed: options.pushCall.rngSeed,
          schedules: scheduledJobs.map((_, ordinal) => ({ mutationId, ordinal })),
          uploads: generatedUploadUrls.map((_, ordinal) => ({ mutationId, ordinal })),
          afterImages: afterImages(batchInfo!.rootBatch),
          crdt: await crdtEffects(batchInfo!.rootBatch),
          revisionCheckpoints: (revisionReplay?.checkpoints ?? []).map((checkpoint) => ({
            ...checkpoint,
            snapshots: checkpoint.snapshots.map((snapshot) => ({
              ...snapshot,
              bytes: convexToJson(snapshot.bytes),
            })),
          })),
        });
      }
      const commitOptions: CommitOptions =
        fn.placement === "local"
          ? { changes: "omit", source: "device", commitTs: requiresCommitTs }
          : options.mutationId === undefined
            ? { changes: "omit", mutation: "none", source: "local", commitTs: requiresCommitTs }
            : options.mutationIsFresh &&
                pushEnvelopeJson !== undefined &&
                pushEnvelopeNowMs !== undefined
              ? {
                  changes: "omit",
                  mutation: "push",
                  mutationId: options.mutationId,
                  push: {
                    json: pushEnvelopeJson,
                    nowMs: pushEnvelopeNowMs,
                    ...(afterImagesHaveCommitTs ? { afterImagesCommitTs: true as const } : {}),
                  },
                  source: "local",
                  commitTs: requiresCommitTs,
                }
              : {
                  changes: "omit",
                  mutation: "terminal",
                  mutationArgs: encodedMutationArgs!,
                  mutationIsFresh: options.mutationIsFresh === true,
                  mutationId: options.mutationId,
                  mutationName: resolved.name,
                  mutationResult: encodedMutationResult!,
                  ...(resultHasCommitTs ? { mutationResultCommitTs: true as const } : {}),
                  ...(pushEnvelopeJson === undefined || pushEnvelopeNowMs === undefined
                    ? {}
                    : {
                        push: {
                          json: pushEnvelopeJson,
                          nowMs: pushEnvelopeNowMs,
                          ...(afterImagesHaveCommitTs
                            ? { afterImagesCommitTs: true as const }
                            : {}),
                        },
                      }),
                  source: "local",
                  commitTs: requiresCommitTs,
                };
      if (localSchedules) batchInfo!.batch.schedules = pendingScheduleRows;
      const commit = oneDocWrite
        ? await store.commitOneDocWrite!(oneDocWrite, commitOptions)
        : await runSpan("storage.commit", () => store.commit(batchInfo!.batch, commitOptions));
      if (requiresCommitTs && commit.commitTs === undefined) {
        throw new Error(
          "storage committed db.vars.commitTs without returning its allocated timestamp",
        );
      }
      const resolvedResult =
        commit.commitTs === undefined ? validated : pendingCommitTsRead(validated, commit.commitTs);
      if (commit.commitTs !== undefined && batchInfo !== undefined) {
        resolveBatchCommitTs(batchInfo.batch, commit.commitTs);
      }
      if (timing) {
        timing.commitMs = getTimerTime() - timingPhaseStartedAt;
        timingPhaseStartedAt = getTimerTime();
      }
      if (hasEventListeners()) emitCommit(emit, commit, batchInfo!.batch, "local");
      if (pushEnvelopeJson !== undefined) {
        for (const listener of Array.from(remoteWakeListeners)) callSafely(listener);
      }
      if (watching) {
        scheduleNotify({
          dataOnlyDocIds: batchInfo!.dataOnlyDocIds ?? new Map(),
          tables: batchInfo!.dataOnlyDocIds ? new Set() : new Set(batchInfo!.touchedKeys),
        });
      }
      if (timing) {
        timing.notifyMs = getTimerTime() - timingPhaseStartedAt;
        timing.totalMs = getTimerTime() - timingStartedAt;
        callSafely(() => options.onTiming?.(timing));
      }
      // Local schedule rows joined the batch above; their remaining work is event delivery and
      // waking the pump. Remote schedule intent is separately durable and intentionally retried
      // by replication. Neither kind of post-commit work may make this committed mutation fail.
      for (const apply of pendingSchedules) await apply().catch(() => undefined);
      return resolvedResult;
    } catch (error) {
      // Transient storage failure: NOT recorded as `failed`, so the mutation can be retried. The
      // ledger entry stays pending and a later replay re-runs the handler.
      if (snapshot) root.restore(snapshot);
      if (revisionReplaySnapshot && options.revisionReplay) {
        options.revisionReplay.nextCheckpointOrdinal = revisionReplaySnapshot.nextCheckpointOrdinal;
        options.revisionReplay.nextOrdinal = revisionReplaySnapshot.nextOrdinal;
        options.revisionReplay.checkpoints.length = revisionReplaySnapshot.checkpointCount;
      }
      throw error;
    }
  };

  const runAction = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
    scope = rootScope,
    options: RunOptions = {},
  ): Promise<unknown> => {
    const resolved = resolveFunctionAddress(ref, scope);
    const fn = await resolveFunction(resolved.scope, resolved.name);
    if (fn.kind !== "action") throw new Error(`${describeRef(ref)} is not an action`);
    ensureVisible(fn, ref, options);
    ensureSamePlacement(fn, ref, options.callerPlacement);
    const checked = validateArgs(fn, args);
    let ledgerOpen = true;
    const ledger = createLedgerReader(
      store,
      () => ledgerOpen && runnerMode === "setup",
      deleteDoc,
      (table) => rootScope.schema.get(table)?.placement === "device",
    );
    try {
      const result = await fn.handler(
        {
          auth: authService(options.auth ?? null),
          ledger,
          meta: {},
          runAction: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            fn.placement === "local"
              ? Promise.reject(new Error("Local actions cannot call nested actions."))
              : runAction(childRef, childArgs, resolved.scope, {
                  ...options,
                  allowInternal: true,
                  callerPlacement: fn.placement,
                }),
          runMutation: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            enqueueMutation(() =>
              runMutationDirect(childRef, childArgs, resolved.scope, {
                ...options,
                allowInternal: true,
                callerPlacement: fn.placement,
              }),
            ),
          runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            runQuery(childRef, childArgs, resolved.scope, undefined, undefined, undefined, {
              ...options,
              allowInternal: true,
              callerPlacement: fn.placement,
            }),
          get scheduler() {
            if (fn.placement === "local") {
              throw new Error("Local actions cannot schedule functions.");
            }
            return createSchedulerService(
              store,
              emit,
              {
                kind: functionKind,
                runAction: (childRef, childArgs = {}) =>
                  runAction(childRef, childArgs, resolved.scope, {
                    ...options,
                    allowInternal: true,
                  }),
                runMutation: (childRef, childArgs = {}) =>
                  enqueueMutation(() =>
                    runMutationDirect(childRef, childArgs, resolved.scope, {
                      ...options,
                      allowInternal: true,
                    }),
                  ),
                runQuery: (childRef, childArgs = {}) =>
                  runQuery(childRef, childArgs, resolved.scope, undefined, undefined, undefined, {
                    ...options,
                    allowInternal: true,
                  }),
              },
              remoteEnabled,
              wakeScheduler,
            );
          },
          get storage() {
            if (fn.placement === "local") {
              throw new Error("Local actions cannot access file storage.");
            }
            return createStorageService(
              namespaceStore(store, resolved.scope.instancePath),
              uploadUrls,
              objectUrls,
              "action",
              emit,
            );
          },
        },
        checked,
      );
      return validateReturn(fn, result);
    } finally {
      // A setup handler may retain `ctx.ledger` in a closure. Its authority ends exactly when the
      // action settles, before candidate completion can bind or publish another generation.
      ledgerOpen = false;
    }
  };

  const functionKind = async (ref: FunctionReference): Promise<ScheduledFunctionKind> => {
    const resolved = resolveFunctionAddress(ref, rootScope);
    const fn = await resolveFunction(resolved.scope, resolved.name);
    if (fn.placement === "local") {
      throw new Error(`${describeRef(ref)} is a local function and cannot be scheduled.`);
    }
    if (fn.kind !== "mutation" && fn.kind !== "action") {
      throw new Error(`${describeRef(ref)} cannot be scheduled locally.`);
    }
    return fn.kind;
  };

  const rerun = (watcher: Watcher, notification?: PendingNotification): void => {
    if (!watchers.has(watcher.key)) return;
    if (watcher.pendingTables) {
      watcher.dirty = true;
      return;
    }
    void runSpan("watch.rerun", async () => {
      let tables = new Set<InvalidationKey>();
      let readDocIds = new Set<string>();
      try {
        do {
          watcher.dirty = false;
          watcher.missed = false;
          tables = new Set<InvalidationKey>();
          readDocIds = new Set<string>();
          watcher.pendingTables = tables;
          // Cut 7 §4.6: only a remote-capable runtime tracks read authority; local-only is authoritative
          // so `foreign` stays false and the results table is never consulted.
          const authority: ReadAuthority | undefined =
            store.remote?.scope !== undefined && watcher.remoteScope()
              ? createReadAuthority()
              : undefined;
          try {
            const value = await runQuery(
              watcher.ref,
              watcher.args,
              rootScope,
              {
                doc: (id) => readDocIds.add(id),
                table: (table) => tables.add(table),
                ...(authority === undefined ? {} : { authority }),
              },
              undefined,
              undefined,
              watcher.options,
            );
            if (!watchers.has(watcher.key)) return;
            const served = await serveWatch(watcher, value, authority);
            const changedDocIds = changedDocIdsForWatcher(watcher, notification);
            watcher.tables = tables;
            watcher.readDocIds = readDocIds;
            void publishRemoteScope();
            if (watcher.last?.kind !== "value" || !equals(watcher.last.value, served.value)) {
              watcher.last = { kind: "value", value: served.value };
              if (served.cache) emitCacheServe(tables);
              for (const subscriber of watcher.subscribers) {
                callSafely(() => subscriber.callback(served.value, { changedDocIds }));
              }
            }
          } finally {
            watcher.pendingTables = null;
          }
        } while (watcher.dirty && watchers.has(watcher.key));
      } catch (error) {
        if (!watchers.has(watcher.key)) return;
        watcher.tables = tables.size ? tables : new Set(allTables);
        watcher.last = { kind: "error", error };
        for (const subscriber of watcher.subscribers) {
          if (subscriber.onError) callSafely(() => subscriber.onError?.(error));
        }
        if (watcher.dirty || watcher.missed) rerun(watcher);
      }
    });
  };

  const notify = (notification: PendingNotification): void => {
    for (const watcher of watchers.values()) {
      if (isWatcherInvalidated(watcher, notification)) {
        rerun(watcher, notification);
      } else if (watcher.pendingTables) {
        watcher.missed = true;
      }
    }
  };

  const flushNotify = (): void => {
    notifyQueued = false;
    const notification = pendingNotify;
    pendingNotify = emptyPendingNotification();
    if (!watchers.size || isPendingNotificationEmpty(notification)) return;
    void runSpan("watch.notify", async () => {
      notify(notification);
    });
  };

  const scheduleNotify = (notification: PendingNotification): void => {
    if (isPendingNotificationEmpty(notification)) return;
    mergePendingNotification(pendingNotify, notification);
    if (notifyQueued) return;
    notifyQueued = true;
    // The deferral hook is an observer/scheduling adapter. If a host implementation rejects the
    // callback, preserve the merged notification and schedule an internal fallback instead of
    // turning a completed commit into a failed mutation or permanently stranding the queue.
    try {
      deferNotify(flushNotify);
    } catch {
      queueMicrotask(flushNotify);
    }
  };

  // Cut 7 §1/§14: the ONE site the retained-result cache key is computed. Both the published scope
  // (below) and the read-path cache-serve lookup call this, so the S4a write key and the S4b lookup
  // key are the same computation over the same hosted `subscription.args` — drift is impossible.
  const subscriptionDescriptor = async (
    watcher: Watcher,
  ): Promise<({ fn: string; resultCacheKey: string } & RemoteSubscription) | undefined> => {
    const resolved = resolveFunctionAddress(watcher.ref, rootScope);
    const watched = await resolveFunction(resolved.scope, resolved.name);
    if (watched.placement === "local") return undefined;
    const subscription = await hostedPullArgs(store, watched, watcher.args);
    if (subscription === undefined) return undefined;
    const fn = functionName(watcher.ref);
    const identity =
      (await store.identity?.read())?.identityKey ?? EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY;
    return {
      fn,
      ...subscription,
      resultCacheKey: await resultCacheKey({
        functionPath: fn,
        argsKey: canonicalJson(subscription.args),
        identity,
        schemaHash: storeSchema.hash ?? "local",
        moduleGraphHash,
      }),
    };
  };

  const publishRemoteScope = async (): Promise<void> => {
    const remote = store.remote;
    if (remote?.scope === undefined) return;
    const scopeWrite = remote.scope.write.bind(remote.scope);
    const version = ++remoteScopeVersion;
    try {
      // Every remote-scoped watcher owns one exact hosted query subscription. The server re-runs
      // each `fn(args)` under normal auth; local read tracking never substitutes for server scope.
      const scopeWatchers = [...watchers.values()].filter((watcher) => watcher.remoteScope());
      const resolved = await Promise.all(scopeWatchers.map(subscriptionDescriptor));
      if (version !== remoteScopeVersion) return;
      const unique = new Map<string, NonNullable<(typeof resolved)[number]>>();
      for (const subscription of resolved) {
        if (subscription === undefined) continue;
        unique.set(canonicalJson(subscription), subscription);
      }
      const scope: RemoteScope = { subscriptions: [...unique.values()].sort(compareSubscription) };
      const key = canonicalJson(scope);
      if (key === remoteScopeKey) return;
      const previousKey = remoteScopeKey;
      remoteScopeKey = key;
      await scopeWrite(scope).catch((error) => {
        if (remoteScopeKey === key) remoteScopeKey = previousKey;
        emit({
          at: getTimerTime(),
          attempt: 0,
          error: error instanceof Error ? error.message : String(error),
          status: "error",
          type: "remote",
        });
      });
    } catch (error) {
      if (version !== remoteScopeVersion) return;
      emit({
        at: getTimerTime(),
        attempt: 0,
        error: error instanceof Error ? error.message : String(error),
        status: "error",
        type: "remote",
      });
    }
  };

  // Cut 7 §4.2-4.6: the watch defers to its retained entry unless the local compute reproduced the
  // server's answer — foreign = !(A && B && C). A: every read stayed inside the disclosure (no scan,
  // count, unindexed range, or unexplained point miss). B: the local output agrees with the disclosed
  // members. C: the entry's skeleton carries no server projection this device cannot reconstruct.
  // Only a covered member-based entry may skip the lookup (its clause-C classification is stable per
  // query+args); the skip is safe only when the reads left no ambiguity, so a point miss or a hard
  // foreign forces the entry read even for a memoized watch. An unexplained foreign with no entry
  // local-computes as initialization and marks a cache-miss.
  const serveWatch = async (
    watcher: Watcher,
    value: unknown,
    authority: ReadAuthority | undefined,
  ): Promise<{ value: unknown; cache: boolean }> => {
    if (authority === undefined) return { value, cache: false };
    if (watcher.coveredMemo !== undefined && !authority.foreign && authority.misses.size === 0) {
      return { value, cache: false };
    }
    const key = (await subscriptionDescriptor(watcher))?.resultCacheKey;
    const entry = key === undefined ? undefined : await store.result?.read(key);
    if (!entry) {
      if (authority.foreign || authority.misses.size > 0) {
        cacheCounters.foreignEvaluations += 1;
        cacheCounters.cacheMisses += 1;
      }
      return { value, cache: false };
    }
    const disclosure = await readDisclosure(entry, store);
    const foreign =
      authority.foreign || [...authority.misses].some((id) => !disclosure.deletedMembers.has(id));
    if (foreign) cacheCounters.foreignEvaluations += 1;
    watcher.coveredMemo =
      disclosure.members.size > 0 && disclosure.covered ? entry.skeletonHash : undefined;
    const outputIds = collectVisibleDocIds(value);
    let defer: boolean;
    if (foreign) {
      defer = true;
    } else if (disclosure.covered) {
      defer = !(await outputAgrees(disclosure, outputIds, store, crdtFieldsByTable));
    } else {
      defer = !(await hasLocalOptimism(disclosure, outputIds, store, crdtFieldsByTable));
    }
    if (!defer) return { value, cache: false };
    cacheCounters.cacheEntries.add(entry.key);
    cacheCounters.cacheServes += 1;
    return { value: await reconstruct(entry, store), cache: true };
  };

  const emitCacheServe = (tables: Set<InvalidationKey>): void => {
    emit({
      at: getTimerTime(),
      changedTables: [...tables],
      deletes: [],
      source: "cache",
      type: "data",
      docWrites: [],
    });
  };

  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    const run = previous ? previous.then(task, task) : runQueuedTask(task);
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    mutationQueue = queued;
    void queued.then(() => {
      if (mutationQueue === queued) mutationQueue = null;
    });
    return run;
  };

  const systemCalls: RuntimeCalls = {
    kind: functionKind,
    runAction: (ref, args = {}) =>
      runAction(ref, args, rootScope, { allowInternal: true, auth: null }),
    runMutation: (ref, args = {}) =>
      enqueueMutation(() =>
        runMutationDirect(
          ref,
          normalizeCopy(args) as Record<string, unknown>,
          rootScope,
          {
            allowInternal: true,
            auth: null,
          },
          undefined,
          true,
        ),
      ),
    runQuery: (ref, args = {}) =>
      runQuery(ref, args, rootScope, undefined, undefined, undefined, {
        allowInternal: true,
        auth: null,
      }),
  };
  const schedulerPump = options.remote
    ? { wake: () => undefined }
    : createSchedulerPump(store, systemCalls, emit);
  wakeScheduler = (delayMs) => schedulerPump.wake(delayMs);
  wakeScheduler(0);

  const invalidateTables = (changedTables: string[], source: "local" | "remote") => {
    const tables = new Set(changedTables);
    if (!tables.size) return;
    emit({
      at: getTimerTime(),
      changedTables,
      deletes: [],
      source,
      type: "data",
      docWrites: [],
    });
    scheduleNotify({ dataOnlyDocIds: new Map(), tables });
  };

  return {
    identity: {
      read: async () => {
        if (!store.identity) {
          throw new Error("This runtime storage does not support identity partitions.");
        }
        return await store.identity.read();
      },
      write: async (identityKey) => {
        const identity = store.identity;
        if (!identity) {
          throw new Error("This runtime storage does not support identity partitions.");
        }
        await enqueueMutation(async () => {
          await identity.write(identityKey);
          invalidateTables(
            storeSchema.tables.map((table) => table.name),
            "local",
          );
        });
      },
    },
    localConfigured,
    localReady,
    async route(ref, args, kind) {
      const detached = normalizeCopy(args) as Record<string, unknown>;
      if (kind !== "action") {
        const resolved = resolveFunctionAddress(ref, rootScope);
        const local = resolved.name.startsWith(LOCAL_FUNCTION_PREFIX);
        const declared =
          !local && resolved.scope.instancePath === ROOT_INSTANCE
            ? manifestFunction(options.manifest, resolved.name)
            : undefined;
        if (
          !local &&
          options.manifest &&
          resolved.scope.instancePath === ROOT_INSTANCE &&
          !declared
        ) {
          throw new Error(`unknown embedded function: ${resolved.name}`);
        }
        if (declared) {
          if (declared.kind !== kind) throw new Error(`${describeRef(ref)} is not a ${kind}`);
          if (declared.visibility !== "public") {
            throw new Error(
              `${describeRef(ref)} is internal and cannot be called from the public client.`,
            );
          }
          if (declared.placement === "remote") {
            const hosted = await mapHostedArguments(store, detached);
            return hosted === undefined
              ? { execution: "blocked" }
              : { execution: "hosted", args: hosted };
          }
        }
        const fn = await resolveFunction(resolved.scope, resolved.name);
        if (fn.kind !== kind) throw kindMismatch(fn, ref, kind);
        ensureVisible(fn, ref, {});
        if (kind === "query") await resolveQueryArgs(store, fn, detached);
        else validateArgs(fn, detached, true);
        if (fn.placement === "replicated" || fn.placement === "local") {
          return { execution: "local", placement: fn.placement };
        }
      }
      const hosted = await mapHostedArguments(store, detached);
      return hosted === undefined
        ? { execution: "blocked" }
        : { execution: "hosted", args: hosted };
    },
    async runQuery(ref, args = {}, options = {}) {
      return runQuery(
        ref,
        normalizeCopy(args) as Record<string, unknown>,
        rootScope,
        undefined,
        undefined,
        undefined,
        options,
      );
    },
    async runMutation(ref, args = {}, options = {}) {
      const detached = normalizeCopy(args) as Record<string, unknown>;
      return enqueueMutation(() =>
        runMutationDirect(ref, detached, rootScope, options, undefined, true),
      );
    },
    async runAction(ref, args = {}, options = {}) {
      return runAction(ref, normalizeCopy(args) as Record<string, unknown>, rootScope, options);
    },
    async handleUpload(url, blob) {
      return runSpan("runtime.upload", async () => {
        const storage = createStorageService(store, uploadUrls, objectUrls, "writer", emit);
        return storage._handleUpload(url, blob);
      });
    },
    async devtools(request) {
      return enqueueMutation(() => runSpan("runtime.devtools", () => handleDevtools(request)));
    },
    invalidate(changedTables, source) {
      invalidateTables(changedTables, source);
    },
    rerunResults(keys) {
      void rerunResultWatchers(keys);
    },
    remote: {
      identity: {
        read: async () => enqueueMutation(async () => await store.remote?.identity?.()),
      },
      scope: {
        write: publishRemoteScope,
      },
      wake: {
        subscribe(listener) {
          remoteWakeListeners.add(listener);
          return () => {
            remoteWakeListeners.delete(listener);
          };
        },
      },
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onUpdate(ref, args, callback, onError, options = {}) {
      const detached = normalizeCopy(args) as Record<string, unknown>;
      const key = watchKey(functionName(ref), { ...detached, __auth: options.auth ?? null });
      const subscriber: Subscriber = { callback, onError };
      const remoteScope = remoteScopePredicate(options.remoteScope);
      let watcher = watchers.get(key);
      if (watcher) {
        watcher.subscribers.add(subscriber);
        if (watcher.last) {
          queueMicrotask(() => {
            if (!watcher?.subscribers.has(subscriber)) return;
            // Read `last` inside the microtask, not at subscribe time: a run may complete in the
            // gap, and the subscriber must see the current value, not the one captured earlier.
            const last = watcher.last;
            if (!last) return;
            if (last.kind === "value") callSafely(() => subscriber.callback(last.value));
            else if (subscriber.onError) callSafely(() => subscriber.onError?.(last.error));
          });
        }
      } else {
        watcher = {
          key,
          ref,
          args: detached,
          options,
          remoteScope,
          subscribers: new Set([subscriber]),
          tables: new Set(),
          pendingTables: null,
          dirty: false,
          missed: false,
          last: undefined,
          coveredMemo: undefined,
          readDocIds: new Set(),
        };
        watchers.set(key, watcher);
        rerun(watcher);
      }
      return () => {
        watcher.subscribers.delete(subscriber);
        if (!watcher.subscribers.size) {
          watchers.delete(key);
          void deleteWatchResult(watcher);
          void publishRemoteScope();
        }
      };
    },
  };

  // Cut 7 §5: a retained result changed server-side with no member/projection row change. Its watch
  // is table-invisible by construction, so it reruns by cache key (1:1 with a remote-scoped watcher's
  // `subscriptionDescriptor`), never through table invalidation, re-emitting the new reconstruction.
  async function rerunResultWatchers(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const wanted = new Set(keys);
    const remoteWatchers = [...watchers.values()].filter((watcher) => watcher.remoteScope());
    await Promise.all(
      remoteWatchers.map(async (watcher) => {
        if (!watchers.has(watcher.key)) return;
        const key = (await subscriptionDescriptor(watcher))?.resultCacheKey;
        if (key !== undefined && wanted.has(key)) rerun(watcher);
      }),
    );
  }

  // Cut 7 §6: stopping a watch drops its retained-result entry so no entry outlives its watch. The
  // restart orphan deletion (`result_stale_delete`) is the durable backstop for crashes and rotation.
  // Item-7 guard: a rapid resubscribe can mint a fresh same-key entry while this fire-and-forget
  // delete is still in flight; skip the delete unless the watcher is truly gone (`!watchers.has`).
  // The watch key is over LOCAL args while the entry key is over HOSTED args, so distinct live
  // watchers can share one entry; deleting it would strand the survivor on a permanent cache-miss.
  async function deleteWatchResult(watcher: Watcher): Promise<void> {
    if (store.remote?.scope === undefined || !watcher.remoteScope() || store.result === undefined) {
      return;
    }
    try {
      const key = (await subscriptionDescriptor(watcher))?.resultCacheKey;
      if (key === undefined || watchers.has(watcher.key)) return;
      const live = await Promise.all(
        [...watchers.values()].map(async (other) =>
          other.remoteScope() ? (await subscriptionDescriptor(other))?.resultCacheKey : undefined,
        ),
      );
      if (live.includes(key)) return;
      await store.result.delete(key);
    } catch {
      /* best-effort: restart deletion reclaims a stranded entry. */
    }
  }

  async function handleDevtools(request: RunnerDevtoolsRequest): Promise<unknown> {
    switch (request.kind) {
      case "snapshot":
        return devtoolsSnapshot();
      case "listRows":
        return devtoolsRows(request.table, request.cursor ?? null, request.limit);
      case "patchDocument":
        return devtoolsPatch(request.table, request.id, request.fields);
      case "deleteDocument":
        return devtoolsDelete(request.table, request.id);
      case "clearData":
        return devtoolsClear();
    }
  }

  async function devtoolsSnapshot(): Promise<RunnerDevtoolsSnapshot> {
    const service = fullStore(store);
    const [tables, storage, jobs, functions] = await Promise.all([
      Promise.all(
        storeSchema.tables.map(async (table) => ({
          name: table.name,
          rowCount: await tableRowCount(table.name),
          system: false,
        })),
      ),
      devtoolsStorage(),
      service.schedule?.read() ?? Promise.resolve([]),
      devtoolsFunctions(),
    ]);
    return {
      data: [
        ...tables,
        { name: "_storage", rowCount: storage.files.length, system: true },
        { name: "_id_mappings", rowCount: storage.idMappings.length, system: true },
        { name: "_pending_uploads", rowCount: storage.uploads.length, system: true },
        { name: "_scheduled_jobs", rowCount: jobs.length, system: true },
      ],
      functions,
      runtime: {
        role: "runtime",
        tableCount: storeSchema.tables.length,
        cacheEntries: cacheCounters.cacheEntries.size,
        cacheServes: cacheCounters.cacheServes,
        cacheMisses: cacheCounters.cacheMisses,
        foreignEvaluations: cacheCounters.foreignEvaluations,
      },
      scheduler: { jobs },
      schema: storeSchema.tables.map((table) => ({
        indexes: table.indexes.map((index) => ({ fields: [...index.fields], name: index.name })),
        name: table.name,
      })),
      storage,
    };
  }

  async function devtoolsFunctions(): Promise<RunnerDevtoolsFunction[]> {
    const entries = await Promise.all(
      Object.keys(modules).flatMap((moduleId) => {
        if (isSystemModuleId(moduleId)) return [];
        return [
          (async () => {
            const module = await loadModule(modules, moduleCache, ROOT_INSTANCE, moduleId);
            return Object.entries(module).flatMap(([name, value]) => {
              const fn = toRunnable(value);
              if (!fn) return [];
              return [
                {
                  args: devtoolsFunctionArgs(fn),
                  kind: fn.kind,
                  module: moduleId,
                  name,
                  path: name === "default" ? moduleId : `${moduleId}:${name}`,
                  visibility: fn.visibility,
                },
              ];
            });
          })(),
        ];
      }),
    );
    return entries.flat().sort((left, right) => left.path.localeCompare(right.path));
  }

  function devtoolsFunctionArgs(fn: RunnableFunction): RunnerDevtoolsFunctionArg[] {
    if (fn.args) {
      return Object.entries(fn.args).map(([name, validator]) => {
        const meta = validator as unknown as {
          isOptional?: string;
          json?: ValidatorJSON;
          kind?: string;
        };
        const json = meta.json ?? ({ type: meta.kind ?? "unknown" } as ValidatorJSON);
        return {
          name,
          optional: meta.isOptional === "optional",
          placeholder: placeholderForValidator(json),
          type: formatValidator(json),
        };
      });
    }
    return argsFromJson(fn.argsJson);
  }

  function argsFromJson(args: ValidatorJSON | undefined): RunnerDevtoolsFunctionArg[] {
    const record = asRecord(args);
    if (record?.type !== "object") return [];
    const fields = asRecord(record.value);
    if (!fields) return [];
    return Object.entries(fields).flatMap(([name, field]) => {
      const fieldRecord = asRecord(field);
      const fieldType = fieldRecord?.fieldType as ValidatorJSON | undefined;
      if (!fieldRecord || !fieldType) return [];
      return [
        {
          name,
          optional: fieldRecord.optional === true,
          placeholder: placeholderForValidator(fieldType),
          type: formatValidator(fieldType),
        },
      ];
    });
  }

  async function devtoolsRows(
    table: string,
    cursor: string | null,
    limit: number | undefined,
  ): Promise<RunnerDevtoolsRows> {
    const pageSize = clampPageSize(limit);
    if (rootScope.schema.has(table)) {
      const page = await store.doc.page.read({
        cursor: cursor ?? undefined,
        order: "asc",
        pageSize,
        table,
      });
      return {
        cursor: page.cursor,
        isDone: page.cursor === null,
        rows: page.docs.map((doc) => normalizeCopy(doc) as Record<string, unknown>),
        table,
      };
    }
    const snapshot = await devtoolsSnapshot();
    const rows =
      table === "_storage"
        ? snapshot.storage.files
        : table === "_id_mappings"
          ? snapshot.storage.idMappings
          : table === "_pending_uploads"
            ? snapshot.storage.uploads
            : table === "_scheduled_jobs"
              ? snapshot.scheduler.jobs.map((job) => normalizeCopy(job) as Record<string, unknown>)
              : undefined;
    if (!rows) throw new Error(`unknown table: ${table}`);
    return pageRows(table, rows, cursor, pageSize);
  }

  async function devtoolsPatch(
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    if (!rootScope.schema.has(table))
      throw new Error(`devtools patch only supports app table rows: ${table}`);
    if ("_id" in fields || "_creationTime" in fields) {
      throw new Error("devtools patch cannot change system fields.");
    }
    const root = createWriter<GenericDataModel>(
      store,
      rootScope.schema,
      undefined,
      rootScope.schema.get(table)?.placement === "device" ? "device" : "replicated",
    );
    await root.db.patch(table as never, id as never, normalizeCopy(fields) as never);
    const batch = root.toBatch();
    const commit = await runSpan("storage.commit", () =>
      store.commit(
        batch,
        rootScope.schema.get(table)?.placement === "device"
          ? { changes: "omit", source: "device" }
          : { changes: "omit", mutation: "none", source: "local" },
      ),
    );
    if (hasEventListeners()) emitCommit(emit, commit, batch, "local");
    scheduleNotify({ dataOnlyDocIds: new Map(), tables: new Set(commit.changedTables) });
  }

  async function devtoolsDelete(table: string, id: string): Promise<void> {
    if (!rootScope.schema.has(table)) {
      throw new Error(`devtools delete only supports app table rows: ${table}`);
    }
    await deleteDoc(table, id);
  }

  /** Delete one application record from either the active or candidate workspace. */
  async function deleteDoc(table: string, id: string): Promise<void> {
    if (!rootScope.schema.has(table)) {
      throw new Error(`document delete only supports app table rows: ${table}`);
    }
    const root = createWriter<GenericDataModel>(
      store,
      rootScope.schema,
      undefined,
      rootScope.schema.get(table)?.placement === "device" ? "device" : "replicated",
    );
    if ((await root.db.get(table as never, id as never)) === null) return;
    await root.db.delete(table as never, id as never);
    const batch = root.toBatch();
    const commit = await runSpan("storage.commit", () =>
      store.commit(
        batch,
        rootScope.schema.get(table)?.placement === "device"
          ? { changes: "omit", source: "device" }
          : { changes: "omit", mutation: "none", source: "local" },
      ),
    );
    if (hasEventListeners()) emitCommit(emit, commit, batch, "local");
    scheduleNotify({ dataOnlyDocIds: new Map(), tables: new Set(commit.changedTables) });
  }

  async function devtoolsClear(): Promise<void> {
    const service = fullStore(store);
    if (!service.clear) {
      throw new Error("Convex embedded runtime storage backend does not support clearing data.");
    }
    const deletes = await clearDeletes(store, storeSchema);
    await service.clear();
    emitDeletes(emit, deletes, "local");
    scheduleNotify({ dataOnlyDocIds: new Map(), tables: allTables });
  }

  async function tableRowCount(table: string): Promise<number> {
    const exact = await store.doc.count.read({ table });
    if (exact !== null) return exact;
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await store.key.page.read({ cursor, order: "asc", pageSize: 1024, table });
      count += page.ids.length;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return count;
  }

  async function devtoolsStorage(): Promise<RunnerDevtoolsStorage> {
    const service = fullStore(store);
    const idMappings: Record<string, unknown>[] = [];
    if (service.id) {
      const mapped = storeSchema.tables
        .filter((def) => def.placement === "replicated")
        .map((def) => def.name);
      for (const table of [...mapped, "_storage"]) {
        for (const mapping of await service.id.page.read(table)) {
          idMappings.push(normalizeCopy(mapping) as Record<string, unknown>);
        }
      }
    }
    const uploads = service.upload
      ? (await service.upload.read()).map(
          (upload) => normalizeCopy(upload) as Record<string, unknown>,
        )
      : [];
    const dirtyHeads = service.dirtyHeadsDebugRead ? await service.dirtyHeadsDebugRead() : [];
    const crdtHeads: RunnerDevtoolsStorage["crdtHeads"] = [];
    const tables = new Map(storeSchema.tables.map((table) => [table.name, table] as const));
    for (const mapping of idMappings) {
      if (typeof mapping.table !== "string" || typeof mapping.localId !== "string") continue;
      const table = tables.get(mapping.table);
      if (!table) continue;
      for (const field of table.crdtFields ?? []) {
        const headSeq = await service.doc.crdt.read(mapping.table, mapping.localId, field.field);
        if (headSeq !== undefined) {
          crdtHeads.push({
            field: field.field,
            headSeq,
            id: mapping.localId,
            table: mapping.table,
          });
        }
      }
    }
    const projections: Record<string, unknown>[] = [];
    if (service.remoteDocDebugRead) {
      for (const mapping of idMappings) {
        if (typeof mapping.table !== "string" || typeof mapping.localId !== "string") continue;
        const projection = await service.remoteDocDebugRead(mapping.table, mapping.localId);
        if (projection) projections.push(normalizeCopy(projection) as Record<string, unknown>);
      }
    }
    const storageIds = new Set<string>();
    for (const mapping of idMappings) {
      if (mapping.table === "_storage" && typeof mapping.localId === "string") {
        storageIds.add(mapping.localId);
      }
    }
    for (const upload of uploads) {
      if (typeof upload.localStorageId === "string") storageIds.add(upload.localStorageId);
    }
    const files: Record<string, unknown>[] = [];
    if (service.file) {
      for (const storageId of storageIds) {
        const metadata = await service.file.read(storageId);
        if (metadata) files.push(normalizeCopy(metadata) as Record<string, unknown>);
      }
    }
    return { crdtHeads, dirtyHeads, files, idMappings, projections, uploads };
  }
}

function manifestFunction(
  manifest: RuntimeFunctionManifest | undefined,
  fullName: string,
): RuntimeFunctionManifest[string][string] | undefined {
  if (!manifest) return undefined;
  const separator = fullName.indexOf(":");
  const moduleId = separator < 0 ? fullName : fullName.slice(0, separator);
  const exportName = separator < 0 ? "default" : fullName.slice(separator + 1);
  return manifest[moduleId]?.[exportName];
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(250, Math.floor(limit)));
}

function pageRows(
  table: string,
  rows: Record<string, unknown>[],
  cursor: string | null,
  limit: number,
): RunnerDevtoolsRows {
  const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const next = start + limit;
  const page = rows.slice(start, next);
  const nextCursor = next < rows.length ? String(next) : null;
  return { cursor: nextCursor, isDone: nextCursor === null, rows: page, table };
}

function authService(auth: UserIdentity | null): {
  getUserIdentity(): Promise<UserIdentity | null>;
} {
  return {
    async getUserIdentity() {
      return auth;
    },
  };
}

interface Subscriber {
  callback: OnUpdateCallback;
  onError: OnUpdateErrorCallback | undefined;
}

interface Watcher {
  key: string;
  ref: FunctionReference;
  args: Record<string, unknown>;
  options: RunOptions;
  remoteScope: () => boolean;
  subscribers: Set<Subscriber>;
  /**
   * Read set of the last completed run. A failed run proves nothing about dependencies, so it
   * leaves the tables read before the failure (or every table for a read-free failure) and a
   * later commit can recover the watcher.
   */
  tables: Set<InvalidationKey>;
  /** Read set of the in-flight run, populated incrementally; null when idle. */
  pendingTables: Set<InvalidationKey> | null;
  dirty: boolean;
  /** A commit landed mid-run outside the in-flight read set; only matters if the run fails. */
  missed: boolean;
  last: { kind: "value"; value: unknown } | { kind: "error"; error: unknown } | undefined;
  /**
   * Clause-C memo: the `skeletonHash` of the last entry this watch read that was a covered
   * member-based disclosure. Set, it lets an unambiguously local eval (no foreign read, no point
   * miss) serve the local compute without re-reading the entry; it never overrides the rule, since
   * any foreign read or point miss forces the read regardless. `undefined` when unclassified or when
   * the last entry was a projection or genuinely empty.
   */
  coveredMemo: string | undefined;
  readDocIds: Set<string>;
}

async function hostedPullArgs(
  store: RuntimeStorageWriter,
  fn: RunnableFunction,
  args: Record<string, unknown>,
): Promise<Pick<RemoteSubscription, "args" | "cursor"> | undefined> {
  const encoded = convexToJson(args as Value);
  for (const pointer of idPathsForArgs(fn, args)) {
    const slot = jsonPointerSlot(encoded, pointer);
    if (!slot || typeof slot.value !== "string") {
      throw new Error(`Validator-derived query ID path is missing: ${pointer}`);
    }
    const localId = slot.value;
    const table = tableFromId(localId);
    if (!table) continue;
    const mapping = await store.id.read(table, localId);
    if (mapping?.mapping === "mapped") slot.write(mapping.convexId);
    else if (mapping?.mapping === "deleted" && mapping.convexId !== undefined) {
      slot.write(mapping.convexId);
    } else return undefined;
  }
  const cursors = paginationCursors(args);
  if (cursors.length > 1) {
    throw new Error("A local-capable query may contain at most one pagination cursor.");
  }
  const cursor = cursors[0];
  if (!cursor) return { args: encoded };
  const localBoundary = pageCursorBoundary(cursor.value);
  if (localBoundary === undefined) return undefined;
  const table = tableFromId(localBoundary.rowId);
  if (!table) throw new Error("Local pagination cursor boundary is not an Embedded document ID.");
  const mapping = await store.id.read(table, localBoundary.rowId);
  if (mapping?.mapping !== "mapped") return undefined;
  const boundaryValues = await Promise.all(
    localBoundary.values
      // Offline and hosted inserts necessarily have different Convex creation times. The hosted
      // row id locates the exact boundary row; user-controlled index fields still guard against
      // resolving a cursor after that row has moved.
      .filter((entry) => entry.field !== "_creationTime")
      .map(async (entry) => {
        if (!("value" in entry) || typeof entry.value !== "string") return entry;
        const valueTable = tableFromId(entry.value);
        if (!valueTable) return entry;
        const valueMapping = await store.id.read(valueTable, entry.value);
        return valueMapping?.mapping === "mapped"
          ? { field: entry.field, value: valueMapping.convexId }
          : entry;
      }),
  );
  const slot = jsonPointerSlot(encoded, cursor.path);
  if (!slot) throw new Error("Pagination cursor path is missing from encoded query arguments.");
  slot.write(null);
  return {
    args: encoded,
    cursor: {
      path: cursor.path,
      boundary: {
        rowId: mapping.convexId,
        values: boundaryValues.map((value) =>
          value.field === "_id" ? { field: "_id", value: mapping.convexId } : value,
        ),
      },
    },
  };
}

function paginationCursors(value: unknown, path = ""): Array<{ path: string; value: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => paginationCursors(entry, `${path}/${index}`));
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const found =
    typeof record.cursor === "string" &&
    record.cursor.startsWith("v1:") &&
    typeof record.numItems === "number"
      ? [{ path: `${path}/cursor`, value: record.cursor }]
      : [];
  return [
    ...found,
    ...Object.entries(record).flatMap(([key, entry]) =>
      paginationCursors(entry, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    ),
  ];
}

function jsonPointerSlot(
  value: unknown,
  pointer: string,
): { value: unknown; write(value: unknown): void } | undefined {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length === 0) return undefined;
  let parent = value;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(part)];
    else if (parent !== null && typeof parent === "object") {
      parent = (parent as Record<string, unknown>)[part];
    } else return undefined;
  }
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) {
    const index = Number(last);
    return { value: parent[index], write: (value) => (parent[index] = value) };
  }
  if (parent === null || typeof parent !== "object") return undefined;
  const record = parent as Record<string, unknown>;
  return { value: record[last], write: (value) => (record[last] = value) };
}

function remoteScopePredicate(remoteScope: RunOptions["remoteScope"]): () => boolean {
  if (typeof remoteScope === "function") return remoteScope;
  return () => remoteScope ?? true;
}

async function clearDeletes(
  store: RuntimeStorageWriter,
  schema: StoreSchema,
): Promise<{ id: string; table: string }[]> {
  const deletes: { id: string; table: string }[] = [];
  for (const table of schema.tables) {
    let cursor: string | undefined;
    do {
      const page = await store.key.page.read({
        cursor,
        order: "asc",
        pageSize: 1024,
        table: table.name,
      });
      deletes.push(...page.ids.map((id) => ({ id, table: table.name })));
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  const service = fullStore(store);
  const storageIds = new Set<string>();
  if (service.id) {
    for (const mapping of await service.id.page.read("_storage")) {
      storageIds.add(mapping.localId);
      deletes.push({ id: `_storage|${mapping.localId}`, table: "_id_mappings" });
    }
  }
  if (service.upload) {
    for (const upload of await service.upload.read()) {
      storageIds.add(upload.localStorageId);
      deletes.push({ id: upload.localStorageId, table: "_pending_uploads" });
    }
  }
  if (service.file) {
    for (const storageId of storageIds) {
      const metadata = await service.file.read(storageId);
      if (metadata) deletes.push({ id: storageId, table: "_storage" });
    }
  }
  if (service.schedule) {
    for (const job of await service.schedule.read()) {
      deletes.push({ id: job.jobId, table: "_scheduled_jobs" });
    }
  }
  return deletes;
}

function rootBatchInvalidationKeys(batch: WriteBatch): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (table: string): void => {
    if (seen.has(table)) return;
    seen.add(table);
    keys.push(table);
  };
  for (const docWrite of batch.docWrites) add(docWrite.table);
  for (const deleted of batch.deletes) add(deleted.table);
  for (const write of batch.localFieldWrites ?? []) add(write.table);
  for (const deleted of batch.localFieldDeletes ?? []) add(deleted.table);
  return keys;
}

function rootBatchDataOnlyDocIds(batch: WriteBatch): Map<InvalidationKey, Set<string>> | undefined {
  if (batch.docWrites.length === 0 || batch.deletes.length > 0) return undefined;
  if ((batch.crdtOps?.length ?? 0) > 0) return undefined;
  if ((batch.freshIds?.length ?? 0) > 0) return undefined;
  if ((batch.localFieldWrites?.length ?? 0) > 0) return undefined;
  if ((batch.localFieldDeletes?.length ?? 0) > 0) return undefined;
  const dataOnlyIds = batch.dataOnlyIds ?? [];
  if (dataOnlyIds.length !== batch.docWrites.length) return undefined;
  const marked = new Set(dataOnlyIds.map((row) => `${row.table}\0${row.id}`));
  const byTable = new Map<InvalidationKey, Set<string>>();
  for (const docWrite of batch.docWrites) {
    if (!marked.has(`${docWrite.table}\0${docWrite.id}`)) return undefined;
    let ids = byTable.get(docWrite.table);
    if (!ids) {
      ids = new Set<string>();
      byTable.set(docWrite.table, ids);
    }
    ids.add(docWrite.id);
  }
  return byTable;
}

function emptyPendingNotification(): PendingNotification {
  return { dataOnlyDocIds: new Map(), tables: new Set() };
}

function isPendingNotificationEmpty(notification: PendingNotification): boolean {
  return notification.tables.size === 0 && notification.dataOnlyDocIds.size === 0;
}

function mergePendingNotification(target: PendingNotification, source: PendingNotification): void {
  for (const table of source.tables) {
    target.tables.add(table);
    target.dataOnlyDocIds.delete(table);
  }
  for (const [table, ids] of source.dataOnlyDocIds) {
    if (target.tables.has(table)) continue;
    let targetIds = target.dataOnlyDocIds.get(table);
    if (!targetIds) {
      targetIds = new Set<string>();
      target.dataOnlyDocIds.set(table, targetIds);
    }
    for (const id of ids) targetIds.add(id);
  }
}

function isWatcherInvalidated(watcher: Watcher, notification: PendingNotification): boolean {
  const readTables = watcher.pendingTables ?? watcher.tables;
  if (intersects(readTables, notification.tables)) return true;
  for (const [table, ids] of notification.dataOnlyDocIds) {
    if (!readTables.has(table)) continue;
    if (watcher.pendingTables) return true;
    for (const id of ids) {
      if (watcher.readDocIds.has(id)) return true;
    }
  }
  return false;
}

function changedDocIdsForWatcher(
  watcher: Watcher,
  notification: PendingNotification | undefined,
): Set<string> | undefined {
  if (notification === undefined) return undefined;
  const readTables = watcher.tables;
  if (intersects(readTables, notification.tables)) return undefined;
  let changed: Set<string> | undefined;
  for (const [table, ids] of notification.dataOnlyDocIds) {
    if (!readTables.has(table)) continue;
    for (const id of ids) {
      if (!watcher.readDocIds.has(id)) continue;
      changed ??= new Set();
      changed.add(id);
    }
  }
  return changed;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function createRootScope(modules: ModuleMap, storeSchema: StoreSchema): RuntimeScope {
  return {
    instancePath: ROOT_INSTANCE,
    modules,
    schema: toSchema({
      ...storeSchema,
      tables: storeSchema.tables.filter((table) => !table.name.startsWith("__e_")),
    }),
  };
}

function scopedTracker(
  scope: RuntimeScope,
  tracker: ReadTracker | undefined,
): ReadTracker | undefined {
  if (!tracker) return undefined;
  return {
    doc: (id) => tracker.doc?.(id),
    table: (table) => tracker.table(invalidationKey(scope.instancePath, table)),
    range: (range, members, memberHashes, membersHash, version) =>
      tracker.range?.(range, members, memberHashes, membersHash, version),
    point: (base) => tracker.point?.(base),
    ...(tracker.authority === undefined ? {} : { authority: tracker.authority }),
  };
}

/**
 * Collects an optimistic mutation's read-set as base-versions for the push envelope (contract §2).
 * Point reads dedupe by `(table,id)` keeping the highest observed version; range reads accumulate,
 * so the server re-run can detect any read member that advanced before it committed.
 */
function createReadSetCollector(): { tracker: ReadTracker; readSet(): BaseVersion[] } {
  const points = new Map<string, Extract<BaseVersion, { id: string }>>();
  const ranges: Extract<BaseVersion, { members: string[] }>[] = [];
  return {
    tracker: {
      table: () => {},
      point: (base) => {
        const key = `${base.table}\u0000${base.id}`;
        const prior = points.get(key);
        if (prior === undefined || base.version > prior.version) points.set(key, base);
      },
      range: (range, members, memberHashes, membersHash, version) => {
        ranges.push({ ...range, members, memberHashes, membersHash, version });
      },
    },
    readSet: () => [...points.values(), ...ranges],
  };
}

function idPathsForArgs(fn: RunnableFunction, args: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  if (fn.args) {
    for (const [field, validator] of Object.entries(fn.args)) {
      collectValidatorIdPaths(validator, args[field], `/${pointerPart(field)}`, paths);
    }
  } else if (fn.argsJson) {
    collectJsonIdPaths(fn.argsJson, args, "", paths);
  }
  return [...paths].sort();
}

function collectValidatorIdPaths(
  validator: unknown,
  value: unknown,
  path: string,
  paths: Set<string>,
): void {
  const record = validator as {
    kind?: string;
    fields?: Record<string, unknown>;
    element?: unknown;
    members?: unknown[];
    value?: unknown;
  };
  if (record.kind === "id" && typeof value === "string") {
    paths.add(path);
    return;
  }
  if (record.kind === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [field, child] of Object.entries(record.fields ?? {})) {
      collectValidatorIdPaths(
        child,
        (value as Record<string, unknown>)[field],
        `${path}/${pointerPart(field)}`,
        paths,
      );
    }
    return;
  }
  if (record.kind === "array" && Array.isArray(value)) {
    value.forEach((child, index) =>
      collectValidatorIdPaths(record.element ?? record.value, child, `${path}/${index}`, paths),
    );
    return;
  }
  if (record.kind === "union") {
    for (const member of record.members ?? []) collectValidatorIdPaths(member, value, path, paths);
  }
}

function collectJsonIdPaths(
  validator: ValidatorJSON,
  value: unknown,
  path: string,
  paths: Set<string>,
): void {
  const record = validator as unknown as {
    type?: string;
    value?: unknown;
  };
  if (record.type === "id" && typeof value === "string") {
    paths.add(path);
    return;
  }
  if (record.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [field, descriptor] of Object.entries(asRecord(record.value) ?? {})) {
      const child = asRecord(descriptor)?.fieldType ?? descriptor;
      collectJsonIdPaths(
        child as ValidatorJSON,
        (value as Record<string, unknown>)[field],
        `${path}/${pointerPart(field)}`,
        paths,
      );
    }
    return;
  }
  if (record.type === "array" && Array.isArray(value)) {
    value.forEach((child, index) =>
      collectJsonIdPaths(record.value as ValidatorJSON, child, `${path}/${index}`, paths),
    );
    return;
  }
  if (record.type === "union" && Array.isArray(record.value)) {
    for (const member of record.value)
      collectJsonIdPaths(member as ValidatorJSON, value, path, paths);
  }
}

function callSafely(call: () => void): void {
  try {
    call();
  } catch {
    // User-owned observers run after (or alongside) durable runtime work. They are deliberately
    // best effort: surfacing one through the mutation/query path would make callers retry an
    // operation whose state may already have committed.
  }
}

interface RunnableFunction {
  kind: "query" | "mutation" | "action";
  placement: FunctionPlacement;
  args?: PropertyValidators;
  returns?: GenericValidator;
  argsJson?: ValidatorJSON;
  returnsJson?: ValidatorJSON | null;
  visibility: "public" | "internal";
  handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
}

function ensureSamePlacement(
  fn: RunnableFunction,
  ref: FunctionReference,
  callerPlacement: FunctionPlacement | undefined,
): void {
  if (callerPlacement === undefined || callerPlacement === fn.placement) return;
  throw new Error(
    `Embedded ${callerPlacement} functions cannot call ${fn.placement} function ${describeRef(ref)}.`,
  );
}

function ensureVisible(fn: RunnableFunction, ref: FunctionReference, options: RunOptions): void {
  if (fn.visibility !== "internal" || options.allowInternal) return;
  if (fn.placement === "local") {
    throw new Error("Internal local functions are only callable from other local functions.");
  }
  throw new Error(`${describeRef(ref)} is internal and cannot be called from the public client.`);
}

function kindMismatch(
  fn: RunnableFunction,
  ref: FunctionReference,
  kind: "query" | "mutation",
): Error {
  return fn.placement === "local"
    ? new Error(`${functionName(ref)} is a local ${fn.kind} and cannot be called as a ${kind}.`)
    : new Error(`${describeRef(ref)} is not a ${kind}`);
}

/**
 * Imports every device-only module up front and names each registration it exports. Everything else
 * a module exports passes through untouched, so a device module is free to export helpers and
 * constants the app imports directly.
 */
async function ingestLocalModules(
  localModules: LocalModuleMap,
  table: Map<string, RunnableFunction>,
  _mode: RunnerMode,
): Promise<void> {
  await Promise.all(
    Object.entries(localModules).map(async ([moduleId, load]) => {
      const exports = (await load()) as Record<string, unknown>;
      stampLocal(moduleId, exports);
      for (const [exportName, value] of Object.entries(exports)) {
        if (!isLocalFunction(value)) continue;
        const name = `${moduleId}:${exportName}`;
        const registration = toRunnable(value);
        if (!registration) continue;
        table.set(name, registration);
      }
    }),
  );
}

function runQueuedTask<T>(task: () => Promise<T>): Promise<T> {
  try {
    return task();
  } catch (error) {
    return Promise.reject(error);
  }
}

async function loadFunction(
  modules: ModuleMap,
  moduleCache: Map<string, Promise<ModuleExports>>,
  functionCache: Map<string, Promise<RunnableFunction>>,
  instancePath: ComponentInstancePath,
  fullName: string,
): Promise<RunnableFunction> {
  const functionCacheKey = `${instancePath}\0${fullName}`;
  const cached = functionCache.get(functionCacheKey);
  if (cached) return cached;
  const loading = loadFunctionUncached(modules, moduleCache, instancePath, fullName).catch(
    (error) => {
      functionCache.delete(functionCacheKey);
      throw error;
    },
  );
  functionCache.set(functionCacheKey, loading);
  return loading;
}

async function loadFunctionUncached(
  modules: ModuleMap,
  moduleCache: Map<string, Promise<ModuleExports>>,
  instancePath: ComponentInstancePath,
  fullName: string,
): Promise<RunnableFunction> {
  const sep = fullName.indexOf(":");
  const file = sep < 0 ? fullName : fullName.slice(0, sep);
  const name = sep < 0 ? "default" : fullName.slice(sep + 1);
  const module = await loadModule(modules, moduleCache, instancePath, file);
  const fn = module[name];
  const registered = toRunnable(fn, instancePath === "embedded" ? "replicated" : undefined);
  if (!registered) throw new Error(`not a registered function: ${fullName}`);
  return registered;
}

function resolveFunctionAddress(
  ref: FunctionReference,
  currentScope: RuntimeScope,
): { name: string; scope: RuntimeScope } {
  const referencePath = extractReferencePath(ref);
  if (!referencePath) return { name: functionName(ref), scope: currentScope };
  const prefix = "_reference/childComponent/";
  if (!referencePath.startsWith(prefix)) {
    throw new Error(`Unsupported component function reference: ${referencePath}`);
  }
  if (currentScope.instancePath !== ROOT_INSTANCE) {
    throw new Error("Nested component calls are not supported by the local runtime.");
  }
  const [instance, ...functionPath] = referencePath.slice(prefix.length).split("/");
  if (instance !== "embedded" || functionPath.length < 2) {
    throw new Error(`Unsupported component function reference: ${referencePath}`);
  }
  const name = functionPath.pop()!;
  return {
    name: `${functionPath.join("/")}:${name}`,
    scope: {
      instancePath: instance,
      modules: embeddedComponentModules,
      schema: toSchema(embeddedComponentStoreSchema()),
    },
  };
}

function loadModule(
  modules: ModuleMap,
  moduleCache: Map<string, Promise<ModuleExports>>,
  instancePath: ComponentInstancePath,
  file: string,
): Promise<ModuleExports> {
  const cacheKey = `${instancePath}\0${file}`;
  const cached = moduleCache.get(cacheKey);
  if (cached) return cached;

  const entry = modules[file];
  if (!entry) throw new Error(`unknown module: ${file}`);

  const loading = typeof entry === "function" ? entry() : Promise.resolve(entry);
  const cachedLoading = loading.catch((error) => {
    moduleCache.delete(file);
    moduleCache.delete(cacheKey);
    throw error;
  });
  moduleCache.set(cacheKey, cachedLoading);
  return cachedLoading;
}

function describeRef(ref: FunctionReference): string {
  try {
    return functionName(ref);
  } catch {
    return JSON.stringify(ref);
  }
}

async function validateRevisionCreate(
  db: DatabaseReader<GenericDataModel>,
  args: Record<string, unknown>,
): Promise<void> {
  const current = await revisionCurrent(db, args);
  const expected: RevisionRestoreExpectation = {
    table: String(args.table),
    rowId: String(args.rowId),
    deleted: args.deleted === true,
    ...(args.deleted === true ? {} : { value: args.value as Record<string, unknown> }),
  };
  if (
    current.deleted !== expected.deleted ||
    (!expected.deleted && !equals(current.value, expected.value))
  ) {
    throw new Error("rev.create must match the document visible in the current transaction.");
  }
}

async function revisionCurrent(
  db: DatabaseReader<GenericDataModel>,
  args: Record<string, unknown>,
): Promise<RevisionRestoreExpectation> {
  const table = String(args.table);
  const rowId = String(args.rowId);
  const current = (await db.get(table as never, rowId as never)) as Record<string, unknown> | null;
  return current === null
    ? { table, rowId, deleted: true }
    : { table, rowId, deleted: false, value: documentValue(current) };
}

function documentValue(document: Record<string, unknown>): Record<string, unknown> {
  const { _id, _creationTime, ...value } = document;
  return value;
}

function embeddedComponentReference(path: string): FunctionReference {
  return {
    [TO_REFERENCE_PATH]: `_reference/childComponent/embedded/${path}`,
  } as unknown as FunctionReference;
}

const TO_REFERENCE_PATH = Symbol.for("toReferencePath");

function extractReferencePath(ref: FunctionReference): string | null {
  if (typeof ref !== "object" || ref === null) return null;
  const value = (ref as Record<PropertyKey, unknown>)[TO_REFERENCE_PATH];
  return typeof value === "string" ? value : null;
}

function isSystemModuleId(moduleId: string): boolean {
  return (
    moduleId === "convex.config" ||
    moduleId === "auth.config" ||
    moduleId === "crons" ||
    moduleId === "http"
  );
}

function toRunnable(
  value: unknown,
  builtInPlacement?: FunctionPlacement,
): RunnableFunction | undefined {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const candidate = value as RegisteredFunction;
    if (
      candidate.kind === "query" ||
      candidate.kind === "mutation" ||
      candidate.kind === "action"
    ) {
      return {
        kind: candidate.kind,
        placement: candidate.placement,
        args: candidate.args,
        returns: candidate.returns,
        visibility: candidate.visibility ?? "public",
        handler: candidate.handler as RunnableFunction["handler"],
      };
    }
  }
  if (typeof value !== "function") return undefined;
  const record = value as unknown as Record<string, unknown>;
  const handler = record.__embeddedHandler ?? record._handler;
  if (typeof handler !== "function") return undefined;
  const kind =
    record.isQuery === true
      ? "query"
      : record.isMutation === true
        ? "mutation"
        : record.isAction === true
          ? "action"
          : undefined;
  if (!kind) return undefined;
  return {
    kind,
    placement: embeddedPlacement(record, builtInPlacement),
    handler: handler as RunnableFunction["handler"],
    visibility: record.isInternal === true ? "internal" : "public",
    argsJson: exportedValidator(record.exportArgs),
    returnsJson: exportedReturns(record.exportReturns),
  };
}

function embeddedPlacement(
  record: Record<string, unknown>,
  builtInPlacement?: FunctionPlacement,
): FunctionPlacement {
  const placement = record.__embeddedPlacement;
  if (placement === "replicated" || placement === "remote" || placement === "local") {
    return placement;
  }
  if (builtInPlacement !== undefined) return builtInPlacement;
  throw new Error("Embedded function registration is missing explicit placement metadata.");
}

async function mapHostedArguments(
  store: RuntimeStorageWriter,
  value: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const mapped = await mapHostedValue(store, value);
  return mapped === blockedHostedValue ? undefined : (mapped as Record<string, unknown>);
}

const blockedHostedValue = Symbol("blockedHostedValue");

async function mapHostedValue(store: RuntimeStorageWriter, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    const table = tableFromId(value);
    if (!table) return value;
    const mapping = await store.id.read(table, value);
    if (!mapping) return value;
    if (mapping.mapping === "mapped") return mapping.convexId;
    if (mapping.mapping === "deleted" && mapping.convexId !== undefined) return mapping.convexId;
    return blockedHostedValue;
  }
  if (Array.isArray(value)) {
    const mapped = await Promise.all(value.map((item) => mapHostedValue(store, item)));
    return mapped.includes(blockedHostedValue) ? blockedHostedValue : mapped;
  }
  if (value === null || typeof value !== "object" || value instanceof ArrayBuffer) return value;
  const entries = await Promise.all(
    Object.entries(value).map(
      async ([key, child]) => [key, await mapHostedValue(store, child)] as const,
    ),
  );
  if (entries.some(([, child]) => child === blockedHostedValue)) return blockedHostedValue;
  return Object.fromEntries(entries);
}

function exportedValidator(value: unknown): ValidatorJSON | undefined {
  if (typeof value !== "function") return undefined;
  return JSON.parse(value() as string) as ValidatorJSON;
}

function exportedReturns(value: unknown): ValidatorJSON | null | undefined {
  if (typeof value !== "function") return undefined;
  return JSON.parse(value() as string) as ValidatorJSON | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatValidator(validator: ValidatorJSON | undefined): string {
  const record = asRecord(validator);
  if (!record) return "unknown";
  const type = typeof record.type === "string" ? record.type : "unknown";
  if (type === "array") return `${formatValidator(record.value as ValidatorJSON)}[]`;
  if (type === "id" && typeof record.tableName === "string") return `Id<${record.tableName}>`;
  if (type === "literal") return JSON.stringify(record.value);
  if (type === "union") {
    const value = Array.isArray(record.value) ? record.value : [];
    return value.map((entry) => formatValidator(entry as ValidatorJSON)).join(" | ");
  }
  return type;
}

function placeholderForValidator(validator: ValidatorJSON | undefined): unknown {
  const record = asRecord(validator);
  if (!record) return null;
  switch (record.type) {
    case "string":
      return "";
    case "number":
    case "float64":
      return 0;
    case "int64":
      return "0";
    case "boolean":
      return false;
    case "null":
      return null;
    case "bytes":
      return "";
    case "id":
      return typeof record.tableName === "string" ? `${record.tableName}|...` : "";
    case "array":
      return [];
    case "object": {
      const fields = asRecord(record.value);
      if (!fields) return {};
      return Object.fromEntries(
        Object.entries(fields).flatMap(([name, field]) => {
          const fieldRecord = asRecord(field);
          if (fieldRecord?.optional === true) return [];
          return [[name, placeholderForValidator(fieldRecord?.fieldType as ValidatorJSON)]];
        }),
      );
    }
    case "literal":
      return record.value;
    default:
      return null;
  }
}

function validateArgs(
  fn: RunnableFunction,
  args: Record<string, unknown>,
  argsAreNormalized = false,
  allowPending = false,
): Record<string, unknown> {
  const checked = argsAreNormalized ? args : (normalizeCopy(args) as Record<string, unknown>);
  if (!allowPending) assertNoPendingCommitTs(checked, "function arguments");
  if (fn.args) {
    validateFields(checked, fn.args, "args");
  } else if (fn.argsJson) {
    validateJson(checked, fn.argsJson, "args");
  } else {
    assertValueWalk(checked, "args");
  }
  return checked;
}

function hostedIdArgs(fn: RunnableFunction, args: Record<string, unknown>): ValidatorIdValue[] {
  return validatorIdValues(fn.args ?? fn.argsJson, args).filter((ref) => !isLocalIdShape(ref.id));
}

function placeholderLocalId(table: string): string {
  return `${table}|${"0".repeat(32)}`;
}

/**
 * A remote-scoped query argument at a `v.id` position may carry a hosted id: substitute its local
 * twin when disclosed so the handler reads the local row, otherwise admit it verbatim so the
 * handler runs, `db.get` returns foreign+null, and the watch publishes its subscription and pulls.
 */
async function resolveQueryArgs(
  store: RuntimeStorageWriter,
  fn: RunnableFunction,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (store.remote === undefined) return validateArgs(fn, args);
  const hosted = hostedIdArgs(fn, args);
  if (hosted.length === 0) return validateArgs(fn, args);
  const handlerArgs = cloneTree(args) as Record<string, unknown>;
  const validationArgs = cloneTree(args) as Record<string, unknown>;
  for (const ref of hosted) {
    const localId = await hostedToLocal(store, ref.table, ref.id);
    if (localId !== undefined) {
      jsonPointerSlot(handlerArgs, ref.path)?.write(localId);
      jsonPointerSlot(validationArgs, ref.path)?.write(localId);
    } else {
      jsonPointerSlot(validationArgs, ref.path)?.write(placeholderLocalId(ref.table));
    }
  }
  validateArgs(fn, validationArgs);
  return handlerArgs;
}

/**
 * A remote-scoped mutation argument at a `v.id` position substitutes its local twin when disclosed;
 * an undisclosed hosted id is rejected at admission so a local-capable mutation never runs against a
 * row it cannot read, keeping replay symmetry intact.
 */
async function resolveMutationArgs(
  store: RuntimeStorageWriter,
  fn: RunnableFunction,
  args: Record<string, unknown>,
  argsAreNormalized: boolean,
  allowPending = false,
): Promise<Record<string, unknown>> {
  if (store.remote === undefined) return validateArgs(fn, args, argsAreNormalized, allowPending);
  const hosted = hostedIdArgs(fn, args);
  if (hosted.length === 0) return validateArgs(fn, args, argsAreNormalized, allowPending);
  const resolved = cloneTree(args) as Record<string, unknown>;
  for (const ref of hosted) {
    const localId = await hostedToLocal(store, ref.table, ref.id);
    if (localId === undefined) {
      throw new EmbeddedUnsupportedError(
        `mutation argument at ${ref.path} references a hosted ${ref.table} id that is not disclosed locally`,
      );
    }
    jsonPointerSlot(resolved, ref.path)?.write(localId);
  }
  return validateArgs(fn, resolved, false, allowPending);
}

function validateReturn(fn: RunnableFunction, value: unknown, allowPending = false): unknown {
  const normalized = normalizeCopy(value);
  if (!allowPending) assertNoPendingCommitTs(normalized, "function return value");
  if (fn.returns) validateValue(normalized, fn.returns, "return value");
  else if (fn.returnsJson) validateJson(normalized, fn.returnsJson, "return value");
  return normalized;
}

/** Resolve only the materialized JS side of a successful device commit. Rust has already
 * substituted the typed values before persistence; this keeps caches and emitted rows aligned. */
function resolveBatchCommitTs(batch: WriteBatch, timestamp: bigint): void {
  for (const write of batch.docWrites) {
    write.data = pendingCommitTsRead(write.data, timestamp);
  }
  for (const write of batch.localFieldWrites ?? []) {
    write.value = pendingCommitTsRead(write.value, timestamp);
  }
}

function collectVisibleDocIds(value: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object") return;
    if (seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record._id === "string") out.add(record._id);
    for (const item of Object.values(record)) walk(item);
  };
  walk(value);
  return out;
}

function compareSubscription(
  left: { fn: string; args: JSONValue },
  right: { fn: string; args: JSONValue },
): number {
  const leftKey = canonicalJson(left);
  const rightKey = canonicalJson(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
