import type { GenericValidator, PropertyValidators } from "convex/values";

import type { LocalBuilders, LocalCompatibilityBuilders } from "../local";
import {
  hasEmbeddedSchemaMeta,
  type ConvexEmbeddedSchema,
  type DeviceDataModel,
  type EmbeddedSchemaDefinition,
} from "../schema";
import type { FunctionVisibility } from "../runtime/functions";

export const EMBEDDED_LOCAL_REFERENCE = "__embeddedLocalReference";
export const EMBEDDED_LOCAL_GRAPH_HASH = "__embeddedLocalGraphHash";
const EMBEDDED_LOCAL_SCHEMA = "__embeddedLocalSchema";
const EMBEDDED_LOCAL_SETUP_ONLY = "__embeddedLocalSetupOnly";

/** Shared local-registration marker used by generated module transforms and runtimes. */
export function isLocalFunction(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __embeddedPlacement?: unknown }).__embeddedPlacement === "local"
  );
}

/** Read the namespaced dispatch name attached by the generated module transform. */
export function localReferenceName(value: unknown): string | undefined {
  if (!isLocalFunction(value)) return undefined;
  const name = value[EMBEDDED_LOCAL_REFERENCE];
  return typeof name === "string" ? name : undefined;
}

/**
 * Name every local registration exported from one device module.
 *
 * The optional graph hash makes setup registrations build-specific. Runtimes that load a direct
 * Node module omit it, but still share the same reference marker implementation.
 */
export function stampLocal(moduleId: string, exports: Record<string, unknown>): void;
export function stampLocal(
  moduleId: string,
  graphHash: string,
  exports: Record<string, unknown>,
): void;
export function stampLocal(
  moduleId: string,
  graphHashOrExports: string | Record<string, unknown>,
  maybeExports?: Record<string, unknown>,
): void {
  const graphHash = typeof graphHashOrExports === "string" ? graphHashOrExports : undefined;
  const exports =
    typeof graphHashOrExports === "string" ? (maybeExports ?? {}) : graphHashOrExports;
  for (const [name, value] of Object.entries(exports)) {
    if (!isLocalFunction(value)) continue;
    value[EMBEDDED_LOCAL_REFERENCE] = `${moduleId}:${name}`;
    if (graphHash !== undefined) stampLocalGraph(value, graphHash);
  }
}

/** Build device-only functions for the generated, schema-bound local contract. */
export function defineLocal<Schema extends EmbeddedSchemaDefinition>(
  schema: Schema,
): LocalBuilders<DeviceDataModel<Schema>> {
  if (!hasEmbeddedSchemaMeta(schema as ConvexEmbeddedSchema)) {
    throw new Error("defineLocal requires the schema exported by defineEmbeddedSchema.");
  }
  return {
    compatibility: <CompatibilitySchema extends EmbeddedSchemaDefinition>(
      compatibilitySchema: CompatibilitySchema,
    ): LocalCompatibilityBuilders<DeviceDataModel<CompatibilitySchema>> => {
      if (!hasEmbeddedSchemaMeta(compatibilitySchema as ConvexEmbeddedSchema)) {
        throw new Error("local.compatibility requires a schema exported by defineEmbeddedSchema.");
      }
      return {
        internalQuery: builder("query", "internal", compatibilitySchema, true),
        internalMutation: builder("mutation", "internal", compatibilitySchema, true),
        internalAction: builder("action", "internal", compatibilitySchema, true),
      } as unknown as LocalCompatibilityBuilders<DeviceDataModel<CompatibilitySchema>>;
    },
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
  schema: ConvexEmbeddedSchema,
  setupOnly = false,
) {
  return (definition: {
    args?: PropertyValidators | GenericValidator;
    returns?: PropertyValidators | GenericValidator;
    handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
  }) => {
    const registration = bindLocalSchema(
      {
        kind,
        placement: "local" as const,
        visibility,
        args: definition.args,
        returns: definition.returns,
        handler: definition.handler,
        __embeddedHandler: definition.handler,
        __embeddedPlacement: "local" as const,
      },
      schema,
    );
    if (setupOnly) {
      Object.defineProperty(registration, EMBEDDED_LOCAL_SETUP_ONLY, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      });
    }
    return registration;
  };
}

export function bindLocalSchema(
  value: Record<string, unknown>,
  schema: ConvexEmbeddedSchema | undefined,
): Record<string, unknown> {
  return schema === undefined ? value : { ...value, [EMBEDDED_LOCAL_SCHEMA]: schema };
}

export function stampLocalGraph(value: Record<string, unknown>, graphHash: string): void {
  value[EMBEDDED_LOCAL_GRAPH_HASH] = graphHash;
}

export function localGraphHash(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const hash = (value as Record<string, unknown>)[EMBEDDED_LOCAL_GRAPH_HASH];
  return typeof hash === "string" ? hash : undefined;
}

export function localFunctionSchema(value: unknown): ConvexEmbeddedSchema | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const schema = (value as Record<string, unknown>)[EMBEDDED_LOCAL_SCHEMA];
  return hasEmbeddedSchemaMeta(schema) ? schema : undefined;
}

/** Read the historical schema carried by a setup-only local registration. */
export function localCompatibilitySchema(value: unknown): ConvexEmbeddedSchema | undefined {
  if (!isLocalSetupOnly(value)) return undefined;
  return localFunctionSchema(value);
}

/** Whether this registration may execute only in a candidate setup runner. */
export function isLocalSetupOnly(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[EMBEDDED_LOCAL_SETUP_ONLY] === true
  );
}
