/**
 * Shared schema types and schema conversion helpers for embedded Convex.
 *
 * @remarks
 * Embedded schemas explicitly describe which tables and fields are replicated,
 * remote-only, or device-only.
 *
 * @packageDocumentation
 */
import {
  defineSchema,
  defineTable,
  type DataModelFromSchemaDefinition,
  type DefineSchemaOptions,
  type GenericSchema,
  type GenericTableIndexes,
  type GenericTableSearchIndexes,
  type GenericTableVectorIndexes,
  type SchemaDefinition,
  type TableDefinition,
} from "convex/server";
import type {
  GenericValidator,
  GenericId,
  Infer,
  ObjectFieldType,
  ObjectType,
  Validator,
  ValidatorJSON,
  VObject,
  VOptional,
} from "convex/values";
import componentSchema from "./component/schema";
import { embeddedFieldMeta, type EmbeddedFieldPlacement, type EmbeddedValidator } from "./meta";
import type { StoreSchema } from "./storage/types";

const EMBEDDED_TABLE = Symbol.for("convex-embedded:table");
const EMBEDDED_SCHEMA = Symbol.for("convex-embedded:schema");

export type EmbeddedTablePlacement = "replicated" | "local";

export interface EmbeddedTableValidator<Placement extends EmbeddedTablePlacement> {
  readonly __embeddedTablePlacement: Placement;
}

export type EmbeddedTableDefinition<
  DocumentType extends Validator<any, any, any> = Validator<any, any, any>,
  Indexes extends GenericTableIndexes = {},
  SearchIndexes extends GenericTableSearchIndexes = {},
  VectorIndexes extends GenericTableVectorIndexes = {},
> = TableDefinition<
  DocumentType & EmbeddedTableValidator<"replicated">,
  Indexes,
  SearchIndexes,
  VectorIndexes
>;

export type LocalTableDefinition<
  DocumentType extends Validator<any, any, any> = Validator<any, any, any>,
  Indexes extends GenericTableIndexes = {},
  SearchIndexes extends GenericTableSearchIndexes = {},
  VectorIndexes extends GenericTableVectorIndexes = {},
> = TableDefinition<
  DocumentType & EmbeddedTableValidator<"local">,
  Indexes,
  SearchIndexes,
  VectorIndexes
>;

type EmbeddedFields = Record<string, GenericValidator>;

export function embeddedTable<DocumentSchema extends EmbeddedFields>(
  documentSchema: DocumentSchema,
): EmbeddedTableDefinition<VObject<ObjectType<DocumentSchema>, DocumentSchema>> {
  return markTable(defineTable(documentSchema), "replicated") as EmbeddedTableDefinition<
    VObject<ObjectType<DocumentSchema>, DocumentSchema>
  >;
}

export function localTable<DocumentSchema extends EmbeddedFields>(
  documentSchema: DocumentSchema,
): LocalTableDefinition<VObject<ObjectType<DocumentSchema>, DocumentSchema>> {
  return markTable(defineTable(documentSchema), "local") as LocalTableDefinition<
    VObject<ObjectType<DocumentSchema>, DocumentSchema>
  >;
}

type SourceTableTypes<Schema> =
  Schema extends EmbeddedSchemaDefinition<infer Tables> ? Tables : never;
type ValidatorPlacement<Value> =
  Value extends EmbeddedValidator<infer Placement> ? Placement : "replicated";
type TableFields<Table> =
  Table extends TableDefinition<VObject<any, infer Fields, any, any>, any, any, any>
    ? Fields
    : never;
type TablePlacementType<Table> =
  Table extends TableDefinition<infer Document, any, any, any>
    ? Document extends EmbeddedTableValidator<infer Placement>
      ? Placement
      : "remote"
    : never;
type ServerFields<Fields extends EmbeddedFields> = {
  [Field in keyof Fields as ValidatorPlacement<Fields[Field]> extends "local"
    ? never
    : Field]: Fields[Field];
};
type WireFields<Fields extends EmbeddedFields> = {
  [Field in keyof Fields as ValidatorPlacement<Fields[Field]> extends "replicated"
    ? Field
    : never]: Fields[Field];
};
type DeviceValidatorFields<Fields extends EmbeddedFields> = {
  [Field in keyof Fields as ValidatorPlacement<Fields[Field]> extends "remote"
    ? never
    : Field]: ValidatorPlacement<Fields[Field]> extends "local"
    ? Fields[Field] extends Validator<any, any, any>
      ? VOptional<Fields[Field]>
      : never
    : Fields[Field];
};
type RootFieldPath<Path> = Path extends `${infer Root}.${string}` ? Root : Path;
type IsRemoteFieldPath<Fields extends EmbeddedFields, Path> = Path extends unknown
  ? RootFieldPath<Path> extends keyof Fields
    ? ValidatorPlacement<Fields[RootFieldPath<Path>]> extends "remote"
      ? true
      : false
    : false
  : never;
type HasRemoteFieldPath<Fields extends EmbeddedFields, Paths> = true extends (
  Paths extends readonly (infer Path)[]
    ? IsRemoteFieldPath<Fields, Path>
    : IsRemoteFieldPath<Fields, Paths>
)
  ? true
  : false;
type DeviceIndexes<Indexes, Fields extends EmbeddedFields> = {
  [Name in keyof Indexes as HasRemoteFieldPath<Fields, Indexes[Name]> extends true
    ? never
    : Name]: Indexes[Name];
};
type DeviceSearchIndexes<Indexes, Fields extends EmbeddedFields> = {
  [Name in keyof Indexes as Indexes[Name] extends {
    searchField: infer SearchField;
    filterFields: infer FilterFields;
  }
    ? HasRemoteFieldPath<Fields, SearchField | FilterFields> extends true
      ? never
      : Name
    : Name]: Indexes[Name];
};
type DeviceVectorIndexes<Indexes, Fields extends EmbeddedFields> = {
  [Name in keyof Indexes as Indexes[Name] extends {
    vectorField: infer VectorField;
    filterFields: infer FilterFields;
  }
    ? HasRemoteFieldPath<Fields, VectorField | FilterFields> extends true
      ? never
      : Name
    : Name]: Indexes[Name];
};
type ProjectTable<
  Table,
  Fields extends EmbeddedFields,
  RemoveRemoteIndexes extends boolean = false,
> =
  Table extends TableDefinition<any, infer Indexes, infer SearchIndexes, infer VectorIndexes>
    ? TableDefinition<
        VObject<ObjectType<Fields>, Fields>,
        RemoveRemoteIndexes extends true ? DeviceIndexes<Indexes, TableFields<Table>> : Indexes,
        RemoveRemoteIndexes extends true
          ? DeviceSearchIndexes<SearchIndexes, TableFields<Table>>
          : SearchIndexes,
        RemoveRemoteIndexes extends true
          ? DeviceVectorIndexes<VectorIndexes, TableFields<Table>>
          : VectorIndexes
      >
    : never;
type HostedTables<Tables extends GenericSchema> = {
  [Name in keyof Tables as TablePlacementType<Tables[Name]> extends "local"
    ? never
    : Name]: TablePlacementType<Tables[Name]> extends "replicated"
    ? ProjectTable<Tables[Name], ServerFields<TableFields<Tables[Name]>>>
    : Tables[Name];
};
type ReplicatedTables<Tables extends GenericSchema> = {
  [Name in keyof Tables as TablePlacementType<Tables[Name]> extends "replicated"
    ? Name
    : never]: ProjectTable<Tables[Name], WireFields<TableFields<Tables[Name]>>, true>;
};
type DeviceTables<Tables extends GenericSchema> = {
  [Name in keyof Tables as TablePlacementType<Tables[Name]> extends "local" | "replicated"
    ? Name
    : never]: TablePlacementType<Tables[Name]> extends "local"
    ? Tables[Name]
    : ProjectTable<Tables[Name], DeviceValidatorFields<TableFields<Tables[Name]>>, true>;
};

export type EmbeddedSchemaDefinition<Tables extends GenericSchema = any> = SchemaDefinition<
  HostedTables<Tables>,
  true
> & {
  readonly __embeddedTables: Tables;
};

export type ServerDataModel<Schema extends EmbeddedSchemaDefinition> =
  DataModelFromSchemaDefinition<SchemaDefinition<HostedTables<SourceTableTypes<Schema>>, true>>;
export type ReplicatedDataModel<Schema extends EmbeddedSchemaDefinition> =
  DataModelFromSchemaDefinition<SchemaDefinition<ReplicatedTables<SourceTableTypes<Schema>>, true>>;
export type DeviceDataModel<Schema extends EmbeddedSchemaDefinition> =
  DataModelFromSchemaDefinition<SchemaDefinition<DeviceTables<SourceTableTypes<Schema>>, true>>;
type LocalFieldValues<Fields extends EmbeddedFields> = {
  [Field in keyof Fields as ValidatorPlacement<Fields[Field]> extends "local"
    ? Field
    : never]?: Infer<Fields[Field]>;
};
type DocumentSystemFields<Name extends string> = {
  _creationTime: number;
  _id: GenericId<Name>;
};
type TableDocument<
  Name extends string,
  Fields extends EmbeddedFields,
> = DocumentSystemFields<Name> & ObjectType<Fields>;
type DeviceDocument<
  Name extends string,
  Fields extends EmbeddedFields,
> = DocumentSystemFields<Name> & ObjectType<WireFields<Fields>> & LocalFieldValues<Fields>;

export type ServerModel<Schema extends EmbeddedSchemaDefinition> = {
  [Name in keyof SourceTableTypes<Schema> as TablePlacementType<
    SourceTableTypes<Schema>[Name]
  > extends "local"
    ? never
    : Name]: TableDocument<
    Name & string,
    ServerFields<TableFields<SourceTableTypes<Schema>[Name]>>
  >;
};

export type WireModel<Schema extends EmbeddedSchemaDefinition> = {
  [Name in keyof SourceTableTypes<Schema> as TablePlacementType<
    SourceTableTypes<Schema>[Name]
  > extends "replicated"
    ? Name
    : never]: TableDocument<Name & string, WireFields<TableFields<SourceTableTypes<Schema>[Name]>>>;
};

export type DeviceModel<Schema extends EmbeddedSchemaDefinition> = {
  [Name in keyof SourceTableTypes<Schema> as TablePlacementType<
    SourceTableTypes<Schema>[Name]
  > extends "local" | "replicated"
    ? Name
    : never]: TablePlacementType<SourceTableTypes<Schema>[Name]> extends "local"
    ? TableDocument<Name & string, TableFields<SourceTableTypes<Schema>[Name]>>
    : DeviceDocument<Name & string, TableFields<SourceTableTypes<Schema>[Name]>>;
};

export function defineEmbeddedSchema<Tables extends GenericSchema>(
  tables: Tables,
  options?: DefineSchemaOptions<true>,
): EmbeddedSchemaDefinition<Tables> {
  const hosted: GenericSchema = {};
  for (const [name, table] of Object.entries(tables)) {
    const placement = tablePlacement(table);
    if (placement === "local") continue;
    hosted[name] = placement === "replicated" ? projectTableForServer(name, table) : table;
  }
  const schema = defineSchema(hosted, options);
  Object.defineProperty(schema, EMBEDDED_SCHEMA, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ tables: { ...tables } }),
    writable: false,
  });
  return schema as EmbeddedSchemaDefinition<Tables>;
}

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
export type ConvexEmbeddedSchema = EmbeddedSchemaDefinition;
type AnalyzableSchema = SchemaDefinition<GenericSchema, boolean>;

export interface EmbeddedFieldPlacements {
  replicated: string[];
  remote: string[];
  local: string[];
}

export interface EmbeddedIndexPlacements {
  replicated: string[];
  remote: string[];
  local: string[];
}

export interface EmbeddedSchemaPlacements {
  replicatedTables: string[];
  remoteTables: string[];
  localTables: string[];
  fields: Record<string, EmbeddedFieldPlacements>;
  indexes: Record<string, EmbeddedIndexPlacements>;
  validators: Record<string, Record<string, ValidatorJSON>>;
}

/** Complete embedded interpretation of a Convex schema. @internal */
export interface EmbeddedSchemaAnalysis {
  placements: EmbeddedSchemaPlacements;
  storageIdPaths: Record<string, string[]>;
  storeSchema: StoreSchema;
  tables: string[];
}

export function embeddedSchemaMeta(schema: AnalyzableSchema): EmbeddedSchemaPlacements {
  return analyzePlacement(
    sourceTables(schema),
    hasEmbeddedSchemaMeta(schema) ? "remote" : "replicated",
  );
}

export function fieldPlacements(
  placements: EmbeddedSchemaPlacements,
  table: string,
): EmbeddedFieldPlacements {
  return placements.fields[table] ?? { local: [], remote: [], replicated: [] };
}

export function projectWireDoc(
  placements: EmbeddedSchemaPlacements,
  table: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  return omitFields(document, [
    ...fieldPlacements(placements, table).remote,
    ...fieldPlacements(placements, table).local,
  ]);
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

// These indexes serve hosted component functions that are intentionally absent from
// embeddedComponentModules. Installing them in browser SQLite couples local schema evolution to
// server maintenance code the local runtime can never execute.
const REMOTE_COMPONENT_INDEXES = new Set(["crdtCheckpoints.by_field_epoch_state_retain_seq"]);

interface EmbeddedSchemaRuntimeMeta {
  tables: GenericSchema;
}

interface ExportedTableDefinition {
  indexes: { indexDescriptor: string; fields: string[] }[];
  stagedDbIndexes: { indexDescriptor: string; fields: string[] }[];
  searchIndexes: { indexDescriptor: string; searchField: string; filterFields: string[] }[];
  stagedSearchIndexes: { indexDescriptor: string; searchField: string; filterFields: string[] }[];
  vectorIndexes: {
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }[];
  stagedVectorIndexes: {
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }[];
  documentType: ValidatorJSON;
}

type MarkedTable = TableDefinition & {
  readonly [EMBEDDED_TABLE]?: EmbeddedTablePlacement;
};

function markTable<T extends TableDefinition>(table: T, placement: EmbeddedTablePlacement): any {
  validateTableFields(table, placement);
  Object.defineProperty(table, EMBEDDED_TABLE, {
    configurable: false,
    enumerable: false,
    value: placement,
    writable: false,
  });
  return table;
}

function tablePlacement(table: TableDefinition | undefined): EmbeddedTablePlacement | "remote" {
  return (table as MarkedTable | undefined)?.[EMBEDDED_TABLE] ?? "remote";
}

function sourceTables(schema: AnalyzableSchema): GenericSchema {
  const meta = (schema as unknown as { [EMBEDDED_SCHEMA]?: EmbeddedSchemaRuntimeMeta })[
    EMBEDDED_SCHEMA
  ];
  return meta?.tables ?? schema.tables;
}

function hasEmbeddedSchemaMeta(schema: AnalyzableSchema): boolean {
  return (
    (schema as unknown as { [EMBEDDED_SCHEMA]?: EmbeddedSchemaRuntimeMeta })[EMBEDDED_SCHEMA] !==
    undefined
  );
}

function projectTableForServer(name: string, table: TableDefinition): TableDefinition {
  const fields = objectFields(table, name);
  const projected = Object.fromEntries(
    Object.entries(fields).filter(([, field]) => embeddedFieldMeta(field)?.placement !== "local"),
  );
  let result = defineTable(projected) as TableDefinition;
  const exported = exportTable(table);
  for (const index of exported.indexes) {
    assertNoLocalIndex(name, index.indexDescriptor, index.fields, fields);
    result = (result as any).index(index.indexDescriptor, index.fields);
  }
  for (const index of exported.stagedDbIndexes) {
    assertNoLocalIndex(name, index.indexDescriptor, index.fields, fields);
    result = (result as any).index(index.indexDescriptor, { fields: index.fields, staged: true });
  }
  for (const index of exported.searchIndexes) {
    assertNoLocalIndex(
      name,
      index.indexDescriptor,
      [index.searchField, ...index.filterFields],
      fields,
    );
    result = (result as any).searchIndex(index.indexDescriptor, {
      filterFields: index.filterFields,
      searchField: index.searchField,
    });
  }
  for (const index of exported.stagedSearchIndexes) {
    assertNoLocalIndex(
      name,
      index.indexDescriptor,
      [index.searchField, ...index.filterFields],
      fields,
    );
    result = (result as any).searchIndex(index.indexDescriptor, {
      filterFields: index.filterFields,
      searchField: index.searchField,
      staged: true,
    });
  }
  for (const index of exported.vectorIndexes) {
    assertNoLocalIndex(
      name,
      index.indexDescriptor,
      [index.vectorField, ...index.filterFields],
      fields,
    );
    result = (result as any).vectorIndex(index.indexDescriptor, {
      dimensions: index.dimensions,
      filterFields: index.filterFields,
      vectorField: index.vectorField,
    });
  }
  for (const index of exported.stagedVectorIndexes) {
    assertNoLocalIndex(
      name,
      index.indexDescriptor,
      [index.vectorField, ...index.filterFields],
      fields,
    );
    result = (result as any).vectorIndex(index.indexDescriptor, {
      dimensions: index.dimensions,
      filterFields: index.filterFields,
      staged: true,
      vectorField: index.vectorField,
    });
  }
  return result;
}

function validateTableFields(table: TableDefinition, placement: EmbeddedTablePlacement): void {
  const fields = objectFields(table, placement === "local" ? "localTable" : "embeddedTable");
  for (const [field, validator] of Object.entries(fields)) {
    const meta = embeddedFieldMeta(validator);
    if (placement === "local" && meta !== null) {
      throw new Error(`localTable field ${field} cannot use an e.* annotation`);
    }
    if (hasNestedEmbeddedAnnotation(validator)) {
      throw new Error(`embedded field annotation must be top-level: ${field}`);
    }
  }
}

function objectFields(table: TableDefinition, name: string): Record<string, GenericValidator> {
  const fields = tryObjectFields(table);
  if (fields === undefined) throw new Error(`${name} must use an object field map`);
  return fields;
}

function tryObjectFields(table: TableDefinition): Record<string, GenericValidator> | undefined {
  const validator = table.validator as GenericValidator & {
    fields?: Record<string, GenericValidator>;
    kind?: unknown;
  };
  return validator.kind === "object" ? validator.fields : undefined;
}

function hasNestedEmbeddedAnnotation(validator: GenericValidator): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, root: boolean): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    const meta = embeddedFieldMeta(value);
    if (!root && meta !== null && meta.placement !== "replicated") return true;
    for (const child of Object.values(value)) {
      if (typeof child === "function") continue;
      if (visit(child, false)) return true;
    }
    return false;
  };
  return visit(validator, true);
}

function assertNoLocalIndex(
  table: string,
  index: string,
  fields: readonly string[],
  validators: Record<string, GenericValidator>,
): void {
  for (const field of fields) {
    const root = field.split(".")[0]!;
    if (embeddedFieldMeta(validators[root])?.placement === "local") {
      throw new Error(`index ${table}.${index} cannot contain local field ${field}`);
    }
  }
}

function analyzePlacement(
  tables: GenericSchema,
  unmarked: "remote" | "replicated" = "remote",
): EmbeddedSchemaPlacements {
  const placements: EmbeddedSchemaPlacements = {
    fields: {},
    indexes: {},
    localTables: [],
    remoteTables: [],
    replicatedTables: [],
    validators: {},
  };
  for (const [name, table] of Object.entries(tables)) {
    const marked = tablePlacement(table);
    const placement = marked === "remote" ? unmarked : marked;
    if (placement === "local") placements.localTables.push(name);
    else if (placement === "replicated") placements.replicatedTables.push(name);
    else placements.remoteTables.push(name);

    const fields = placement === "remote" ? {} : (tryObjectFields(table) ?? {});
    const fieldMeta: EmbeddedFieldPlacements = { local: [], remote: [], replicated: [] };
    const validators: Record<string, ValidatorJSON> = {};
    for (const [field, validator] of Object.entries(fields)) {
      const fieldPlacement = embeddedFieldMeta(validator)?.placement ?? "replicated";
      fieldMeta[fieldPlacement].push(field);
      validators[field] = validatorJson(validator);
    }
    placements.fields[name] = fieldMeta;
    placements.validators[name] = validators;

    const indexes: EmbeddedIndexPlacements = { local: [], remote: [], replicated: [] };
    const classifyIndex = (name: string, paths: readonly string[]) => {
      if (placement === "local") indexes.local.push(name);
      else if (placement === "remote") indexes.remote.push(name);
      else {
        const roots = paths.map((field) => field.split(".")[0]!);
        const indexPlacement: EmbeddedFieldPlacement = roots.some((field) =>
          fieldMeta.remote.includes(field),
        )
          ? "remote"
          : "replicated";
        indexes[indexPlacement].push(name);
      }
    };
    const exported = exportTable(table);
    for (const index of [...exported.indexes, ...exported.stagedDbIndexes]) {
      classifyIndex(index.indexDescriptor, index.fields);
    }
    for (const index of [...exported.searchIndexes, ...exported.stagedSearchIndexes]) {
      classifyIndex(index.indexDescriptor, [index.searchField, ...index.filterFields]);
    }
    for (const index of [...exported.vectorIndexes, ...exported.stagedVectorIndexes]) {
      classifyIndex(index.indexDescriptor, [index.vectorField, ...index.filterFields]);
    }
    for (const placement of Object.keys(indexes) as EmbeddedFieldPlacement[]) {
      indexes[placement].sort();
    }
    placements.indexes[name] = indexes;
  }
  for (const list of [
    placements.localTables,
    placements.remoteTables,
    placements.replicatedTables,
  ]) {
    list.sort();
  }
  return placements;
}

function validatorJson(validator: GenericValidator): ValidatorJSON {
  return (validator as unknown as { json: ValidatorJSON }).json;
}

function exportTables(
  tables: GenericSchema,
  include: (table: TableDefinition, name: string) => boolean,
): ExportedSchema {
  return {
    tables: Object.entries(tables)
      .filter(([name, table]) => include(table, name))
      .map(([tableName, table]) => ({ tableName, ...exportTable(table) })),
  };
}

function exportTable(table: TableDefinition): ExportedTableDefinition {
  return (table as unknown as { export(): ExportedTableDefinition }).export();
}

function projectValidator(validator: ValidatorJSON, omitted: ReadonlySet<string>): ValidatorJSON {
  if (validator.type !== "object") return validator;
  return {
    ...validator,
    value: Object.fromEntries(
      Object.entries(validator.value).filter(([field]) => !omitted.has(field)),
    ),
  };
}

function omitFields(
  document: Record<string, unknown>,
  omitted: readonly string[],
): Record<string, unknown> {
  const result = { ...document };
  for (const field of omitted) delete result[field];
  return result;
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
export function toStoreSchema(schema: AnalyzableSchema): StoreSchema {
  return analyzeEmbeddedSchema(schema).storeSchema;
}

/** App schema plus package-owned private component tables used by a local runtime. @internal */
export function toRuntimeStoreSchema(schema: AnalyzableSchema): StoreSchema {
  const app = toStoreSchema(schema);
  return withEmbeddedComponentTables(app);
}

/** Adds package-owned local component tables to an already generated app schema. @internal */
export function withEmbeddedComponentTables(app: StoreSchema): StoreSchema {
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
export function analyzeEmbeddedSchema(schema: AnalyzableSchema): EmbeddedSchemaAnalysis {
  const tables = sourceTables(schema);
  const placements = analyzePlacement(
    tables,
    hasEmbeddedSchemaMeta(schema) ? "remote" : "replicated",
  );
  const storageIdPaths: Record<string, string[]> = {};
  const localNames = new Set([...placements.replicatedTables, ...placements.localTables]);
  const localExport = exportTables(tables, (_table, name) => localNames.has(name));
  const tableNames = [...placements.replicatedTables, ...placements.localTables].sort();
  const appTables = localExport.tables.map((table) => {
    const fields = fieldPlacements(placements, table.tableName);
    const document = placements.replicatedTables.includes(table.tableName)
      ? projectValidator(table.documentType, new Set([...fields.remote, ...fields.local]))
      : table.documentType;
    const paths = storageIdPathsForValidator(document, "");
    if (paths.length > 0) storageIdPaths[table.tableName] = [...new Set(paths)].sort();
    return storeTable(tables, table, placements, document);
  });
  return {
    placements,
    storageIdPaths,
    storeSchema: {
      hash: schemaFingerprint({ tables: appTables }),
      tables: appTables,
    },
    tables: tableNames,
  };
}

/** Logical schema used when the runner executes the installed Embedded component. @internal */
export function embeddedComponentStoreSchema(): StoreSchema {
  const exported = exportSchema(componentSchema);
  const placements = analyzePlacement(componentSchema.tables, "replicated");
  return {
    hash: schemaFingerprint(exported),
    tables: exported.tables.map((table) =>
      storeTable(componentSchema.tables, table, placements, table.documentType),
    ),
  };
}

/** Physical private tables installed beside application tables in SQLite. @internal */
function embeddedComponentPhysicalTables(): StoreSchema["tables"] {
  const prefix = "__e_";
  return embeddedComponentStoreSchema().tables.map((table) => {
    const indexes = table.indexes.filter(
      (index) => !REMOTE_COMPONENT_INDEXES.has(`${table.name}.${index.name}`),
    );
    const indexedColumns = new Set(indexes.flatMap((index) => index.columns ?? index.fields));
    const physical = {
      ...table,
      columns: table.columns.filter((column) => indexedColumns.has(column.name)),
      indexes,
      name: `${prefix}${table.name}`,
    };
    assertPhysicalIdentifiers(physical);
    return physical;
  });
}

function schemaFingerprint(schema: unknown): string {
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
  tables: GenericSchema,
  table: ExportedTable,
  placements: EmbeddedSchemaPlacements,
  document: ValidatorJSON,
): StoreSchema["tables"][number] {
  rejectUnsupportedIndexes(table, placements);
  const placement = placements.localTables.includes(table.tableName) ? "local" : "replicated";
  const indexPlacements = placements.indexes[table.tableName] ?? {
    local: [],
    remote: [],
    replicated: table.indexes.map((index) => index.indexDescriptor),
  };
  const columns = new Map<string, { field: string }>();
  const columnByField = new Map<string, string>();
  const indexes = [
    ...table.indexes
      .filter((index) => !indexPlacements.remote.includes(index.indexDescriptor))
      .map((index) => userIndex(table, index)),
    { name: "by_id", fields: ["_id"] },
    { name: "by_creation_time", fields: ["_creationTime"] },
  ];
  for (const index of indexes) {
    for (const field of index.fields) {
      if (isSystemField(field)) continue;
      assertIndexedFieldExists({ ...table, documentType: document }, field);
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
    ...crdtFieldsForTable(tables, table.tableName),
    document,
    indexes: indexes.map((index) => ({
      name: index.name,
      fields: index.fields,
      columns: index.fields.map((field) => storageColumn(field, columns)),
    })),
    ...(placement !== "local"
      ? {
          ...(fieldPlacements(placements, table.tableName).local.length
            ? {
                localFields: fieldPlacements(placements, table.tableName).local.map((field) => ({
                  field,
                  validator: placements.validators[table.tableName]![field]!,
                })),
              }
            : {}),
          placement: "replicated" as const,
        }
      : { placement: "device" as const }),
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

function exportSchema(schema: AnalyzableSchema): ExportedSchema {
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
  tables: GenericSchema,
  tableName: string,
): Pick<StoreSchema["tables"][number], "crdtFields"> {
  const table = tables[tableName];
  const fields = crdtFieldsForValidator(table?.validator);
  return fields.length ? { crdtFields: fields } : {};
}

function crdtFieldsForValidator(
  validator: GenericValidator | undefined,
  prefix = "",
): NonNullable<StoreSchema["tables"][number]["crdtFields"]> {
  if (validator === undefined) return [];
  const meta = embeddedFieldMeta(validator);
  if (meta?.placement === "replicated" && prefix) {
    return [{ field: prefix, ...meta.crdt }];
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

function rejectUnsupportedIndexes(
  table: ExportedTable,
  placements: EmbeddedSchemaPlacements,
): void {
  const remote = new Set(placements.indexes[table.tableName]?.remote ?? []);
  for (const [kind, indexes] of [
    ["staged database", table.stagedDbIndexes],
    ["search", table.searchIndexes],
    ["staged search", table.stagedSearchIndexes],
    ["vector", table.vectorIndexes],
    ["staged vector", table.stagedVectorIndexes],
  ] as const) {
    const unsupported = (indexes as readonly { indexDescriptor: string }[] | undefined)?.find(
      (index) => !remote.has(index.indexDescriptor),
    );
    if (unsupported) {
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
      .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replaceAll(/[^a-z0-9_]/g, "_")
      .replaceAll(/^_+|_+$/g, "") || "field"
  );
}
