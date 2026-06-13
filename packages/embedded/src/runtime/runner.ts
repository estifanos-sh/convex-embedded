import { getFunctionName } from "convex/server";
import type { GenericDataModel } from "convex/server";
import { convexToJson } from "convex/values";
import type { GenericValidator, PropertyValidators, Value, ValidatorJSON } from "convex/values";
import type { RuntimeStorageWriter, StoreSchema } from "../storage/types";
import {
  assertValueWalk,
  decode,
  decodeError,
  encode,
  encodeError,
  equals,
  normalizeCopy,
} from "./codec";
import { createReader, createWriter, toSchema } from "./database";
import type { FunctionReference, RegisteredFunction } from "./functions";
import type { ReadTracker } from "./query";
import { validateFields, validateJson, validateValue } from "./validate";

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
 * Watched-query value callback.
 *
 * @internal
 */
export type OnUpdateCallback = (value: unknown) => void;

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
  mutationId?: string;
  onAccepted?(this: void, mutationId: string): void;
}

/**
 * JavaScript Convex execution runner.
 *
 * @internal
 */
export interface Runner {
  runQuery(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  runMutation(
    ref: FunctionReference,
    args?: Record<string, unknown>,
    options?: RunMutationOptions,
  ): Promise<unknown>;
  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: OnUpdateCallback,
    onError?: OnUpdateErrorCallback,
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
export function watchKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, args: convexToJson(args as Value) });
}

/**
 * The key a watched query invalidates on. Today this is a table name; the alias is the seam for
 * finer-grained dependency tracking later.
 *
 * @internal
 */
export type InvalidationKey = string;

/**
 * Creates a local JavaScript Convex execution runner backed by embedded storage.
 *
 * @internal
 */
export function createRunner(
  modules: ModuleMap,
  store: RuntimeStorageWriter,
  storeSchema: StoreSchema,
): Runner {
  const schema = toSchema(storeSchema);
  const allTables = new Set<InvalidationKey>(storeSchema.tables.map((table) => table.name));
  const moduleCache = new Map<string, Promise<ModuleExports>>();
  const watchers = new Map<string, Watcher>();
  let mutationQueue: Promise<void> = Promise.resolve();

  const runQuery = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
    tracker?: ReadTracker,
    db = createReader<GenericDataModel>(store, schema, tracker),
  ): Promise<unknown> => {
    const fn = await loadFunction(modules, moduleCache, ref);
    if (fn.kind !== "query") throw new Error(`${describeRef(ref)} is not a query`);
    const checked = validateArgs(fn, args);
    const result = await fn.handler(
      {
        ...runtimeServices(),
        db,
        runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
          runQuery(childRef, childArgs, tracker, db),
      },
      checked,
    );
    return validateReturn(fn, result);
  };

  const createMutationTransaction = () => createWriter<GenericDataModel>(store, schema);
  type MutationTransaction = ReturnType<typeof createMutationTransaction>;

  const runMutationDirect = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
    options: RunMutationOptions = {},
    tx?: MutationTransaction,
  ): Promise<unknown> => {
    const root = tx ?? createMutationTransaction();
    const snapshot = tx?.snapshot();
    const fn = await loadFunction(modules, moduleCache, ref);
    if (fn.kind !== "mutation") throw new Error(`${describeRef(ref)} is not a mutation`);
    const checked = validateArgs(fn, args);
    if (!tx && options.mutationId && store.mutation) {
      const existing = await store.mutation.begin({
        args: encode(checked),
        mutationId: options.mutationId,
        name: functionName(ref),
      });
      options.onAccepted?.(options.mutationId);
      if (existing.status === "committed") {
        // The result was already validated when first committed; re-validating a replayed result
        // (and a committed `undefined` becomes `null`, never re-running the returns validator).
        return existing.result === undefined ? null : decode(existing.result);
      }
      if (existing.status === "failed") {
        throw decodeError(existing.error ?? `mutation failed: ${options.mutationId}`);
      }
    } else if (!tx && options.mutationId) {
      options.onAccepted?.(options.mutationId);
    }
    let validated: unknown;
    try {
      const result = await fn.handler(
        {
          ...runtimeServices(),
          db: root.db,
          runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            runQuery(childRef, childArgs, undefined, root.db),
          runSnapshotQuery: (
            childRef: FunctionReference,
            childArgs: Record<string, unknown> = {},
          ) => runQuery(childRef, childArgs),
          runMutation: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            runMutationDirect(childRef, childArgs, options, root),
        },
        checked,
      );
      validated = validateReturn(fn, result);
    } catch (error) {
      // Deterministic failure (handler threw or the return validator rejected): it reproduces on
      // replay, so record it as the mutation's terminal `failed` outcome (preserving ConvexError).
      if (snapshot) root.restore(snapshot);
      if (!tx && options.mutationId && store.mutation) {
        await store.mutation.fail(options.mutationId, encodeError(error)).catch(() => undefined);
      }
      throw error;
    }
    if (tx) return validated;
    try {
      const batch = root.toBatch();
      const commit = await store.commit(batch, {
        mutationId: options.mutationId,
        mutationResult: options.mutationId === undefined ? undefined : encode(validated),
        source: "local",
      });
      const tables = new Set(commit.changedTables);
      if (tables.size) notify(tables);
      return validated;
    } catch (error) {
      // Transient storage failure: NOT recorded as `failed`, so the mutation can be retried. The
      // ledger entry stays pending and a later replay re-runs the handler.
      if (snapshot) root.restore(snapshot);
      throw error;
    }
  };

  const rerun = (watcher: Watcher): void => {
    if (!watchers.has(watcher.key)) return;
    if (watcher.pendingTables) {
      watcher.dirty = true;
      return;
    }
    void (async () => {
      let tables = new Set<InvalidationKey>();
      try {
        do {
          watcher.dirty = false;
          watcher.missed = false;
          tables = new Set<InvalidationKey>();
          watcher.pendingTables = tables;
          try {
            const value = await runQuery(watcher.ref, watcher.args, {
              table: (table) => tables.add(table),
            });
            if (!watchers.has(watcher.key)) return;
            watcher.tables = tables;
            if (watcher.last?.kind !== "value" || !equals(watcher.last.value, value)) {
              watcher.last = { kind: "value", value };
              for (const subscriber of watcher.subscribers) {
                callSafely(() => subscriber.callback(value));
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
    })();
  };

  const notify = (tables: ReadonlySet<InvalidationKey>): void => {
    for (const watcher of watchers.values()) {
      if (intersects(watcher.pendingTables ?? watcher.tables, tables)) {
        rerun(watcher);
      } else if (watcher.pendingTables) {
        watcher.missed = true;
      }
    }
  };

  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const run = mutationQueue.then(task, task);
    mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async runQuery(ref, args = {}) {
      return runQuery(ref, normalizeCopy(args) as Record<string, unknown>);
    },
    async runMutation(ref, args = {}, options = {}) {
      const detached = normalizeCopy(args) as Record<string, unknown>;
      return enqueueMutation(() => runMutationDirect(ref, detached, options));
    },
    onUpdate(ref, args, callback, onError) {
      const detached = normalizeCopy(args) as Record<string, unknown>;
      const key = watchKey(functionName(ref), detached);
      const subscriber: Subscriber = { callback, onError };
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
          subscribers: new Set([subscriber]),
          tables: new Set(),
          pendingTables: null,
          dirty: false,
          missed: false,
          last: undefined,
        };
        watchers.set(key, watcher);
        rerun(watcher);
      }
      return () => {
        watcher.subscribers.delete(subscriber);
        if (!watcher.subscribers.size) watchers.delete(key);
      };
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
}

function runtimeServices(): {
  auth: { getUserIdentity(): Promise<null> };
  meta: Record<string, never>;
  scheduler: Record<string, unknown>;
  storage: Record<string, unknown>;
} {
  return {
    auth: {
      async getUserIdentity() {
        return null;
      },
    },
    meta: {},
    scheduler: unsupportedService("scheduler"),
    storage: unsupportedService("storage"),
  };
}

function unsupportedService(name: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol") return undefined;
        return () => {
          throw new Error(`Convex embedded runtime does not support ctx.${name}.${property} yet.`);
        };
      },
    },
  );
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function callSafely(call: () => void): void {
  try {
    call();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

interface RunnableFunction {
  kind: "query" | "mutation";
  args?: PropertyValidators;
  returns?: GenericValidator;
  argsJson?: ValidatorJSON;
  returnsJson?: ValidatorJSON | null;
  handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
}

async function loadFunction(
  modules: ModuleMap,
  moduleCache: Map<string, Promise<ModuleExports>>,
  ref: FunctionReference,
): Promise<RunnableFunction> {
  const fullName = functionName(ref);
  const sep = fullName.indexOf(":");
  const file = sep < 0 ? fullName : fullName.slice(0, sep);
  const name = sep < 0 ? "default" : fullName.slice(sep + 1);
  const module = await loadModule(modules, moduleCache, file);
  const fn = module[name];
  const registered = toRunnable(fn);
  if (!registered) throw new Error(`not a registered function: ${fullName}`);
  return registered;
}

function loadModule(
  modules: ModuleMap,
  moduleCache: Map<string, Promise<ModuleExports>>,
  file: string,
): Promise<ModuleExports> {
  const cached = moduleCache.get(file);
  if (cached) return cached;

  const entry = modules[file];
  if (!entry) throw new Error(`unknown module: ${file}`);

  const loading = typeof entry === "function" ? entry() : Promise.resolve(entry);
  const cachedLoading = loading.catch((error) => {
    moduleCache.delete(file);
    throw error;
  });
  moduleCache.set(file, cachedLoading);
  return cachedLoading;
}

function functionName(ref: FunctionReference): string {
  return typeof ref === "string" ? ref : getFunctionName(ref);
}

function describeRef(ref: FunctionReference): string {
  try {
    return functionName(ref);
  } catch {
    return JSON.stringify(ref);
  }
}

function toRunnable(value: unknown): RunnableFunction | undefined {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const candidate = value as RegisteredFunction;
    if (candidate.kind === "query" || candidate.kind === "mutation") {
      return {
        kind: candidate.kind,
        args: candidate.args,
        returns: candidate.returns,
        handler: candidate.handler as RunnableFunction["handler"],
      };
    }
  }
  if (typeof value !== "function") return undefined;
  const record = value as unknown as Record<string, unknown>;
  const handler = record._handler;
  if (typeof handler !== "function") return undefined;
  const kind =
    record.isQuery === true ? "query" : record.isMutation === true ? "mutation" : undefined;
  if (!kind) return undefined;
  return {
    kind,
    handler: handler as RunnableFunction["handler"],
    argsJson: exportedValidator(record.exportArgs),
    returnsJson: exportedReturns(record.exportReturns),
  };
}

function exportedValidator(value: unknown): ValidatorJSON | undefined {
  if (typeof value !== "function") return undefined;
  return JSON.parse(value() as string) as ValidatorJSON;
}

function exportedReturns(value: unknown): ValidatorJSON | null | undefined {
  if (typeof value !== "function") return undefined;
  return JSON.parse(value() as string) as ValidatorJSON | null;
}

function validateArgs(
  fn: RunnableFunction,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const checked = normalizeCopy(args) as Record<string, unknown>;
  if (fn.args) {
    validateFields(checked, fn.args, "args");
  } else if (fn.argsJson) {
    validateJson(checked, fn.argsJson, "args");
  } else {
    assertValueWalk(checked, "args");
  }
  return checked;
}

function validateReturn(fn: RunnableFunction, value: unknown): unknown {
  const normalized = normalizeCopy(value);
  if (fn.returns) validateValue(normalized, fn.returns, "return value");
  else if (fn.returnsJson) validateJson(normalized, fn.returnsJson, "return value");
  return normalized;
}
