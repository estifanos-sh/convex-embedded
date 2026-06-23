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
import type { GenericValidator, ObjectFieldType, ValidatorJSON } from "convex/values";
import componentSchema from "./component/schema";
import { embeddedCrdtMeta } from "./crdt/meta";
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

/** Complete embedded interpretation of a Convex schema. @internal */
export interface EmbeddedSchemaAnalysis {
  storageIdPaths: Record<string, string[]>;
  storeSchema: StoreSchema;
  tables: string[];
}

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
  return analyzeEmbeddedSchema(schema).storeSchema;
}

/** App schema plus package-owned private component tables used by a local runtime. @internal */
export function toRuntimeStoreSchema(schema: ConvexEmbeddedSchema): StoreSchema {
  const app = toStoreSchema(schema);
  return { ...app, tables: [...app.tables, ...embeddedComponentPhysicalTables()] };
}

/**
 * Derives every embedded runtime product from the app's Convex schema.
 *
 * @remarks
 * Convex's exported schema JSON carries table/index/validator structure. CRDT
 * field metadata is attached to the live validator objects, so this analyzer
 * intentionally reads both views in one place.
 *
 * @internal
 */
export function analyzeEmbeddedSchema(schema: ConvexEmbeddedSchema): EmbeddedSchemaAnalysis {
  const exported = exportSchema(schema);
  const storageIdPaths: Record<string, string[]> = {};
  const tableNames = exported.tables.map((table) => table.tableName).sort();
  const appTables = exported.tables.map((table) => {
    const paths = storageIdPathsForValidator(table.documentType, "");
    if (paths.length > 0) storageIdPaths[table.tableName] = [...new Set(paths)].sort();
    return storeTable(schema, table);
  });
  return {
    storageIdPaths,
    storeSchema: {
      hash: schemaFingerprint(exported),
      tables: appTables,
    },
    tables: tableNames,
  };
}

/** Logical schema used when the runner executes the installed Embedded component. @internal */
export function embeddedComponentStoreSchema(): StoreSchema {
  const exported = exportSchema(componentSchema);
  return {
    hash: schemaFingerprint(exported),
    tables: exported.tables.map((table) => storeTable(componentSchema, table)),
  };
}

/** Physical private tables installed beside application tables in SQLite. @internal */
function embeddedComponentPhysicalTables(): StoreSchema["tables"] {
  const prefix = "__e_";
  return embeddedComponentStoreSchema().tables.map((table) => {
    const physical = { ...table, name: `${prefix}${table.name}` };
    assertPhysicalIdentifiers(physical);
    return physical;
  });
}

function schemaFingerprint(schema: ExportedSchema): string {
  const text = JSON.stringify(schema);
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < text.length; index += 1) {
    low ^= text.charCodeAt(index);
    const nextLow = Math.imul(low, 0x1b3);
    const carry = Math.floor((low * 0x1b3) / 0x1_0000_0000);
    high = (Math.imul(high, 0x1b3) + carry) >>> 0;
    low = nextLow >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

function storeTable(
  schema: ConvexEmbeddedSchema,
  table: ExportedTable,
): StoreSchema["tables"][number] {
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
  const stored = {
    name: table.tableName,
    columns: [...columns.entries()].map(([name, column]) => ({
      name,
      field: column.field === name ? undefined : column.field,
    })),
    ...crdtFieldsForTable(schema, table.tableName),
    document: table.documentType,
    indexes: indexes.map((index) => ({
      name: index.name,
      fields: index.fields,
      columns: index.fields.map((field) => storageColumn(field, columns)),
    })),
  };
  assertPhysicalIdentifiers(stored);
  return stored;
}

function assertPhysicalIdentifiers(table: StoreSchema["tables"][number]): void {
  for (const identifier of [
    `doc__${table.name}`,
    ...table.indexes.map((index) => `ix__${table.name}__${index.name}`),
  ]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(identifier)) {
      throw new Error(
        `embedded storage physical identifier must be valid and at most 64 bytes: ${identifier}`,
      );
    }
  }
}

function exportSchema(schema: ConvexEmbeddedSchema): ExportedSchema {
  return JSON.parse((schema as unknown as { export(): string }).export()) as ExportedSchema;
}

type StorageIdPathKind = "storage" | "string";

function storageIdPathsForValidator(validator: ValidatorJSON, prefix: string): string[] {
  return [...storageIdPathKindsForValidator(validator, prefix)]
    .filter(([, kinds]) => kinds.has("storage"))
    .map(([path]) => path);
}

function storageIdPathKindsForValidator(
  validator: ValidatorJSON,
  prefix: string,
): Map<string, Set<StorageIdPathKind>> {
  const paths = new Map<string, Set<StorageIdPathKind>>();
  collectStorageIdPathKinds(validator, prefix, paths);
  return paths;
}

function collectStorageIdPathKinds(
  validator: ValidatorJSON,
  prefix: string,
  paths: Map<string, Set<StorageIdPathKind>>,
): void {
  if (validator.type === "id") {
    if (prefix.length > 0) {
      addStorageIdPathKind(
        paths,
        prefix,
        validator.tableName === "_storage" ? "storage" : "string",
      );
    }
    return;
  }
  if (validator.type === "string" || validator.type === "any") {
    if (prefix.length > 0) addStorageIdPathKind(paths, prefix, "string");
    return;
  }
  if (
    validator.type === "literal" &&
    typeof (validator as unknown as { value?: unknown }).value === "string"
  ) {
    if (prefix.length > 0) addStorageIdPathKind(paths, prefix, "string");
    return;
  }
  if (validator.type === "array") {
    collectStorageIdPathKinds(validator.value, `${prefix}[]`, paths);
    return;
  }
  if (validator.type === "record") {
    collectStorageIdPathKinds(validator.values.fieldType, `${prefix}{}`, paths);
    return;
  }
  if (validator.type === "object") {
    for (const [field, child] of Object.entries(validator.value)) {
      collectStorageIdPathKinds(
        child.fieldType,
        prefix.length === 0
          ? encodeStorageIdPathField(field)
          : `${prefix}.${encodeStorageIdPathField(field)}`,
        paths,
      );
    }
    return;
  }
  if (validator.type === "union") {
    const unionPaths = new Map<string, Set<StorageIdPathKind>>();
    for (const member of validator.value) {
      mergeStorageIdPathKinds(unionPaths, storageIdPathKindsForValidator(member, prefix));
    }
    for (const [path, kinds] of unionPaths) {
      if (kinds.has("storage") && kinds.has("string")) {
        throw new Error(
          `storage id path ${path} is ambiguous: a union branch can store an ordinary string at the same path`,
        );
      }
    }
    mergeStorageIdPathKinds(paths, unionPaths);
  }
}

function mergeStorageIdPathKinds(
  target: Map<string, Set<StorageIdPathKind>>,
  source: Map<string, Set<StorageIdPathKind>>,
): void {
  for (const [path, kinds] of source) {
    for (const kind of kinds) addStorageIdPathKind(target, path, kind);
  }
}

function addStorageIdPathKind(
  paths: Map<string, Set<StorageIdPathKind>>,
  path: string,
  kind: StorageIdPathKind,
): void {
  const existing = paths.get(path);
  if (existing === undefined) {
    paths.set(path, new Set([kind]));
    return;
  }
  existing.add(kind);
}

function encodeStorageIdPathField(field: string): string {
  return field.replace(/[.\\[\]{}]/g, (char) => `\\${char}`);
}

function crdtFieldsForTable(
  schema: ConvexEmbeddedSchema,
  tableName: string,
): Pick<StoreSchema["tables"][number], "crdtFields"> {
  const table = (schema as unknown as { tables?: Record<string, { validator?: GenericValidator }> })
    .tables?.[tableName];
  const fields = crdtFieldsForValidator(table?.validator);
  return fields.length ? { crdtFields: fields } : {};
}

function crdtFieldsForValidator(
  validator: GenericValidator | undefined,
  prefix = "",
): NonNullable<StoreSchema["tables"][number]["crdtFields"]> {
  if (validator === undefined) return [];
  const meta = embeddedCrdtMeta(validator);
  if (meta !== null && prefix) {
    return [{ field: prefix, ...meta }];
  }
  if ((validator as { kind?: unknown }).kind !== "object") return [];
  const fields = (validator as { fields?: Record<string, GenericValidator> }).fields;
  if (fields === undefined) return [];
  return Object.entries(fields).flatMap(([field, child]) =>
    crdtFieldsForValidator(child, prefix ? `${prefix}.${field}` : field),
  );
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
  if (!fieldTypesForSegments(table.documentType, field.split(".")).length) {
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
  const preferred = `idx_${sanitize(field)}`;
  let name = preferred.slice(0, 64);
  let suffix = 1;
  while (existing.has(name)) {
    const tail = `_${suffix++}`;
    name = `${preferred.slice(0, 64 - tail.length)}${tail}`;
  }
  return name;
}

function sanitize(field: string): string {
  return (
    field
      .toLowerCase()
      .replaceAll(/[^a-z0-9_]/g, "_")
      .replaceAll(/^_+|_+$/g, "") || "field"
  );
}
