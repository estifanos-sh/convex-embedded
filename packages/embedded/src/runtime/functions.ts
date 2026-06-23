import type { GenericDataModel } from "convex/server";
import type { UserIdentity } from "convex/server";
import type { GenericValidator, ObjectType, PropertyValidators, Validator } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "./database";

/**
 * Query context passed to locally registered Convex query handlers.
 *
 * @internal
 */
export interface QueryCtx<DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
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
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  db: DatabaseWriter<DM>;
  meta: Record<string, never>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runMutation: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runSnapshotQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  scheduler: Record<string, unknown>;
  storage: Record<string, unknown>;
}

/**
 * Action context passed to locally registered Convex action handlers.
 *
 * @internal
 */
export interface ActionCtx<_DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  meta: Record<string, never>;
  runAction: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runMutation: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
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
  | import("convex/server").FunctionReference<"query" | "mutation" | "action", any, any, any, any>;

/**
 * Public/internal visibility for local test/runtime functions.
 *
 * @internal
 */
export type FunctionVisibility = "public" | "internal";

/**
 * Runtime representation of a query registered with {@link defineFunctions}.
 *
 * @internal
 */
export interface RegisteredQuery {
  kind: "query";
  local?: boolean;
  args?: PropertyValidators;
  returns?: GenericValidator;
  visibility?: FunctionVisibility;
  handler: (ctx: QueryCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/**
 * Runtime representation of a mutation registered with {@link defineFunctions}.
 *
 * @internal
 */
export interface RegisteredMutation {
  kind: "mutation";
  local?: boolean;
  args?: PropertyValidators;
  returns?: GenericValidator;
  visibility?: FunctionVisibility;
  handler: (ctx: MutationCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/**
 * Runtime representation of an action registered with {@link defineFunctions}.
 *
 * @internal
 */
export interface RegisteredAction {
  kind: "action";
  local?: boolean;
  args?: PropertyValidators;
  returns?: GenericValidator;
  visibility?: FunctionVisibility;
  handler: (ctx: ActionCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/**
 * Runtime function definition accepted by the local runner.
 *
 * @internal
 */
export type RegisteredFunction = RegisteredQuery | RegisteredMutation | RegisteredAction;

interface QueryDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: QueryCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
  local?: boolean;
}

interface MutationDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: MutationCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
  local?: boolean;
}

interface ActionDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: ActionCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
  local?: boolean;
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
  action: <Args extends PropertyValidators, Output>(
    def: ActionDefinition<DM, Args, Output>,
  ) => RegisteredAction;
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
      local: def.local,
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      visibility: def.visibility,
      handler: def.handler as unknown as RegisteredQuery["handler"],
    }),
    mutation: (def) => ({
      kind: "mutation",
      local: def.local,
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      visibility: def.visibility,
      handler: def.handler as unknown as RegisteredMutation["handler"],
    }),
    action: (def) => ({
      kind: "action",
      local: def.local,
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      visibility: def.visibility,
      handler: def.handler as unknown as RegisteredAction["handler"],
    }),
  };
}
