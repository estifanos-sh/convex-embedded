import { hasEmbeddedSchemaMeta, type ConvexEmbeddedSchema } from "../schema";

export const EMBEDDED_LOCAL_GRAPH_HASH = "__embeddedLocalGraphHash";
const EMBEDDED_LOCAL_SCHEMA = "__embeddedLocalSchema";

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
