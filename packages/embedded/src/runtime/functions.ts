import type { GenericDataModel } from "convex/server";
import type { UserIdentity } from "convex/server";
import type { GenericValidator, ObjectType, PropertyValidators, Validator } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "./database";

/** Where an authored Embedded function is allowed to execute. @internal */
export type FunctionPlacement = "replicated" | "remote" | "local";

/** Query context passed to locally executable query handlers. @internal */
export interface QueryCtx<DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  db: DatabaseReader<DM>;
  meta: Record<string, never>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  storage: Record<string, unknown>;
}

/** Mutation context passed to locally executable mutation handlers. @internal */
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

/** Action context used by hosted-only test/runtime registrations. @internal */
export interface ActionCtx<_DM extends GenericDataModel> {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  meta: Record<string, never>;
  runAction: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runMutation: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  runQuery: (ref: FunctionReference, args?: Record<string, unknown>) => Promise<unknown>;
  scheduler: Record<string, unknown>;
  storage: Record<string, unknown>;
}

/** Function reference accepted by the Embedded runner. @internal */
export type FunctionReference =
  | string
  | { kind: "query" | "mutation"; placement: "local" }
  | import("convex/server").FunctionReference<"query" | "mutation" | "action", any, any, any, any>;

/** Public/internal visibility for runtime functions. @internal */
export type FunctionVisibility = "public" | "internal";

interface RegisteredBase {
  placement: FunctionPlacement;
  args?: PropertyValidators;
  returns?: GenericValidator;
  visibility?: FunctionVisibility;
}

/** Runtime representation of a query. @internal */
export interface RegisteredQuery extends RegisteredBase {
  kind: "query";
  handler: (ctx: QueryCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/** Runtime representation of a mutation. @internal */
export interface RegisteredMutation extends RegisteredBase {
  kind: "mutation";
  handler: (ctx: MutationCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/** Runtime representation of a hosted action. @internal */
export interface RegisteredAction extends RegisteredBase {
  kind: "action";
  placement: "remote";
  handler: (ctx: ActionCtx<GenericDataModel>, args: Record<string, unknown>) => unknown;
}

/** Runtime function definition accepted by the local runner. @internal */
export type RegisteredFunction = RegisteredQuery | RegisteredMutation | RegisteredAction;

interface QueryDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: QueryCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

interface MutationDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: MutationCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

interface ActionDefinition<DM extends GenericDataModel, Args extends PropertyValidators, Output> {
  args?: Args;
  returns?: Validator<Output, any, any>;
  visibility?: FunctionVisibility;
  handler: (ctx: ActionCtx<DM>, args: ObjectType<Args>) => Output | Promise<Output>;
}

interface QueryBuilder<DM extends GenericDataModel> {
  <Args extends PropertyValidators, Output>(
    def: QueryDefinition<DM, Args, Output>,
  ): RegisteredQuery;
}

interface MutationBuilder<DM extends GenericDataModel> {
  <Args extends PropertyValidators, Output>(
    def: MutationDefinition<DM, Args, Output>,
  ): RegisteredMutation;
}

/** Placement-first registration helpers used by generated modules and runtime tests. @internal */
export interface Functions<DM extends GenericDataModel> {
  replicated: { query: QueryBuilder<DM>; mutation: MutationBuilder<DM> };
  remote: {
    query: QueryBuilder<DM>;
    mutation: MutationBuilder<DM>;
    action: <Args extends PropertyValidators, Output>(
      def: ActionDefinition<DM, Args, Output>,
    ) => RegisteredAction;
  };
}

/** Creates explicit placement registration helpers. @internal */
export function defineFunctions<DM extends GenericDataModel>(): Functions<DM> {
  const query =
    (placement: FunctionPlacement): QueryBuilder<DM> =>
    (def) => ({
      kind: "query",
      placement,
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      visibility: def.visibility,
      handler: def.handler as unknown as RegisteredQuery["handler"],
    });
  const mutation =
    (placement: FunctionPlacement): MutationBuilder<DM> =>
    (def) => ({
      kind: "mutation",
      placement,
      args: def.args,
      returns: def.returns as GenericValidator | undefined,
      visibility: def.visibility,
      handler: def.handler as unknown as RegisteredMutation["handler"],
    });
  return {
    replicated: { query: query("replicated"), mutation: mutation("replicated") },
    remote: {
      query: query("remote"),
      mutation: mutation("remote"),
      action: (def) => ({
        kind: "action",
        placement: "remote",
        args: def.args,
        returns: def.returns as GenericValidator | undefined,
        visibility: def.visibility,
        handler: def.handler as unknown as RegisteredAction["handler"],
      }),
    },
  };
}
