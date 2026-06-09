import type { GenericDataModel } from "convex/server";
import type { GenericValidator, ObjectType, PropertyValidators, Validator } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "./database";

export interface QueryCtx<DM extends GenericDataModel> {
  db: DatabaseReader<DM>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface MutationCtx<DM extends GenericDataModel> {
  db: DatabaseWriter<DM>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runMutation: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
}

export type FunctionReference =
  | string
  | import("convex/server").FunctionReference<"query" | "mutation", any, any, any, any>;

export interface RegisteredQuery {
  kind: "query";
  args?: PropertyValidators;
  returns?: GenericValidator;
  handler: (ctx: QueryCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

export interface RegisteredMutation {
  kind: "mutation";
  args?: PropertyValidators;
  returns?: GenericValidator;
  handler: (ctx: MutationCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

export type RegisteredFunction = RegisteredQuery | RegisteredMutation;

interface QueryDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  handler: (ctx: QueryCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

interface MutationDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
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
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      handler: def.handler as unknown as RegisteredQuery["handler"],
    }),
    mutation: (def) => ({
      kind: "mutation",
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      handler: def.handler as unknown as RegisteredMutation["handler"],
    }),
  };
}
