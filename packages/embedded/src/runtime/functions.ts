import type { GenericDataModel } from "convex/server";
import type { ObjectType, PropertyValidators } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "./database";

export interface QueryCtx<DM extends GenericDataModel> {
  db: DatabaseReader<DM>;
}

export interface MutationCtx<DM extends GenericDataModel> {
  db: DatabaseWriter<DM>;
}

export type FunctionReference = string;

export interface RegisteredQuery {
  kind: "query";
  handler: (ctx: QueryCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

export interface RegisteredMutation {
  kind: "mutation";
  handler: (ctx: MutationCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

export type RegisteredFunction = RegisteredQuery | RegisteredMutation;

interface QueryDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  handler: (ctx: QueryCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

interface MutationDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  handler: (ctx: MutationCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

export interface Functions<DM extends GenericDataModel> {
  query: <Args extends PropertyValidators, Output>(
    def: QueryDefinition<DM, Args, Output>,
  ) => RegisteredQuery;
  mutation: <Args extends PropertyValidators, Output>(
    def: MutationDefinition<DM, Args, Output>,
  ) => RegisteredMutation;
}

export function defineFunctions<DM extends GenericDataModel>(): Functions<DM> {
  return {
    query: (def) => ({
      kind: "query",
      handler: def.handler as unknown as RegisteredQuery["handler"],
    }),
    mutation: (def) => ({
      kind: "mutation",
      handler: def.handler as unknown as RegisteredMutation["handler"],
    }),
  };
}
