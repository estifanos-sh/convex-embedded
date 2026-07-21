import type { ComponentApi } from "../component/_generated/component";
import type {
  FunctionReference,
  GenericDatabaseReader,
  GenericQueryCtx,
  QueryBuilder,
  RegisteredQuery,
} from "convex/server";
import { getFunctionName, makeFunctionReference } from "convex/server";
import {
  asObjectValidator,
  ConvexError,
  v,
  type GenericValidator,
  type PropertyValidators,
  type VObject,
} from "convex/values";

import { pullChangeValidator, pullCrdtValidator, resultRowValidator } from "../component/model";
import { canonicalJson, hashDocument } from "../hash";
import { EMBEDDED_PROTOCOL_MISMATCH, EMBEDDED_PROTOCOL_VERSION } from "../protocol";
import { pointerPart } from "../id/path";
import { projectWireDoc, type EmbeddedSchemaPlacements } from "../schema";

const TRANSPORT_FIELD = "embeddedTransport";
const MAX_CAPTURED_ROWS = 1_024;
const NESTED_TRANSACTION_LIMITS = {
  bytesRead: 8 * 1_024 * 1_024,
  databaseQueries: 2_048,
  documentsRead: 2_048,
};

type EmbeddedComponent = ComponentApi<string | undefined>;
export type FunctionManifest = Record<
  string,
  Record<
    string,
    {
      kind: "query" | "mutation";
      placement: "replicated" | "remote" | "local";
      visibility: "public" | "internal";
    }
  >
>;
export type QueryRow = {
  table: string;
  rowId: string;
  fields: unknown;
  crdtFields: string[];
};

type QueryTransport =
  | {
      kind: "direct";
      stack: string[];
      topLevel: false;
    }
  | {
      kind: "capture";
      installation: string;
      stack: string[];
      topLevel: boolean;
    }
  | {
      kind: "live";
      component: string;
      runtime: { schemaHash: string; moduleGraphHash: string; protocolVersion: number };
      stack: string[];
      topLevel: boolean;
    };

type QueryTransportResult =
  | {
      embeddedResult: "eligible";
      installation: string;
      result: unknown;
      rows: QueryRow[];
    }
  | {
      embeddedResult: "ineligible";
      reason: "foreign" | "hosted" | "internal" | "cycle";
    };

type QueryDefinition = {
  args?: PropertyValidators | GenericValidator;
  returns?: PropertyValidators | GenericValidator;
  handler: (ctx: GenericQueryCtx<any>, args: Record<string, unknown>) => unknown;
};

type EmbeddedRegisteredQuery = RegisteredQuery<any, any, any> & {
  __embeddedHandler?: QueryDefinition["handler"];
  __embeddedPlacement?: "replicated";
};

const runtimeValidator = v.object({
  schemaHash: v.string(),
  moduleGraphHash: v.string(),
  protocolVersion: v.number(),
});

const transportValidator = v.union(
  v.object({
    kind: v.literal("direct"),
    stack: v.array(v.string()),
    topLevel: v.literal(false),
  }),
  v.object({
    kind: v.literal("capture"),
    installation: v.string(),
    stack: v.array(v.string()),
    topLevel: v.boolean(),
  }),
  v.object({
    kind: v.literal("live"),
    component: v.string(),
    runtime: runtimeValidator,
    stack: v.array(v.string()),
    topLevel: v.boolean(),
  }),
);

const trackedRowValidator = v.object({
  table: v.string(),
  rowId: v.string(),
  fields: v.any(),
  crdtFields: v.array(v.string()),
});

const transportResultValidator = v.union(
  v.object({
    embeddedResult: v.literal("eligible"),
    installation: v.string(),
    result: v.any(),
    rows: v.array(trackedRowValidator),
  }),
  v.object({
    embeddedResult: v.literal("ineligible"),
    reason: v.union(
      v.literal("foreign"),
      v.literal("hosted"),
      v.literal("internal"),
      v.literal("cycle"),
    ),
  }),
);

const liveResultValidator = v.object({
  members: v.array(v.object({ table: v.string(), rowId: v.string() })),
  changes: v.array(pullChangeValidator),
  crdt: v.array(pullCrdtValidator),
  result: v.any(),
  resultRows: v.array(resultRowValidator),
});

export function buildQueryBuilder(
  base: QueryBuilder<any, "public" | "internal">,
  component: EmbeddedComponent,
  tableNames: string[],
  crdtFields: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
) {
  return (definition: QueryDefinition) => {
    const args = asObjectValidator(definition.args ?? {}) as VObject<
      Record<string, unknown>,
      Record<string, GenericValidator>
    >;
    if (Object.hasOwn(args.fields, TRANSPORT_FIELD)) {
      throw new Error(`Embedded query argument ${TRANSPORT_FIELD} is reserved.`);
    }
    const registered = base({
      args: args.extend({ [TRANSPORT_FIELD]: v.optional(transportValidator) }),
      ...(definition.returns === undefined
        ? {}
        : {
            returns: v.union(
              validator(definition.returns),
              transportResultValidator,
              liveResultValidator,
            ),
          }),
      handler: async (ctx: GenericQueryCtx<any>, received: Record<string, unknown>) => {
        const transport = received[TRANSPORT_FIELD] as QueryTransport | undefined;
        if (transport === undefined) {
          const capture = new QueryCapture(ctx.db, tableNames, crdtFields, placements);
          const appCtx = {
            ...ctx,
            db: capture.reader(),
            runQuery: async (
              reference: FunctionReference<"query", "public" | "internal">,
              args: unknown,
            ) => {
              if (isEmbeddedComponentReference(reference)) {
                return projectComponentQueryResult(
                  placements,
                  tableNames,
                  reference,
                  await runQuery(ctx, reference, args as Record<string, unknown>),
                );
              }
              assertReplicatedReference(manifest, reference, "query");
              const nested = await runQuery(
                ctx,
                reference,
                withTransport(args, { kind: "direct", stack: [], topLevel: false }),
              );
              if (!isTransportResult(nested) || nested.embeddedResult === "ineligible") {
                throw new Error(
                  "EMBEDDED_QUERY_INELIGIBLE: replicated queries may only call replicated queries.",
                );
              }
              return nested.result;
            },
          } as GenericQueryCtx<any>;
          return await definition.handler(appCtx, received);
        }

        const metadata = await ctx.meta.getFunctionMetadata();
        if (transport.topLevel && metadata.visibility !== "public") {
          return ineligible("internal");
        }
        if (transport.stack.includes(metadata.name)) return ineligible("cycle");

        const componentId = transport.kind === "live" ? componentIdentity(component) : "";
        if (transport.kind === "capture") {
          const installation = await installationRead(ctx, component);
          if (installation !== transport.installation) return ineligible("foreign");
        } else if (
          transport.kind === "live" &&
          !transport.topLevel &&
          componentId !== transport.component
        ) {
          return ineligible("foreign");
        }

        const authoredArgs = { ...received };
        delete authoredArgs[TRANSPORT_FIELD];
        const capture = new QueryCapture(ctx.db, tableNames, crdtFields, placements);
        const stack = [...transport.stack, metadata.name];
        const appCtx = {
          ...ctx,
          db: capture.reader(),
          runQuery: async (
            reference: FunctionReference<"query", "public" | "internal">,
            args: unknown,
          ) => {
            if (isEmbeddedComponentReference(reference)) {
              return projectComponentQueryResult(
                placements,
                tableNames,
                reference,
                await runQuery(ctx, reference, args as Record<string, unknown>),
              );
            }
            assertReplicatedReference(manifest, reference, "query");
            const nestedTransport: QueryTransport =
              transport.kind === "direct"
                ? { kind: "direct", stack, topLevel: false }
                : transport.kind === "capture"
                  ? {
                      kind: "capture",
                      installation: transport.installation,
                      stack,
                      topLevel: false,
                    }
                  : {
                      kind: "live",
                      component: componentId,
                      runtime: transport.runtime,
                      stack,
                      topLevel: false,
                    };
            const nested = await runQuery(ctx, reference, withTransport(args, nestedTransport));
            if (!isTransportResult(nested) || nested.embeddedResult === "ineligible") {
              throw new Error("EMBEDDED_QUERY_INELIGIBLE: nested query is not local-capable.");
            }
            const expectedInstallation =
              transport.kind === "capture"
                ? transport.installation
                : transport.kind === "live"
                  ? componentId
                  : "";
            if (nested.installation !== expectedInstallation) {
              throw new Error("EMBEDDED_QUERY_INELIGIBLE: nested query has foreign provenance.");
            }
            capture.add(nested.rows);
            return nested.result;
          },
        } as GenericQueryCtx<any>;
        const result = await definition.handler(appCtx, authoredArgs);
        const rows = capture.returned(result);
        if (transport.kind === "live" && transport.topLevel) {
          return await completeQueryRows(ctx, component, transport.runtime, rows, result);
        }
        return {
          embeddedResult: "eligible" as const,
          installation:
            transport.kind === "capture"
              ? transport.installation
              : transport.kind === "live"
                ? componentId
                : "",
          result,
          rows,
        };
      },
    } as never) as EmbeddedRegisteredQuery;
    registered.__embeddedHandler = definition.handler;
    registered.__embeddedPlacement = "replicated";
    return registered;
  };
}

export async function invokeQueryCapture(
  ctx: GenericQueryCtx<any>,
  component: EmbeddedComponent,
  functionName: string,
  args: unknown,
): Promise<{ result: unknown; rows: QueryRow[] }> {
  const installation = await installationRead(ctx, component);
  const result = await runQuery(
    ctx,
    makeFunctionReference<"query">(functionName),
    withTransport(args, { kind: "capture", installation, stack: [], topLevel: true }),
  );
  if (!isTransportResult(result)) {
    throw new Error("EMBEDDED_QUERY_INELIGIBLE: target is not an Embedded query.");
  }
  if (result.embeddedResult === "ineligible") {
    throw new Error(`EMBEDDED_QUERY_INELIGIBLE: ${result.reason}.`);
  }
  if (result.installation !== installation) {
    throw new Error("EMBEDDED_QUERY_INELIGIBLE: target belongs to another installation.");
  }
  return { result: result.result, rows: result.rows };
}

function withTransport(args: unknown, transport: QueryTransport): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Embedded query arguments must be an object.");
  }
  if (Object.hasOwn(args, TRANSPORT_FIELD)) {
    throw new Error(`Embedded query argument ${TRANSPORT_FIELD} is reserved.`);
  }
  return { ...(args as Record<string, unknown>), [TRANSPORT_FIELD]: transport };
}

function validator(value: PropertyValidators | GenericValidator): GenericValidator {
  return (value as { isConvexValidator?: unknown }).isConvexValidator === true
    ? (value as GenericValidator)
    : v.object(value as PropertyValidators);
}

const TO_REFERENCE_PATH = Symbol.for("toReferencePath");

function componentIdentity(component: EmbeddedComponent): string {
  const reference = component.protocol.pull as unknown as Record<PropertyKey, unknown>;
  const path = reference[TO_REFERENCE_PATH];
  if (typeof path !== "string") {
    throw new Error("Embedded component pull reference has no component path.");
  }
  return path;
}

async function installationRead(
  ctx: GenericQueryCtx<any>,
  component: EmbeddedComponent,
): Promise<string> {
  const reference = (
    component.protocol as unknown as {
      installation: FunctionReference<"query", "internal", Record<string, never>, string>;
    }
  ).installation;
  return await ctx.runQuery(reference, {});
}

async function runQuery(
  ctx: GenericQueryCtx<any>,
  reference: FunctionReference<"query", "public" | "internal">,
  args: Record<string, unknown>,
): Promise<unknown> {
  const call = ctx.runQuery as unknown as (
    query: FunctionReference<"query", "public" | "internal">,
    args: Record<string, unknown>,
    options: { transactionLimits: Record<string, number> },
  ) => Promise<unknown>;
  return await call(reference, args, { transactionLimits: NESTED_TRANSACTION_LIMITS });
}

function ineligible(
  reason: Extract<QueryTransportResult, { embeddedResult: "ineligible" }>["reason"],
): QueryTransportResult {
  return { embeddedResult: "ineligible", reason };
}

function isTransportResult(value: unknown): value is QueryTransportResult {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { embeddedResult?: unknown }).embeddedResult;
  return kind === "eligible" || kind === "ineligible";
}

export function assertReplicatedReference(
  manifest: FunctionManifest | undefined,
  reference: FunctionReference<"query" | "mutation", "public" | "internal">,
  kind: "query" | "mutation",
): void {
  const name = getFunctionName(reference);
  const separator = name.indexOf(":");
  const moduleId = separator < 0 ? name : name.slice(0, separator);
  const exportName = separator < 0 ? "default" : name.slice(separator + 1);
  const declared = manifest?.[moduleId]?.[exportName];
  if (!declared) {
    throw new Error(
      `Embedded replicated functions cannot call app function ${name} without trusted placement metadata.`,
    );
  }
  if (declared.kind !== kind || declared.placement !== "replicated") {
    throw new Error(
      `Embedded replicated functions cannot call ${declared.placement} ${declared.kind} ${name}.`,
    );
  }
}

export function isEmbeddedComponentReference(reference: unknown): boolean {
  if (typeof reference !== "object" || reference === null) return false;
  const path = (reference as Record<PropertyKey, unknown>)[TO_REFERENCE_PATH];
  return typeof path === "string" && path.startsWith("_reference/childComponent/embedded/");
}

export function projectComponentQueryResult(
  placements: EmbeddedSchemaPlacements,
  tableNames: string[],
  reference: unknown,
  result: unknown,
): unknown {
  const path = referencePath(reference);
  if (path?.endsWith("/rev/get")) return projectRevision(placements, tableNames, result);
  if (path?.endsWith("/rev/list")) {
    if (typeof result !== "object" || result === null || !Array.isArray((result as any).page)) {
      throw new Error("Embedded revision list returned a malformed result.");
    }
    return {
      ...(result as Record<string, unknown>),
      page: (result as { page: unknown[] }).page.map((revision) =>
        projectRevision(placements, tableNames, revision),
      ),
    };
  }
  return result;
}

export function projectRevision(
  placements: EmbeddedSchemaPlacements,
  tableNames: string[],
  revision: unknown,
): unknown {
  if (revision === null) return null;
  if (typeof revision !== "object" || Array.isArray(revision)) {
    throw new Error("Embedded revision returned a malformed result.");
  }
  const record = revision as Record<string, unknown>;
  const table = String(record.table);
  if (!tableNames.includes(table)) {
    throw new Error(
      `Replicated functions cannot access revisions for non-replicated table ${table}.`,
    );
  }
  return record.deleted === true || typeof record.value !== "object" || record.value === null
    ? record
    : {
        ...record,
        value: projectWireDoc(placements, table, record.value as Record<string, unknown>),
      };
}

function referencePath(reference: unknown): string | undefined {
  if (typeof reference !== "object" || reference === null) return undefined;
  const path = (reference as Record<PropertyKey, unknown>)[TO_REFERENCE_PATH];
  return typeof path === "string" ? path : undefined;
}

class QueryCapture {
  private readonly rows = new Map<string, QueryRow>();

  constructor(
    private readonly db: GenericDatabaseReader<any>,
    private readonly tableNames: string[],
    private readonly crdtFields: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
    private readonly placements: EmbeddedSchemaPlacements,
  ) {}

  reader(): GenericDatabaseReader<any> {
    return new Proxy(this.db, {
      get: (target, property, receiver) => {
        if (property === "get") {
          return async (first: string, second?: string) => {
            const row =
              second === undefined
                ? await (target as any).get(first)
                : await (target as any).get(first, second);
            const table = second === undefined ? this.tableOf(first) : first;
            if (table === null) {
              if (row !== null) {
                throw new Error("Replicated functions cannot read an unresolved document ID.");
              }
              return null;
            }
            this.assertReplicatedTable(table);
            return this.projectAndRecord(table, row);
          };
        }
        if (property === "query") {
          return (table: string) => this.query(table, (target as any).query(table));
        }
        if (property === "table") {
          return (table: string) => this.table(table, (target as any).table(table));
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  add(rows: QueryRow[]): void {
    for (const row of rows) this.rows.set(memberKey(row.table, row.rowId), row);
    this.assertBound();
  }

  returned(result: unknown): QueryRow[] {
    const returned = new Map<string, QueryRow>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record._id === "string" && typeof record._creationTime === "number") {
        for (const table of this.tableNames) {
          const tracked = this.rows.get(memberKey(table, record._id));
          if (tracked !== undefined && canonicalJson(record) === canonicalJson(tracked.fields)) {
            returned.set(memberKey(table, record._id), tracked);
            break;
          }
        }
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(result);
    if (returned.size > MAX_CAPTURED_ROWS) {
      throw new Error(`Embedded query returned more than ${MAX_CAPTURED_ROWS} documents.`);
    }
    return [...returned.values()];
  }

  private table(table: string, reader: object): object {
    this.assertReplicatedTable(table);
    return new Proxy(reader, {
      get: (target, property, receiver) => {
        if (property === "get") {
          return async (id: string) => {
            const row = await (target as any).get(id);
            return this.projectAndRecord(table, row);
          };
        }
        if (property === "query") {
          return () => this.query(table, (target as any).query());
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  private query(table: string, query: object): object {
    this.assertReplicatedTable(table);
    return new Proxy(query, {
      get: (target, property, receiver) => {
        if (property === Symbol.asyncIterator) {
          const record = (row: unknown) => this.projectAndRecord(table, row);
          return async function* () {
            for await (const row of target as AsyncIterable<unknown>) {
              yield record(row);
            }
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "withIndex") this.assertReplicatedIndex(table, args[0]);
          const next = value.apply(target, args);
          if (property === "collect" || property === "take") {
            return Promise.resolve(next).then((rows: unknown[]) => {
              return rows.map((row) => this.projectAndRecord(table, row));
            });
          }
          if (property === "first" || property === "unique") {
            return Promise.resolve(next).then((row: unknown) => {
              return this.projectAndRecord(table, row);
            });
          }
          if (property === "paginate") {
            return Promise.resolve(next).then((page: { page: unknown[] }) => {
              return {
                ...page,
                page: page.page.map((row) => this.projectAndRecord(table, row)),
              };
            });
          }
          return typeof next === "object" && next !== null ? this.query(table, next) : next;
        };
      },
    });
  }

  private projectAndRecord(table: string, value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const row = projectWireDoc(this.placements, table, value as Record<string, unknown>);
    if (typeof row._id !== "string" || typeof row._creationTime !== "number") return row;
    this.rows.set(memberKey(table, row._id), {
      table,
      rowId: row._id,
      fields: row,
      crdtFields: [...(this.crdtFields.get(table)?.keys() ?? [])],
    });
    this.assertBound();
    return row;
  }

  private tableOf(id: string): string | null {
    for (const table of [...this.tableNames, ...this.placements.remoteTables]) {
      if ((this.db as any).normalizeId(table, id) !== null) return table;
    }
    return null;
  }

  private assertReplicatedTable(table: string): void {
    if (!this.tableNames.includes(table)) {
      throw new Error(`Replicated functions cannot access non-replicated table ${table}.`);
    }
  }

  private assertReplicatedIndex(table: string, index: unknown): void {
    if (
      typeof index === "string" &&
      this.placements.indexes[table]?.remote.includes(index) === true
    ) {
      throw new Error(`Replicated functions cannot access remote index ${table}.${index}.`);
    }
  }

  private assertBound(): void {
    if (this.rows.size > MAX_CAPTURED_ROWS) {
      throw new Error(`Embedded query read more than ${MAX_CAPTURED_ROWS} documents.`);
    }
  }
}

export async function completeQueryRows(
  ctx: GenericQueryCtx<any>,
  component: EmbeddedComponent,
  runtime: { schemaHash: string; moduleGraphHash: string; protocolVersion: number },
  rows: QueryRow[],
  authored: unknown,
) {
  assertRuntimeVersion(runtime);
  const skeleton = matchResult(authored, rows);
  const base = rows.every((row) => row.crdtFields.length === 0)
    ? await plainLiveResult(rows)
    : await ctx.runQuery(component.protocol.pull, { runtime, rows });
  return { ...base, result: skeleton.result, resultRows: skeleton.resultRows };
}

type ResultRow = { path: string; table: string; rowId: string };

function matchResult(
  authored: unknown,
  rows: QueryRow[],
): { result: unknown; resultRows: ResultRow[] } {
  const byId = new Map<string, { table: string; canonical: string }>();
  for (const row of rows) {
    if (!byId.has(row.rowId)) {
      byId.set(row.rowId, { table: row.table, canonical: canonicalJson(row.fields) });
    }
  }
  const resultRows: ResultRow[] = [];
  const encode = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((child, index) => encode(child, `${path}/${index}`));
    if (typeof value !== "object" || value === null || value instanceof ArrayBuffer) return value;
    const record = value as Record<string, unknown>;
    if (typeof record._id === "string" && typeof record._creationTime === "number") {
      const candidate = byId.get(record._id);
      if (candidate !== undefined && canonicalJson(record) === candidate.canonical) {
        resultRows.push({ path, table: candidate.table, rowId: record._id });
        if (resultRows.length > MAX_CAPTURED_ROWS) {
          throw new Error(`Embedded query returned more than ${MAX_CAPTURED_ROWS} documents.`);
        }
        return null;
      }
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        encode(child, `${path}/${pointerPart(key)}`),
      ]),
    );
  };
  return { result: encode(authored, ""), resultRows };
}

async function plainLiveResult(rows: QueryRow[]) {
  const members = rows
    .map(({ table, rowId }) => ({ table, rowId }))
    .sort((left, right) =>
      memberKey(left.table, left.rowId).localeCompare(memberKey(right.table, right.rowId)),
    );
  return {
    members,
    changes: await Promise.all(
      rows.map(async (row) => ({
        op: "put" as const,
        table: row.table,
        rowId: row.rowId,
        fields: row.fields,
        plainHash: await hashDocument(row.fields, row.crdtFields),
      })),
    ),
    crdt: [],
  };
}

function assertRuntimeVersion(runtime: { protocolVersion: number }): void {
  if (runtime.protocolVersion === EMBEDDED_PROTOCOL_VERSION) return;
  throw new ConvexError({
    code: EMBEDDED_PROTOCOL_MISMATCH,
    expected: EMBEDDED_PROTOCOL_VERSION,
    received: runtime.protocolVersion,
  });
}

function memberKey(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`;
}
