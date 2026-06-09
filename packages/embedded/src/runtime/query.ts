import type {
  FilterBuilder as ConvexFilterBuilder,
  GenericDataModel,
  IndexNames,
  NamedIndex,
  NamedTableInfo,
  Query as ConvexQuery,
  TableNamesInDataModel,
} from "convex/server";
import type { Bound, ColValue, RuntimeStorageReader, TableDef } from "../storage/types";
import { compare as compareConvex, equals as equalsConvex } from "./codec";
import type { Doc } from "./model";
import { materialize, type RawDoc } from "./values";

export interface ReadTracker {
  table(table: string): void;
}

export interface QueryOverlay {
  staged: readonly RawDoc[];
  deleted: ReadonlySet<string>;
}

type IndexField<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
  I extends IndexNames<NamedTableInfo<DM, T>>,
> = NamedIndex<NamedTableInfo<DM, T>, I>[number] & keyof Doc<DM, T> & string;
type FilterPredicate<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> = Parameters<
  ConvexQuery<NamedTableInfo<DM, T>>["filter"]
>[0];

export interface IndexRange<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
  I extends IndexNames<NamedTableInfo<DM, T>>,
> {
  eq<F extends IndexField<DM, T, I>>(field: F, value: Doc<DM, T>[F]): IndexRange<DM, T, I>;
  gt<F extends IndexField<DM, T, I>>(field: F, value: Doc<DM, T>[F]): IndexRange<DM, T, I>;
  gte<F extends IndexField<DM, T, I>>(field: F, value: Doc<DM, T>[F]): IndexRange<DM, T, I>;
  lt<F extends IndexField<DM, T, I>>(field: F, value: Doc<DM, T>[F]): IndexRange<DM, T, I>;
  lte<F extends IndexField<DM, T, I>>(field: F, value: Doc<DM, T>[F]): IndexRange<DM, T, I>;
}

interface RuntimeExpression<T> {
  readonly kind: "expression";
  eval(doc: RawDoc): T;
}

export interface OrderedQuery<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> {
  filter(predicate: FilterPredicate<DM, T>): OrderedQuery<DM, T>;
  take(n: number): Promise<Doc<DM, T>[]>;
  collect(): Promise<Doc<DM, T>[]>;
  first(): Promise<Doc<DM, T> | null>;
  unique(): Promise<Doc<DM, T> | null>;
}

export interface Query<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
> extends OrderedQuery<DM, T> {
  withIndex<I extends IndexNames<NamedTableInfo<DM, T>>>(
    index: I,
    range?: (q: IndexRange<DM, T, I>) => IndexRange<DM, T, I>,
  ): Query<DM, T>;
  order(dir: "asc" | "desc"): OrderedQuery<DM, T>;
  filter(predicate: FilterPredicate<DM, T>): Query<DM, T>;
}

interface FieldRange {
  lower?: ColValue;
  lowerInclusive?: boolean;
  upper?: ColValue;
  upperInclusive?: boolean;
}

class Bounds {
  readonly eqs = new Map<string, ColValue>();
  readonly ranges = new Map<string, FieldRange>();

  eq(field: string, value: ColValue): this {
    this.eqs.set(field, toColValue(value));
    return this;
  }
  gt(field: string, value: ColValue): this {
    Object.assign(this.range(field), { lower: toColValue(value), lowerInclusive: false });
    return this;
  }
  gte(field: string, value: ColValue): this {
    Object.assign(this.range(field), { lower: toColValue(value), lowerInclusive: true });
    return this;
  }
  lt(field: string, value: ColValue): this {
    Object.assign(this.range(field), { upper: toColValue(value), upperInclusive: false });
    return this;
  }
  lte(field: string, value: ColValue): this {
    Object.assign(this.range(field), { upper: toColValue(value), upperInclusive: true });
    return this;
  }

  private range(field: string): FieldRange {
    let r = this.ranges.get(field);
    if (!r) {
      r = {};
      this.ranges.set(field, r);
    }
    return r;
  }
}

export class QueryBuilder<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
> implements Query<DM, T> {
  private indexName: string | undefined;
  private bounds: Bounds | undefined;
  private orderDir: "asc" | "desc" = "asc";
  private readonly predicates: ((doc: RawDoc) => boolean)[] = [];

  constructor(
    private readonly store: RuntimeStorageReader,
    private readonly def: TableDef,
    private readonly overlay?: () => QueryOverlay,
    private readonly tracker?: ReadTracker,
  ) {}

  withIndex<I extends IndexNames<NamedTableInfo<DM, T>>>(
    index: I,
    range?: (q: IndexRange<DM, T, I>) => IndexRange<DM, T, I>,
  ): Query<DM, T> {
    if (!this.def.indexes.some((i) => i.name === index)) {
      throw new Error(`unknown index ${String(index)} on table ${this.def.name}`);
    }
    this.indexName = String(index);
    if (range) {
      const bounds = new Bounds();
      range(bounds as unknown as IndexRange<DM, T, I>);
      this.bounds = bounds;
    }
    return this;
  }

  order(dir: "asc" | "desc"): OrderedQuery<DM, T> {
    this.orderDir = dir;
    return this;
  }

  filter(predicate: FilterPredicate<DM, T>): Query<DM, T> {
    const expr = predicate(createFilterBuilder<DM, T>());
    this.predicates.push((doc) => asBoolean(evalExpression(expr, doc)));
    return this;
  }

  take(n: number): Promise<Doc<DM, T>[]> {
    return this.run(n);
  }
  collect(): Promise<Doc<DM, T>[]> {
    return this.run();
  }
  async first(): Promise<Doc<DM, T> | null> {
    return (await this.run(1))[0] ?? null;
  }
  async unique(): Promise<Doc<DM, T> | null> {
    const rows = await this.run(2);
    if (rows.length > 1) throw new Error(`unique: more than one match in ${this.def.name}`);
    return rows[0] ?? null;
  }

  private async run(limit?: number): Promise<Doc<DM, T>[]> {
    this.tracker?.table(this.def.name);
    const overlay = this.overlay?.();
    const slack = overlay ? overlay.deleted.size + overlay.staged.length : 0;
    const backendLimit = this.predicates.length || limit === undefined ? undefined : limit + slack;
    const scanned = await this.store.scan({
      table: this.def.name,
      index: this.indexName,
      bounds: this.buildBounds(),
      order: this.orderDir,
      limit: backendLimit,
    });
    let raw: RawDoc[];
    if (scanned !== null) {
      raw = scanned.map(materialize).filter((d) => this.matchesBounds(d));
    } else {
      const broad = await this.store.scan({ table: this.def.name, order: this.orderDir });
      if (broad === null) throw new Error(`cannot scan table ${this.def.name}`);
      raw = broad.map(materialize).filter((d) => this.matchesBounds(d));
    }
    if (overlay) raw = this.applyOverlay(raw, overlay);
    else raw = this.sort(raw);
    let docs = raw;
    for (const predicate of this.predicates) docs = docs.filter(predicate);
    const materialized = docs as unknown as Doc<DM, T>[];
    return limit !== undefined && materialized.length > limit
      ? materialized.slice(0, limit)
      : materialized;
  }

  private applyOverlay(raw: RawDoc[], overlay: QueryOverlay): RawDoc[] {
    const stagedIds = new Set(overlay.staged.map((d) => d._id));
    const merged = raw.filter((d) => !stagedIds.has(d._id) && !overlay.deleted.has(d._id));
    for (const d of overlay.staged) {
      if (!overlay.deleted.has(d._id) && this.matchesBounds(d)) merged.push(d);
    }
    return this.sort(merged);
  }

  private sort(raw: RawDoc[]): RawDoc[] {
    const order = [...this.indexFields(), "_creationTime", "_id"];
    raw.sort((a, b) => {
      for (const f of order) {
        const c = compareConvex(docValue(a, f), docValue(b, f));
        if (c !== 0) return this.orderDir === "desc" ? -c : c;
      }
      return 0;
    });
    return raw;
  }

  private indexFields(): string[] {
    if (!this.indexName) return [];
    return this.def.indexes.find((i) => i.name === this.indexName)?.fields ?? [];
  }

  private buildBounds(): Bound[] | undefined {
    if (!this.bounds || !this.indexName) return undefined;
    const index = this.def.indexes.find((i) => i.name === this.indexName);
    if (!index) return undefined;
    const out: Bound[] = [];
    for (const field of index.fields) {
      if (this.bounds.eqs.has(field)) {
        out.push({ kind: "eq", value: this.bounds.eqs.get(field) as ColValue });
      } else if (this.bounds.ranges.has(field)) {
        out.push({ kind: "range", ...(this.bounds.ranges.get(field) as FieldRange) });
        break;
      } else {
        break;
      }
    }
    return out.length ? out : undefined;
  }

  private matchesBounds(doc: RawDoc): boolean {
    if (!this.bounds) return true;
    for (const [field, value] of this.bounds.eqs) {
      if (!equalsConvex(docValue(doc, field), value)) return false;
    }
    for (const [field, r] of this.bounds.ranges) {
      const v = docValue(doc, field);
      if (r.lower !== undefined) {
        const c = compareConvex(v, r.lower);
        if (r.lowerInclusive ? c < 0 : c <= 0) return false;
      }
      if (r.upper !== undefined) {
        const c = compareConvex(v, r.upper);
        if (r.upperInclusive ? c > 0 : c >= 0) return false;
      }
    }
    return true;
  }
}

function docValue(doc: RawDoc, field: string): unknown {
  if (field === "_id" || field === "_creationTime") return doc[field];
  return doc[field];
}

function createFilterBuilder<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
>(): ConvexFilterBuilder<NamedTableInfo<DM, T>> {
  const builder = {
    eq: (l: unknown, r: unknown) =>
      expr((doc) => compare("eq", evalExpression(l, doc), evalExpression(r, doc))),
    neq: (l: unknown, r: unknown) =>
      expr((doc) => compare("neq", evalExpression(l, doc), evalExpression(r, doc))),
    lt: (l: unknown, r: unknown) =>
      expr((doc) => compare("lt", evalExpression(l, doc), evalExpression(r, doc))),
    lte: (l: unknown, r: unknown) =>
      expr((doc) => compare("lte", evalExpression(l, doc), evalExpression(r, doc))),
    gt: (l: unknown, r: unknown) =>
      expr((doc) => compare("gt", evalExpression(l, doc), evalExpression(r, doc))),
    gte: (l: unknown, r: unknown) =>
      expr((doc) => compare("gte", evalExpression(l, doc), evalExpression(r, doc))),
    add: (l: unknown, r: unknown) =>
      expr((doc) => numeric("add", evalExpression(l, doc), evalExpression(r, doc))),
    sub: (l: unknown, r: unknown) =>
      expr((doc) => numeric("sub", evalExpression(l, doc), evalExpression(r, doc))),
    mul: (l: unknown, r: unknown) =>
      expr((doc) => numeric("mul", evalExpression(l, doc), evalExpression(r, doc))),
    div: (l: unknown, r: unknown) =>
      expr((doc) => numeric("div", evalExpression(l, doc), evalExpression(r, doc))),
    mod: (l: unknown, r: unknown) =>
      expr((doc) => numeric("mod", evalExpression(l, doc), evalExpression(r, doc))),
    neg: (x: unknown) => expr((doc) => negate(evalExpression(x, doc))),
    not: (x: unknown) => expr((doc) => !asBoolean(evalExpression(x, doc))),
    and: (...exprs: unknown[]) =>
      expr((doc) => exprs.every((candidate) => asBoolean(evalExpression(candidate, doc)))),
    or: (...exprs: unknown[]) =>
      expr((doc) => exprs.some((candidate) => asBoolean(evalExpression(candidate, doc)))),
    field: (fieldPath: string) => expr((doc) => fieldValue(doc, fieldPath)),
  };
  return builder as unknown as ConvexFilterBuilder<NamedTableInfo<DM, T>>;
}

function expr<T>(evalFn: (doc: RawDoc) => T): RuntimeExpression<T> {
  return { kind: "expression", eval: evalFn };
}

function isExpression(value: unknown): value is RuntimeExpression<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === "expression" &&
    typeof (value as Record<string, unknown>).eval === "function"
  );
}

function evalExpression(value: unknown, doc: RawDoc): unknown {
  return isExpression(value) ? value.eval(doc) : value;
}

function fieldValue(doc: RawDoc, fieldPath: string): unknown {
  let current: unknown = doc;
  for (const segment of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function compare(op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte", l: unknown, r: unknown): boolean {
  const c = compareConvex(l, r);
  switch (op) {
    case "eq":
      return c === 0;
    case "neq":
      return c !== 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
  }
}

function numeric(op: "add" | "sub" | "mul" | "div" | "mod", l: unknown, r: unknown): unknown {
  if (!sameNumericType(l, r))
    throw new Error(`filter ${op}: values must have the same numeric type`);
  if (typeof l === "bigint" && typeof r === "bigint") {
    switch (op) {
      case "add":
        return l + r;
      case "sub":
        return l - r;
      case "mul":
        return l * r;
      case "div":
        return l / r;
      case "mod":
        return l % r;
    }
  }
  const ln = l as number;
  const rn = r as number;
  switch (op) {
    case "add":
      return ln + rn;
    case "sub":
      return ln - rn;
    case "mul":
      return ln * rn;
    case "div":
      return ln / rn;
    case "mod":
      return ln % rn;
  }
}

function negate(value: unknown): unknown {
  if (typeof value === "number") return -value;
  if (typeof value === "bigint") return -value;
  throw new Error("filter neg: value must be numeric");
}

function sameNumericType(l: unknown, r: unknown): boolean {
  return (
    (typeof l === "number" && typeof r === "number") ||
    (typeof l === "bigint" && typeof r === "bigint")
  );
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("filter expression must evaluate to a boolean");
  return value;
}

function toColValue(value: unknown): ColValue {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "bigint" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`query bound value is not supported: ${describeValue(value)}`);
}

function describeValue(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "undefined") return "undefined";
  return JSON.stringify(value) ?? typeof value;
}
