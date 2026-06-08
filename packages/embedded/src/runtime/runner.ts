import type { GenericDataModel } from "convex/server";
import type { EmbeddedStore } from "../storage/store";
import { createReader, createWriter, type Schema } from "./database";
import type { FunctionReference, RegisteredFunction } from "./functions";

export type ModuleMap = Record<string, Record<string, unknown>>;

export interface Runner {
  runQuery(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  runMutation(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
}

export function createRunner(modules: ModuleMap, store: EmbeddedStore, schema: Schema): Runner {
  return {
    async runQuery(ref, args = {}) {
      const fn = find(modules, ref);
      if (fn.kind !== "query") throw new Error(`${ref} is not a query`);
      return fn.handler({ db: createReader<GenericDataModel>(store, schema) }, args);
    },
    async runMutation(ref, args = {}) {
      const fn = find(modules, ref);
      if (fn.kind !== "mutation") throw new Error(`${ref} is not a mutation`);
      const { db, toBatch } = createWriter<GenericDataModel>(store, schema);
      const result = await fn.handler({ db }, args);
      await store.commit(toBatch());
      return result;
    },
  };
}

function find(modules: ModuleMap, ref: FunctionReference): RegisteredFunction {
  const sep = ref.indexOf(":");
  if (sep < 0) throw new Error(`invalid function reference: ${JSON.stringify(ref)}`);
  const file = ref.slice(0, sep);
  const name = ref.slice(sep + 1);
  const module = modules[file];
  if (!module) throw new Error(`unknown module: ${file}`);
  const fn = module[name];
  if (!registered(fn)) throw new Error(`not a registered function: ${ref}`);
  return fn;
}

function registered(value: unknown): value is RegisteredFunction {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "query" || kind === "mutation";
}
