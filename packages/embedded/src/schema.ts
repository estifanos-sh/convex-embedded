/**
 * Shared schema types and schema conversion helpers for embedded Convex.
 *
 * @remarks
 * Public clients accept a normal Convex schema definition. The embedded
 * runtime converts it into the local storage schema it needs for tables and
 * indexes.
 *
 * @packageDocumentation
 */
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { ObjectFieldType, ValidatorJSON } from "convex/values";
import type { StoreSchema } from "./storage/types";

/**
 * Convex schema definition accepted by the embedded client.
 *
 * @remarks
 * Pass the default export from a Convex `schema.ts` module to the Node client
 * or worker runtime.
 *
 * @example
 * ```ts
 * import schema from "../convex/schema";
 *
 * const client = new ConvexEmbeddedClient({ schema, modules, path: "local.db" });
 * ```
 *
 * @public
 */
export type ConvexEmbeddedSchema = SchemaDefinition<GenericSchema, boolean>;

const RESERVED_STORAGE_COLUMNS = new Set(["id", "identity_key", "creation_time_ms", "data"]);

interface ExportedSchema {
  tables: ExportedTable[];
}

interface ExportedTable {
  tableName: string;
  indexes: { indexDescriptor: string; fields: string[] }[];
  stagedDbIndexes?: unknown[];
  searchIndexes?: unknown[];
  stagedSearchIndexes?: unknown[];
  vectorIndexes?: unknown[];
  stagedVectorIndexes?: unknown[];
  documentType: ValidatorJSON;
}

/**
 * Converts a Convex schema definition into the embedded storage schema.
 *
 * @param schema - Convex schema definition exported by `convex/schema`.
 * @returns Storage schema used by the embedded runtime.
 * @throws If the schema uses unsupported index types, reserved index names, or
 * indexed field validators that cannot be represented by embedded storage.
 *
 * @internal
 */
export function toStoreSchema(schema: ConvexEmbeddedSchema): StoreSchema {
  const exported = JSON.parse(
    (schema as unknown as { export(): string }).export(),
  ) as ExportedSchema;
  return {
    tables: exported.tables.map((table) => {
      rejectUnsupportedIndexes(table);
      const columns = new Map<string, { field: string }>();
      const columnByField = new Map<string, string>();
      const indexes = [
        ...table.indexes.map((index) => userIndex(table, index)),
        { name: "by_id", fields: ["_id"] },
        { name: "by_creation_time", fields: ["_creationTime"] },
      ];
      for (const index of indexes) {
        for (const field of index.fields) {
          if (isSystemField(field)) continue;
          assertIndexedFieldExists(table, field);
          const name = columnByField.get(field) ?? columnName(field, columns);
          columns.set(name, { field });
          columnByField.set(field, name);
        }
      }
      return {
        name: table.tableName,
        columns: [...columns.entries()].map(([name, column]) => ({
          name,
          field: column.field === name ? undefined : column.field,
        })),
        document: table.documentType,
        indexes: indexes.map((index) => ({
          name: index.name,
          fields: index.fields,
          columns: index.fields.map((field) => storageColumn(field, columns)),
        })),
      };
    }),
  };
}

function userIndex(
  table: ExportedTable,
  index: ExportedTable["indexes"][number],
): { name: string; fields: string[] } {
  if (isSystemIndexName(index.indexDescriptor)) {
    throw new Error(`index name ${table.tableName}.${index.indexDescriptor} is reserved`);
  }
  return {
    name: index.indexDescriptor,
    fields: index.fields.includes("_creationTime")
      ? index.fields
      : [...index.fields, "_creationTime"],
  };
}

/**
 * Index columns store order-preserving keys, so any value type is indexable (including a union
 * like `v.union(v.int64(), v.boolean())`). We only validate that the field exists in the schema.
 */
function assertIndexedFieldExists(table: ExportedTable, field: string): void {
  if (!fieldTypesForPath(table.documentType, field).length) {
    throw new Error(`index field ${table.tableName}.${field} is not present in the table schema`);
  }
}

function rejectUnsupportedIndexes(table: ExportedTable): void {
  for (const [kind, indexes] of [
    ["staged database", table.stagedDbIndexes],
    ["search", table.searchIndexes],
    ["staged search", table.stagedSearchIndexes],
    ["vector", table.vectorIndexes],
    ["staged vector", table.stagedVectorIndexes],
  ] as const) {
    if (indexes?.length) {
      throw new Error(`embedded storage does not support ${kind} indexes on ${table.tableName}`);
    }
  }
}

function fieldTypesForPath(validator: ValidatorJSON, fieldPath: string): ObjectFieldType[] {
  return fieldTypesForSegments(validator, fieldPath.split("."));
}

function fieldTypesForSegments(
  validator: ValidatorJSON,
  segments: readonly string[],
): ObjectFieldType[] {
  if (!segments.length) return [];
  if (validator.type === "union") {
    return validator.value.flatMap((member) => fieldTypesForSegments(member, segments));
  }
  if (validator.type !== "object") return [];
  const [segment, ...rest] = segments;
  const field = validator.value[segment!];
  if (!field) return [];
  if (!rest.length) return [field];
  return fieldTypesForSegments(field.fieldType, rest);
}

function isSystemField(field: string): boolean {
  return field === "_id" || field === "_creationTime";
}

function isSystemIndexName(name: string): boolean {
  return name === "by_id" || name === "by_creation_time";
}

function storageColumn(field: string, columns: ReadonlyMap<string, { field: string }>): string {
  if (field === "_id") return "id";
  if (field === "_creationTime") return "creation_time_ms";
  for (const [name, column] of columns) {
    if (column.field === field) return name;
  }
  throw new Error(`missing storage column for indexed field ${field}`);
}

function columnName(field: string, existing: ReadonlyMap<string, unknown>): string {
  const preferred =
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) && !RESERVED_STORAGE_COLUMNS.has(field)
      ? field
      : `idx_${sanitize(field)}`;
  let name = preferred.slice(0, 64);
  let suffix = 1;
  while (existing.has(name)) {
    const tail = `_${suffix++}`;
    name = `${preferred.slice(0, 64 - tail.length)}${tail}`;
  }
  return name;
}

function sanitize(field: string): string {
  return field.replaceAll(/[^A-Za-z0-9_]/g, "_").replaceAll(/^_+|_+$/g, "") || "field";
}
