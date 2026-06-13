import type { GenericDataModel } from "convex/server";
import type { GenericValidator, ObjectType, PropertyValidators, Validator } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "./database";

/**
 * Query context passed to locally registered Convex query handlers.
 *
 * @internal
 */
export interface QueryCtx<DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<null> };
  db: DatabaseReader<DM>;
  meta: Record<string, never>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  storage: Record<string, unknown>;
}

/**
 * Mutation context passed to locally registered Convex mutation handlers.
 *
 * @internal
 */
export interface MutationCtx<DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<null> };
  db: DatabaseWriter<DM>;
  meta: Record<string, never>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runMutation: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runSnapshotQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  scheduler: Record<string, unknown>;
  storage: Record<string, unknown>;
}

/**
 * Function reference accepted by the local runner.
 *
 * @internal
 */
export type FunctionReference =
  | string
  | import("convex/server").FunctionReference<"query" | "mutation", any, any, any, any>;

/**
 * Runtime representation of a query registered with {@link defineFunctions}.
 *
 * @internal
 */
export interface RegisteredQuery {
  kind: "query";
  args?: PropertyValidators;
  returns?: GenericValidator;
  handler: (ctx: QueryCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/**
 * Runtime representation of a mutation registered with {@link defineFunctions}.
 *
 * @internal
 */
export interface RegisteredMutation {
  kind: "mutation";
  args?: PropertyValidators;
  returns?: GenericValidator;
  handler: (ctx: MutationCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/**
 * Runtime function definition accepted by the local runner.
 *
 * @internal
 */
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

/**
 * Local function registration helpers used by tests and embedded runtime fixtures.
 *
 * @internal
 */
export interface Functions<DM extends GenericDataModel> {
  query: <Args extends PropertyValidators, Output>(
    def: QueryDefinition<DM, Args, Output>,
  ) => RegisteredQuery;
  mutation: <Args extends PropertyValidators, Output>(
    def: MutationDefinition<DM, Args, Output>,
  ) => RegisteredMutation;
}

/**
 * Creates local query/mutation registration helpers.
 *
 * @internal
 */
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
