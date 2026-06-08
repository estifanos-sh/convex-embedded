import type {
  GenericDataModel,
  IndexNames,
  NamedIndex,
  NamedTableInfo,
  TableNamesInDataModel,
} from "convex/server";
import type { EmbeddedStore } from "../storage/store";
import type { Bound, Param, TableDef } from "../storage/types";
import type { Doc } from "./model";
import { materialize, type RawDoc } from "./values";

type IndexField<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
  I extends IndexNames<NamedTableInfo<DM, T>>,
> = NamedIndex<NamedTableInfo<DM, T>, I>[number] & keyof Doc<DM, T> & string;

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

export interface OrderedQuery<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> {
  filter(predicate: (doc: Doc<DM, T>) => boolean): OrderedQuery<DM, T>;
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
  filter(predicate: (doc: Doc<DM, T>) => boolean): Query<DM, T>;
}

interface FieldRange {
  lower?: Param;
  lowerInclusive?: boolean;
  upper?: Param;
  upperInclusive?: boolean;
}

class Bounds {
  readonly eqs = new Map<string, Param>();
  readonly ranges = new Map<string, FieldRange>();

  eq(field: string, value: Param): this {
    this.eqs.set(field, value);
    return this;
  }
  gt(field: string, value: Param): this {
    Object.assign(this.range(field), { lower: value, lowerInclusive: false });
    return this;
  }
  gte(field: string, value: Param): this {
    Object.assign(this.range(field), { lower: value, lowerInclusive: true });
    return this;
  }
  lt(field: string, value: Param): this {
    Object.assign(this.range(field), { upper: value, upperInclusive: false });
    return this;
  }
  lte(field: string, value: Param): this {
    Object.assign(this.range(field), { upper: value, upperInclusive: true });
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
  private readonly predicates: ((doc: Doc<DM, T>) => boolean)[] = [];

  constructor(
    private readonly store: EmbeddedStore,
    private readonly def: TableDef,
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

  filter(predicate: (doc: Doc<DM, T>) => boolean): Query<DM, T> {
    this.predicates.push(predicate);
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
    const pushdownLimit = this.predicates.length ? undefined : limit;
    const scanned = await this.store.scan({
      table: this.def.name,
      index: this.indexName,
      bounds: this.buildBounds(),
      order: this.orderDir,
      limit: pushdownLimit,
    });
    let raw: RawDoc[];
    if (scanned !== null) {
      raw = scanned.map(materialize);
    } else {
      const broad = await this.store.scan({ table: this.def.name, order: this.orderDir });
      if (broad === null) throw new Error(`cannot scan table ${this.def.name}`);
      raw = broad.map(materialize).filter((d) => this.matchesBounds(d));
    }
    let docs = raw as unknown as Doc<DM, T>[];
    for (const predicate of this.predicates) docs = docs.filter(predicate);
    return limit !== undefined && docs.length > limit ? docs.slice(0, limit) : docs;
  }

  private buildBounds(): Bound[] | undefined {
    if (!this.bounds || !this.indexName) return undefined;
    const index = this.def.indexes.find((i) => i.name === this.indexName);
    if (!index) return undefined;
    const out: Bound[] = [];
    for (const field of index.fields) {
      if (this.bounds.eqs.has(field)) {
        out.push({ kind: "eq", value: this.bounds.eqs.get(field) as Param });
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
      if (doc[field] !== value) return false;
    }
    for (const [field, r] of this.bounds.ranges) {
      const v = doc[field];
      if (r.lower !== undefined) {
        const c = cmp(v, r.lower);
        if (r.lowerInclusive ? c < 0 : c <= 0) return false;
      }
      if (r.upper !== undefined) {
        const c = cmp(v, r.upper);
        if (r.upperInclusive ? c > 0 : c >= 0) return false;
      }
    }
    return true;
  }
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
