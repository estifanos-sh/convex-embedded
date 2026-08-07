import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  GenericDataModel,
  ReturnValueForOptionalValidator,
} from "convex/server";
import type { GenericValidator, PropertyValidators, Validator } from "convex/values";

import type {
  ActionCtx as RuntimeActionCtx,
  FunctionVisibility,
  MutationCtx as RuntimeMutationCtx,
  QueryCtx as RuntimeQueryCtx,
} from "./runtime/functions";
import type { LedgerReader } from "./runtime/ledger";

/** Context passed to device-only query handlers. */
export type LocalQueryCtx<DataModel extends GenericDataModel> = Omit<
  RuntimeQueryCtx<DataModel>,
  "storage"
>;

/** Context passed to device-only mutation handlers. */
export type LocalMutationCtx<DataModel extends GenericDataModel> = Omit<
  RuntimeMutationCtx<DataModel>,
  "scheduler" | "storage"
>;

/** Context passed to a device-only action. Actions orchestrate separate query/mutation calls. */
export type LocalActionCtx<DataModel extends GenericDataModel> = Omit<
  RuntimeActionCtx<DataModel>,
  "scheduler" | "storage" | "runAction"
> & {
  /** Frozen pre-cutover records, available only while `client.open(setup)` is running. */
  ledger: LedgerReader;
};

declare const localFunction: unique symbol;

/** A device-only function value; usable directly as a client function reference. */
export type LocalFunction<
  Kind extends "query" | "mutation" | "action",
  Visibility extends FunctionVisibility,
  Args,
  Returns,
> = {
  readonly kind: Kind;
  readonly placement: "local";
  readonly visibility: Visibility;
  readonly [localFunction]: [Args, Returns];
};

export type LocalQuery<Visibility extends FunctionVisibility, Args, Returns> = LocalFunction<
  "query",
  Visibility,
  Args,
  Returns
>;

export type LocalMutation<Visibility extends FunctionVisibility, Args, Returns> = LocalFunction<
  "mutation",
  Visibility,
  Args,
  Returns
>;

/** A device-only action. Internal actions are valid `client.open()` setup functions. */
export type LocalAction<Visibility extends FunctionVisibility, Args, Returns> = LocalFunction<
  "action",
  Visibility,
  Args,
  Returns
>;

export type LocalFunctionArgs<F> =
  F extends LocalFunction<any, any, infer Args, any> ? Args : never;

export type LocalFunctionReturns<F> =
  F extends LocalFunction<any, any, any, infer Returns> ? Promise<Awaited<Returns>> : never;

export type LocalQueryBuilder<
  DataModel extends GenericDataModel,
  Visibility extends FunctionVisibility,
> = <
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(definition: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: LocalQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => LocalQuery<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

export type LocalMutationBuilder<
  DataModel extends GenericDataModel,
  Visibility extends FunctionVisibility,
> = <
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(definition: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: LocalMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => LocalMutation<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>;

export type LocalActionBuilder<
  DataModel extends GenericDataModel,
  Visibility extends FunctionVisibility,
> = <
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(definition: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: LocalActionCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => LocalAction<Visibility, ArgsArrayToObject<OneOrZeroArgs>, Awaited<ReturnValue>>;

/** Device-only function builders typed against one Embedded schema. */
export type LocalBuilders<DataModel extends GenericDataModel> = {
  query: LocalQueryBuilder<DataModel, "public">;
  mutation: LocalMutationBuilder<DataModel, "public">;
  internalQuery: LocalQueryBuilder<DataModel, "internal">;
  internalMutation: LocalMutationBuilder<DataModel, "internal">;
  internalAction: LocalActionBuilder<DataModel, "internal">;
};
