import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  GenericDataModel,
  ReturnValueForOptionalValidator,
} from "convex/server";
import type { GenericValidator, PropertyValidators, Validator } from "convex/values";
import { bindLocalSchema, stampLocalGraph } from "./local/internal";

import {
  hasEmbeddedSchemaMeta,
  type ConvexEmbeddedSchema,
  type DeviceDataModel,
  type EmbeddedSchemaDefinition,
} from "./schema";
import type {
  ActionCtx as RuntimeActionCtx,
  FunctionVisibility,
  MutationCtx as RuntimeMutationCtx,
  QueryCtx as RuntimeQueryCtx,
} from "./runtime/functions";

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
>;

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

/**
 * Application-side type registration for the `local` namespace. The Embedded bundler plugin
 * augments it from the generated lockfile, binding the builders to the project schema.
 */
export interface Register {}

type UnregisteredSchema =
  "The Embedded bundler plugin registers your schema through the module it generates in your convex directory; wire the plugin and include that module in this TypeScript program";

type UnregisteredBuilder = (definition: UnregisteredSchema) => never;

type RegisteredLocal = Register extends { schema: infer Schema extends EmbeddedSchemaDefinition }
  ? LocalBuilders<DeviceDataModel<Schema>>
  : {
      query: UnregisteredBuilder;
      mutation: UnregisteredBuilder;
      internalQuery: UnregisteredBuilder;
      internalMutation: UnregisteredBuilder;
      internalAction: UnregisteredBuilder;
    };

/** Device-only function builders typed via the app's {@link Register} declaration. */
export const local = {
  query: builder("query", "public"),
  mutation: builder("mutation", "public"),
  internalQuery: builder("query", "internal"),
  internalMutation: builder("mutation", "internal"),
  internalAction: builder("action", "internal"),
} as unknown as RegisteredLocal;

/** Create device-only builders bound to an explicit schema value instead of {@link Register}. */
export function defineLocal<Schema extends EmbeddedSchemaDefinition>(
  schema: Schema,
): LocalBuilders<DeviceDataModel<Schema>> {
  if (!hasEmbeddedSchemaMeta(schema as ConvexEmbeddedSchema)) {
    throw new Error("defineLocal requires the schema exported by defineEmbeddedSchema.");
  }
  return {
    query: builder("query", "public", schema),
    mutation: builder("mutation", "public", schema),
    internalQuery: builder("query", "internal", schema),
    internalMutation: builder("mutation", "internal", schema),
    internalAction: builder("action", "internal", schema),
  } as unknown as LocalBuilders<DeviceDataModel<Schema>>;
}

function builder(
  kind: "query" | "mutation" | "action",
  visibility: FunctionVisibility,
  schema?: ConvexEmbeddedSchema,
) {
  return (definition: {
    args?: PropertyValidators | GenericValidator;
    returns?: PropertyValidators | GenericValidator;
    handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
  }) => ({
    kind,
    placement: "local" as const,
    visibility,
    args: definition.args,
    returns: definition.returns,
    handler: definition.handler,
    __embeddedHandler: definition.handler,
    __embeddedPlacement: "local" as const,
    ...bindLocalSchema({}, schema),
  });
}

export const EMBEDDED_LOCAL_REFERENCE = "__embeddedLocalReference";

/**
 * Names every local registration exported by one device module. The bundler appends a call per
 * module under the configured local roots so page-bundle copies dispatch by the same name the
 * worker's copies carry; non-registration exports pass through untouched.
 *
 * @internal
 */
export function stampLocal(
  moduleId: string,
  graphHashOrExports: string | Record<string, unknown>,
  maybeExports?: Record<string, unknown>,
): void {
  const graphHash = typeof graphHashOrExports === "string" ? graphHashOrExports : undefined;
  const exports =
    typeof graphHashOrExports === "string" ? (maybeExports ?? {}) : graphHashOrExports;
  for (const [name, value] of Object.entries(exports)) {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { __embeddedPlacement?: unknown }).__embeddedPlacement !== "local"
    ) {
      continue;
    }
    (value as Record<string, unknown>)[EMBEDDED_LOCAL_REFERENCE] = `${moduleId}:${name}`;
    if (graphHash !== undefined) {
      stampLocalGraph(value as Record<string, unknown>, graphHash);
    }
  }
}

/** True for local registration values. @internal */
export function isLocalFunction(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { placement?: unknown }).placement === "local"
  );
}

/** The namespaced dispatch name stamped onto a registration, if present. @internal */
export function localReferenceName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = (value as Record<string, unknown>)[EMBEDDED_LOCAL_REFERENCE];
  return typeof name === "string" ? name : undefined;
}
