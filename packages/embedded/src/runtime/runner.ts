import { getFunctionName } from "convex/server";
import type { GenericDataModel } from "convex/server";
import type { GenericValidator, PropertyValidators, ValidatorJSON } from "convex/values";
import type { RuntimeStorageWriter, StoreSchema, WriteBatch } from "../storage/types";
import { assertValue, clone, equals, fromJson, normalize, normalizeObject } from "./codec";
import { createReader, createWriter, toSchema } from "./database";
import type { FunctionReference, RegisteredFunction } from "./functions";
import type { ReadTracker } from "./query";
import { tableFromId } from "./values";

export type ModuleMap = Record<string, Record<string, unknown>>;
export type OnUpdateCallback = (value: unknown) => void;
export type OnUpdateErrorCallback = (error: unknown) => void;
export type StopOnUpdate = () => void;

export interface Runner {
  runQuery(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  runMutation(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  onUpdate(
    ref: FunctionReference,
    args: Record<string, unknown>,
    callback: OnUpdateCallback,
    onError?: OnUpdateErrorCallback,
  ): StopOnUpdate;
}

export function createRunner(
  modules: ModuleMap,
  store: RuntimeStorageWriter,
  storeSchema: StoreSchema,
): Runner {
  const schema = toSchema(storeSchema);
  const allTables = new Set(storeSchema.tables.map((table) => table.name));
  const watchers = new Set<Watcher>();
  let mutationQueue: Promise<void> = Promise.resolve();

  const runTrackedQuery = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; tables: Set<string> }> => {
    const tables = new Set<string>();
    const tracker: ReadTracker = { table: (table) => tables.add(table) };
    const value = await runQuery(ref, args, tracker);
    return { value, tables };
  };

  const runQuery = (
    ref: FunctionReference,
    args: Record<string, unknown>,
    tracker?: ReadTracker,
  ): Promise<unknown> => {
    const fn = find(modules, ref);
    if (fn.kind !== "query") throw new Error(`${describeRef(ref)} is not a query`);
    const checked = validateArgs(fn, args);
    return Promise.resolve(
      fn.handler(
        {
          db: createReader<GenericDataModel>(store, schema, tracker),
          runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
            runQuery(childRef, childArgs, tracker),
        },
        checked,
      ),
    ).then((result) => validateReturn(fn, result));
  };

  const runMutationDirect = async (
    ref: FunctionReference,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const fn = find(modules, ref);
    if (fn.kind !== "mutation") throw new Error(`${describeRef(ref)} is not a mutation`);
    const checked = validateArgs(fn, args);
    const { db, toBatch } = createWriter<GenericDataModel>(store, schema);
    const result = await fn.handler(
      {
        db,
        runQuery: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
          runQuery(childRef, childArgs),
        runMutation: (childRef: FunctionReference, childArgs: Record<string, unknown> = {}) =>
          runMutationDirect(childRef, childArgs),
      },
      checked,
    );
    const validated = validateReturn(fn, result);
    const batch = toBatch();
    await store.commit(batch);
    const tables = changedTables(batch);
    if (tables.size) notify(tables);
    return validated;
  };

  const rerun = (watcher: Watcher): void => {
    if (!watchers.has(watcher)) return;
    if (watcher.running) {
      watcher.dirty = true;
      return;
    }
    watcher.running = true;
    void (async () => {
      try {
        do {
          watcher.dirty = false;
          const { value, tables } = await runTrackedQuery(watcher.ref, watcher.args);
          if (!watchers.has(watcher)) return;
          watcher.tables = tables;
          if (!watcher.hasValue || !equals(watcher.value, value)) {
            watcher.hasValue = true;
            watcher.value = value;
            watcher.callback(value);
          }
        } while (watcher.dirty && watchers.has(watcher));
      } catch (error) {
        if (!watchers.has(watcher)) return;
        watcher.tables = new Set(allTables);
        watcher.onError?.(error);
      }
    })().finally(() => {
      watcher.running = false;
      if (watcher.dirty && watchers.has(watcher)) rerun(watcher);
    });
  };

  const notify = (tables: ReadonlySet<string>): void => {
    for (const watcher of watchers) {
      if (watcher.running || intersects(watcher.tables, tables)) rerun(watcher);
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
      return runQuery(ref, clone(args) as Record<string, unknown>);
    },
    async runMutation(ref, args = {}) {
      const snapshot = clone(args) as Record<string, unknown>;
      return enqueueMutation(() => runMutationDirect(ref, snapshot));
    },
    onUpdate(ref, args, callback, onError) {
      const fn = find(modules, ref);
      if (fn.kind !== "query") throw new Error(`${describeRef(ref)} is not a query`);
      const watcher: Watcher = {
        ref,
        args: clone(args) as Record<string, unknown>,
        callback,
        onError,
        tables: new Set(),
        running: false,
        dirty: false,
        hasValue: false,
        value: undefined,
      };
      watchers.add(watcher);
      rerun(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}

interface Watcher {
  ref: FunctionReference;
  args: Record<string, unknown>;
  callback: OnUpdateCallback;
  onError: OnUpdateErrorCallback | undefined;
  tables: Set<string>;
  running: boolean;
  dirty: boolean;
  hasValue: boolean;
  value: unknown;
}

function changedTables(batch: WriteBatch): Set<string> {
  const tables = new Set<string>();
  for (const upsert of batch.upserts) tables.add(upsert.table);
  for (const del of batch.deletes) tables.add(del.table);
  return tables;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

interface RunnableFunction {
  kind: "query" | "mutation";
  args?: PropertyValidators;
  returns?: GenericValidator;
  argsJson?: ValidatorJSON;
  returnsJson?: ValidatorJSON | null;
  handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
}

function find(modules: ModuleMap, ref: FunctionReference): RunnableFunction {
  const fullName = functionName(ref);
  const sep = fullName.indexOf(":");
  const file = sep < 0 ? fullName : fullName.slice(0, sep);
  const name = sep < 0 ? "default" : fullName.slice(sep + 1);
  const module = modules[file];
  if (!module) throw new Error(`unknown module: ${file}`);
  const fn = module[name];
  const registered = toRunnable(fn);
  if (!registered) throw new Error(`not a registered function: ${fullName}`);
  return registered;
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
  const normalized = normalizeObject(args);
  if (fn.args) {
    validateFields(normalized, fn.args, "args");
  } else if (fn.argsJson) {
    validateJson(normalized, fn.argsJson, "args");
  } else {
    assertValue(normalized, "args");
  }
  return normalized;
}

function validateReturn(fn: RunnableFunction, value: unknown): unknown {
  const normalized = normalize(value);
  if (fn.returns) validateValue(normalized, fn.returns, "return value");
  else if (fn.returnsJson) validateJson(normalized, fn.returnsJson, "return value");
  else assertValue(normalized, "return value");
  return normalized;
}

function validateFields(
  value: Record<string, unknown>,
  fields: PropertyValidators,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`${path}.${key} is not a declared argument`);
  }
  for (const [key, validator] of Object.entries(fields)) {
    validateValue(value[key], validator as GenericValidator, `${path}.${key}`);
  }
}

function validateValue(value: unknown, validator: GenericValidator, path: string): void {
  if (isOptional(validator) && value === undefined) return;
  if (value === undefined) throw new Error(`${path} is required`);
  switch (validator.kind) {
    case "any":
      assertValue(value, path);
      return;
    case "id":
      if (typeof value !== "string") throw new Error(`${path} must be an id`);
      if (validator.tableName && tableFromId(value) !== validator.tableName) {
        throw new Error(`${path} must be an id for table ${validator.tableName}`);
      }
      return;
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      return;
    case "float64":
      if (typeof value !== "number") throw new Error(`${path} must be a number`);
      return;
    case "int64":
      if (typeof value !== "bigint") throw new Error(`${path} must be an int64`);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return;
    case "bytes":
      if (!(value instanceof ArrayBuffer)) throw new Error(`${path} must be bytes`);
      return;
    case "null":
      if (value !== null) throw new Error(`${path} must be null`);
      return;
    case "literal":
      if (!equals(value, validator.value)) throw new Error(`${path} must be the literal value`);
      return;
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      value.forEach((entry, i) => validateValue(entry, validator.element, `${path}[${i}]`));
      return;
    case "object":
      validateRecordObject(value, path);
      validateFields(value as Record<string, unknown>, validator.fields, path);
      return;
    case "record":
      validateRecordObject(value, path);
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        validateValue(key, validator.key, `${path}.${key} key`);
        validateValue(entry, validator.value, `${path}.${key}`);
      }
      return;
    case "union":
      for (const member of validator.members) {
        try {
          validateValue(value, member, path);
          return;
        } catch {
          // Try the next union member.
        }
      }
      throw new Error(`${path} does not match any union member`);
  }
}

function validateJson(value: unknown, validator: ValidatorJSON, path: string): void {
  switch (validator.type) {
    case "any":
      assertValue(value, path);
      return;
    case "id":
      if (typeof value !== "string") throw new Error(`${path} must be an id`);
      if (tableFromId(value) !== validator.tableName) {
        throw new Error(`${path} must be an id for table ${validator.tableName}`);
      }
      return;
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      return;
    case "number":
      if (typeof value !== "number") throw new Error(`${path} must be a number`);
      return;
    case "bigint":
      if (typeof value !== "bigint") throw new Error(`${path} must be an int64`);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return;
    case "bytes":
      if (!(value instanceof ArrayBuffer)) throw new Error(`${path} must be bytes`);
      return;
    case "null":
      if (value !== null) throw new Error(`${path} must be null`);
      return;
    case "literal":
      if (!equals(value, fromJson(validator.value)))
        throw new Error(`${path} must be the literal value`);
      return;
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      value.forEach((entry, i) => validateJson(entry, validator.value, `${path}[${i}]`));
      return;
    case "object":
      validateRecordObject(value, path);
      validateJsonFields(value as Record<string, unknown>, validator.value, path);
      return;
    case "record":
      validateRecordObject(value, path);
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        validateJsonRecordKey(key, validator.keys, `${path}.${key} key`);
        validateJson(entry, validator.values.fieldType, `${path}.${key}`);
      }
      return;
    case "union":
      for (const member of validator.value) {
        try {
          validateJson(value, member, path);
          return;
        } catch {
          // Try the next union member.
        }
      }
      throw new Error(`${path} does not match any union member`);
  }
}

function validateJsonFields(
  value: Record<string, unknown>,
  fields: Extract<ValidatorJSON, { type: "object" }>["value"],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`${path}.${key} is not a declared field`);
  }
  for (const [key, field] of Object.entries(fields)) {
    if (value[key] === undefined && field.optional) continue;
    validateJson(value[key], field.fieldType, `${path}.${key}`);
  }
}

function validateJsonRecordKey(
  value: string,
  validator: Extract<ValidatorJSON, { type: "record" }>["keys"],
  path: string,
): void {
  if (validator.type === "string") return;
  if (validator.type === "id") {
    if (tableFromId(value) !== validator.tableName) {
      throw new Error(`${path} must be an id for table ${validator.tableName}`);
    }
    return;
  }
  throw new Error(`${path} has unsupported record key validator`);
}

function validateRecordObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof ArrayBuffer ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${path} must be an object`);
  }
}

function isOptional(validator: GenericValidator): boolean {
  return validator.isOptional === "optional";
}
