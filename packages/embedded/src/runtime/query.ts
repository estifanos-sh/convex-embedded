import type {
  FilterBuilder as ConvexFilterBuilder,
  GenericDataModel,
  IndexNames,
  IndexRange as ConvexIndexRange,
  IndexRangeBuilder as ConvexIndexRangeBuilder,
  NamedIndex,
  NamedTableInfo,
  Query as ConvexQuery,
  TableNamesInDataModel,
} from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import type { JSONValue, Value } from "convex/values";
import {
  DEFAULT_READ_PAGE,
  type Bound,
  type ColValue,
  type RuntimeStorageReader,
  type TableDef,
} from "../storage/types";
import { hashDocument, hashValue } from "../hash";
import type { ReadAuthority } from "./cache";
import { compare as compareConvex, equals as equalsConvex, freezeNormalizedTree } from "./codec";
import type { Doc } from "./model";
import { compileFieldPath, readFieldPath, type RawDoc } from "./doc";

/**
 * One index-range bound on the wire. `value` is a Convex value serialized as JSON, matching the
 * projection-field codec so client and server compare bounds identically (contract §2/§4).
 *
 * @internal
 */
export interface ReadBound {
  field: string;
  value: JSONValue;
  inclusive: boolean;
}

export interface ReadEquality {
  field: string;
  value: JSONValue;
}

/**
 * An index-range read: the exact scope a list query depends on (contract §4). Full-table scans carry
 * no index and are published as `{kind:"all"}`, so a `ReadRange` always names an index.
 *
 * @internal
 */
export interface ReadRange {
  table: string;
  index: string;
  equality: ReadEquality[];
  limit?: number;
  lower?: ReadBound;
  upper?: ReadBound;
  order: "asc" | "desc";
}

/**
 * One member of the optimistic run's read-set with the version it observed (contract §2). A point
 * read carries the row id; a range read carries the index bounds plus the ids it saw. `version` is
 * the remote sequence / adoption clock the local replica held, stamped by the store on capture.
 *
 * @internal
 */
export type BaseVersion =
  | {
      table: string;
      id: string;
      version: number;
      contentHash: string;
      crdt: Array<{
        field: string;
        epoch: number;
        headSeq: number;
        projectionHash: string;
      }>;
    }
  | {
      table: string;
      index: string;
      order: "asc" | "desc";
      equality: ReadEquality[];
      limit?: number;
      lower?: ReadBound;
      upper?: ReadBound;
      members: string[];
      memberHashes: string[];
      membersHash: string;
      version: number;
    };

/**
 * Tracks the read-set of a query: the shared substrate for local invalidation, the pull scope
 * (`range`, contract §4), and the push read-set (`point`/`range` base-versions, contract §2).
 *
 * @remarks
 * `doc`/`table` drive LOCAL reactive invalidation and are unchanged. `range` publishes the remote
 * pull scope. `point` records a point base-version. `range` doubles as the range base-version when a
 * mutation reads over an index. Members and version stamping ride the emitted shapes.
 *
 * @internal
 */
export interface ReadTracker {
  doc?(id: string): void;
  table(table: string): void;
  range?(
    range: ReadRange,
    members: string[],
    memberHashes: string[],
    membersHash: string,
    version: number,
  ): void;
  point?(base: Extract<BaseVersion, { id: string }>): void;
  /**
   * Read-authority sink for the retained-result cache (Cut 7 §4.1): a watch evaluation records
   * whether each read stays within its own authoritative disclosure. Present only for remote-scoped
   * watch reruns; local invalidation and push/pull scope leave it undefined.
   */
  authority?: ReadAuthority;
}

/**
 * Staged mutation changes applied over committed storage during read-your-writes queries.
 *
 * @internal
 */
export interface QueryOverlay {
  staged: readonly RawDoc[];
  deleted: ReadonlySet<string>;
}

type FilterPredicate<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> = Parameters<
  ConvexQuery<NamedTableInfo<DM, T>>["filter"]
>[0];

/**
 * Convex-compatible index range builder type used by the local query facade.
 *
 * @internal
 */
export type IndexRange<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
  I extends IndexNames<NamedTableInfo<DM, T>>,
> = ConvexIndexRangeBuilder<Doc<DM, T>, NamedIndex<NamedTableInfo<DM, T>, I>>;

interface RuntimeExpression<T> {
  readonly kind: "expression";
  eval(doc: RawDoc): T;
}

/**
 * Ordered local query surface.
 *
 * @internal
 */
export interface OrderedQuery<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> {
  filter(predicate: FilterPredicate<DM, T>): OrderedQuery<DM, T>;
  limit(n: number): OrderedQuery<DM, T>;
  paginate(options: PaginationOptions): Promise<PaginationResult<Doc<DM, T>>>;
  take(n: number): Promise<Doc<DM, T>[]>;
  collect(): Promise<Doc<DM, T>[]>;
  first(): Promise<Doc<DM, T> | null>;
  unique(): Promise<Doc<DM, T> | null>;
  [Symbol.asyncIterator](): AsyncIterator<Doc<DM, T>>;
}

/**
 * Local query initializer/query surface exposed through `ctx.db.query`.
 *
 * @internal
 */
export interface Query<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
> extends OrderedQuery<DM, T> {
  count(): Promise<number>;
  fullTableScan(): Query<DM, T>;
  withIndex<I extends IndexNames<NamedTableInfo<DM, T>>>(
    index: I,
    range?: (q: IndexRange<DM, T, I>) => ConvexIndexRange,
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

type RangeExpression =
  | { type: "eq"; field: string; value: ColValue }
  | { type: "gt"; field: string; value: ColValue }
  | { type: "gte"; field: string; value: ColValue }
  | { type: "lt"; field: string; value: ColValue }
  | { type: "lte"; field: string; value: ColValue };

class Bounds {
  private consumed = false;

  constructor(private readonly expressions: readonly RangeExpression[] = []) {}

  eq(field: string, value: ColValue): Bounds {
    return this.next({ type: "eq", field, value: toColValue(value) });
  }

  gt(field: string, value: ColValue): Bounds {
    return this.next({ type: "gt", field, value: toColValue(value) });
  }

  gte(field: string, value: ColValue): Bounds {
    return this.next({ type: "gte", field, value: toColValue(value) });
  }

  lt(field: string, value: ColValue): Bounds {
    return this.next({ type: "lt", field, value: toColValue(value) });
  }

  lte(field: string, value: ColValue): Bounds {
    return this.next({ type: "lte", field, value: toColValue(value) });
  }

  export(): readonly RangeExpression[] {
    this.consume();
    return this.expressions;
  }

  private next(expression: RangeExpression): Bounds {
    this.consume();
    return new Bounds([...this.expressions, expression]);
  }

  private consume(): void {
    if (this.consumed) {
      throw new Error(
        "IndexRangeBuilder has already been used! Chain your method calls like `q => q.eq(...).eq(...)`. See https://docs.convex.dev/using/indexes",
      );
    }
    this.consumed = true;
  }
}

interface QueryPlan {
  bounds?: readonly RangeExpression[];
  indexName?: string;
  initializer?: boolean;
  limit?: number;
  orderSet?: boolean;
  orderDir?: "asc" | "desc";
  predicates?: readonly ((doc: RawDoc) => boolean)[];
}

interface PaginationOptions {
  cursor: string | null;
  endCursor?: string | null;
  numItems: number;
}

interface PaginationResult<T> {
  continueCursor: string;
  isDone: boolean;
  page: T[];
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
  splitCursor?: string | null;
}

/** A pre-split order field: a Convex field path plus its compiled segments. */
interface OrderField {
  field: string;
  segments: readonly string[];
}

/** A document's order-key tuple in Convex value space. */
type KeyTuple = readonly unknown[];

const FIRST_PAGE = 64;
const MIN_PAGE = 16;

/**
 * Runtime implementation of the local query facade.
 *
 * Every terminal consumes one streaming pipeline: paged backend scans (already in index order)
 * are reordered only within SQL-NULL-ambiguous runs, merged with the sorted overlay, re-checked
 * against exact Convex bounds, and filtered — pulling pages only while consumers keep reading.
 *
 * @internal
 */
export class QueryBuilder<
  DM extends GenericDataModel,
  T extends TableNamesInDataModel<DM>,
> implements Query<DM, T> {
  private readonly bounds: readonly RangeExpression[] | undefined;
  private consumed = false;
  private readonly indexName: string | undefined;
  private readonly initializer: boolean;
  private readonly limitCount: number | undefined;
  private readonly orderDir: "asc" | "desc";
  private readonly orderSet: boolean;
  private readonly predicates: readonly ((doc: RawDoc) => boolean)[];
  /** Bound expressions with pre-split field paths; compiled once per builder, read per doc. */
  private readonly matchers: readonly {
    expression: RangeExpression;
    segments: readonly string[];
  }[];

  constructor(
    private readonly store: RuntimeStorageReader,
    private readonly def: TableDef,
    private readonly overlay?: () => QueryOverlay,
    private readonly tracker?: ReadTracker,
    plan: QueryPlan = {},
  ) {
    this.bounds = plan.bounds;
    this.indexName = plan.indexName;
    this.initializer = plan.initializer ?? true;
    this.limitCount = plan.limit;
    this.orderDir = plan.orderDir ?? "asc";
    this.orderSet = plan.orderSet ?? false;
    this.predicates = plan.predicates ?? [];
    this.matchers = (plan.bounds ?? []).map((expression) => ({
      expression,
      segments: compileFieldPath(expression.field),
    }));
  }

  fullTableScan(): Query<DM, T> {
    if (!this.initializer) {
      throw new Error("fullTableScan can only be called on a table query initializer.");
    }
    return this.withPlan({ bounds: undefined, indexName: undefined });
  }

  withIndex<I extends IndexNames<NamedTableInfo<DM, T>>>(
    index: I,
    range?: (q: IndexRange<DM, T, I>) => ConvexIndexRange,
  ): Query<DM, T> {
    if (!this.initializer) {
      throw new Error("withIndex can only be called on a table query initializer.");
    }
    if (!this.def.indexes.some((i) => i.name === index)) {
      throw new Error(`unknown index ${String(index)} on table ${this.def.name}`);
    }
    let bounds: readonly RangeExpression[] | undefined;
    if (range) {
      const builder = range(new Bounds() as unknown as IndexRange<DM, T, I>);
      if (!(builder instanceof Bounds)) {
        throw new Error("Index range callback must return a range builder.");
      }
      bounds = builder.export();
    }
    return this.withPlan({ bounds, indexName: String(index) });
  }

  order(dir: "asc" | "desc"): OrderedQuery<DM, T> {
    const query = this.consumeForUse();
    if (query.orderSet) throw new Error("order can only be specified once");
    return query.withPlan({ orderDir: dir, orderSet: true });
  }

  filter(predicate: FilterPredicate<DM, T>): Query<DM, T> {
    const query = this.consumeForUse();
    const expr = predicate(createFilterBuilder<DM, T>());
    return query.withPlan({
      predicates: [...query.predicates, (doc) => asBoolean(evalExpression(expr, doc))],
    });
  }

  take(n: number): Promise<Doc<DM, T>[]> {
    validateNonNegativeInteger(n, "take");
    if (n === 0) return Promise.resolve([]);
    const query = this.consumeForUse().withPlan({ limit: n });
    return query.collect();
  }

  async collect(): Promise<Doc<DM, T>[]> {
    const query = this.consumeForUse();
    const overlay = query.activeOverlay();
    const bounds = query.buildBounds();
    if (query.canUseDirectStorage(bounds, overlay)) {
      return (await query.collectDirect(bounds, query.limitCount)) as unknown as Doc<DM, T>[];
    }
    const docs: RawDoc[] = [];
    for await (const batch of query.batches(undefined, undefined, overlay, bounds)) {
      for (const doc of batch) docs.push(doc);
    }
    return docs as unknown as Doc<DM, T>[];
  }

  async count(): Promise<number> {
    const query = this.consumeForUse();
    query.tracker?.table(query.def.name);
    query.tracker?.authority?.readCount();
    const bounds = query.buildBounds();
    const overlay = query.activeOverlay();
    if (boundsAreExact(bounds) && !query.predicates.length) {
      if (!overlay) {
        const pushed = await query.store.doc.count.read({
          table: query.def.name,
          index: query.indexName,
          bounds,
        });
        if (pushed !== null) return pushed;
      } else {
        return query.countWithOverlay(bounds, overlay);
      }
    }
    let n = 0;
    for await (const batch of query.batches()) n += batch.length;
    return n;
  }

  async first(): Promise<Doc<DM, T> | null> {
    const query = this.consumeForUse().withPlan({ limit: 1 });
    const overlay = query.activeOverlay();
    const bounds = query.buildBounds();
    if (query.canUseDirectStorage(bounds, overlay)) {
      return ((await query.collectDirect(bounds, 1))[0] as unknown as Doc<DM, T>) ?? null;
    }
    return ((await query.collect())[0] as Doc<DM, T>) ?? null;
  }

  async unique(): Promise<Doc<DM, T> | null> {
    const rows = await this.take(2);
    if (rows.length > 1) {
      const firstId = rows[0]!._id as string;
      const secondId = rows[1]!._id as string;
      throw new Error(
        `unique() query returned more than one result from table ${this.def.name}:\n [${firstId}, ${secondId}, ...]`,
      );
    }
    return rows[0] ?? null;
  }

  limit(n: number): OrderedQuery<DM, T> {
    validateNonNegativeInteger(n, "limit");
    const query = this.consumeForUse();
    return query.withPlan({
      limit: query.limitCount === undefined ? n : Math.min(query.limitCount, n),
    });
  }

  async paginate(options: PaginationOptions): Promise<PaginationResult<Doc<DM, T>>> {
    validatePositiveInteger(options.numItems, "paginate");
    const query = this.consumeForUse();
    const orderFields = query.orderFields();
    const after = decodePageCursor(options.cursor);
    const end =
      options.endCursor === null || options.endCursor === undefined
        ? undefined
        : decodePageCursor(options.endCursor);

    if (after === END) {
      return {
        continueCursor: PAGE_CURSOR_END,
        isDone: true,
        page: [],
        pageStatus: null,
        splitCursor: null,
      };
    }

    const page: RawDoc[] = [];
    let lastKey: KeyTuple | undefined;
    let exhausted = true;
    outer: for await (const batch of query.batches(after, options.numItems)) {
      for (const doc of batch) {
        const key = query.keyOf(doc, orderFields);
        if (end !== undefined && end !== END && query.compareKeys(key, end) > 0) {
          exhausted = false;
          break outer;
        }
        page.push(doc);
        lastKey = key;
        if (end === undefined && page.length >= options.numItems) {
          exhausted = false;
          break outer;
        }
      }
    }

    if (end !== undefined) {
      return {
        continueCursor: options.endCursor ?? PAGE_CURSOR_END,
        isDone: end === END && exhausted,
        page: page as unknown as Doc<DM, T>[],
        pageStatus: null,
        splitCursor: null,
      };
    }
    return {
      continueCursor:
        exhausted || lastKey === undefined
          ? PAGE_CURSOR_END
          : encodePageCursor(lastKey, orderFields),
      isDone: exhausted,
      page: page as unknown as Doc<DM, T>[],
      pageStatus: null,
      splitCursor: null,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<Doc<DM, T>> {
    return this.consumeForUse().docs() as AsyncIterator<unknown> as AsyncIterator<Doc<DM, T>>;
  }

  /** Thin per-document view of {@link batches} for the public async iterator. */
  private async *docs(
    after?: KeyTuple,
    limitHint?: number,
  ): AsyncGenerator<RawDoc, void, undefined> {
    for await (const batch of this.batches(after, limitHint)) yield* batch;
  }

  /**
   * The streaming pipeline every terminal consumes, page-batched: the async boundary is one
   * backend page, and all per-document work — staged-overlay merge, resume guard, predicates,
   * limit — runs in sync loops. Stops fetching as soon as the consumer stops pulling. Every
   * backend doc — even one that is deleted, overridden, or filtered — is an order watermark
   * that flushes staged docs sorted before it.
   */
  private async *batches(
    after?: KeyTuple,
    limitHint?: number,
    overlayArg?: QueryOverlay,
    boundsArg?: Bound[],
  ): AsyncGenerator<readonly RawDoc[], void, undefined> {
    this.tracker?.table(this.def.name);
    if (this.limitCount === 0) return;
    const orderFields = this.orderFields();
    const byOrder = (a: RawDoc, b: RawDoc): number => this.compareDocs(a, b, orderFields);
    const overlay = overlayArg ?? this.activeOverlay();
    const deleted = overlay?.deleted;
    const overridden = overlay ? new Set(overlay.staged.map((d) => d._id)) : undefined;
    const staged =
      overlay && overlay.staged.length
        ? overlay.staged
            .filter((d) => !overlay.deleted.has(d._id) && this.matchesBounds(d))
            .sort(byOrder)
        : [];
    const slack = overlay ? overlay.deleted.size + overlay.staged.length : 0;
    const hint = limitHint ?? this.limitCount;
    const firstPage =
      hint === undefined
        ? FIRST_PAGE
        : Math.min(Math.max(hint + slack + 1, MIN_PAGE), DEFAULT_READ_PAGE);

    let emitted = 0;
    let stagedIndex = 0;
    const limit = this.limitCount;
    const afterId =
      after !== undefined && typeof after.at(-1) === "string"
        ? (after.at(-1) as string)
        : undefined;
    const passes = (doc: RawDoc): boolean =>
      this.matchesBounds(doc) &&
      doc._id !== afterId &&
      (after === undefined || this.compareKeys(this.keyOf(doc, orderFields), after) > 0) &&
      this.predicates.every((predicate) => predicate(doc));

    const bounds = boundsArg ?? this.buildBounds();
    for await (const page of this.pages(firstPage, after, bounds)) {
      const out: RawDoc[] = [];
      for (const doc of page) {
        while (stagedIndex < staged.length && byOrder(staged[stagedIndex]!, doc) < 0) {
          const next = staged[stagedIndex++]!;
          if (passes(next)) {
            out.push(next);
            if (limit !== undefined && ++emitted >= limit) {
              yield out;
              return;
            }
          }
        }
        if (deleted?.has(doc._id) || overridden?.has(doc._id)) continue;
        if (passes(doc)) {
          out.push(doc);
          if (limit !== undefined && ++emitted >= limit) {
            yield out;
            return;
          }
        }
      }
      if (out.length) yield out;
    }

    const out: RawDoc[] = [];
    while (stagedIndex < staged.length) {
      const next = staged[stagedIndex++]!;
      if (passes(next)) {
        out.push(next);
        if (limit !== undefined && ++emitted >= limit) break;
      }
    }
    if (out.length) yield out;
  }

  /**
   * Backend pages in exact Convex order. Index columns store order-preserving keys, so the
   * SQLite index B-tree is already in Convex order — including `undefined` < `null`, `-0` < `+0`,
   * int64 before float64, and NaN — with no reorder needed. Bounds are exact too, so pages stream
   * straight through. A keyset resume seek is exact for every value, so `resumeAfterKey` carries
   * the full key (no collapsed-value rescan).
   */
  private async *pages(
    firstPage: number,
    after: KeyTuple | undefined,
    bounds: Bound[] | undefined = this.buildBounds(),
  ): AsyncGenerator<readonly RawDoc[], void, undefined> {
    const resumeAfterKey = after?.map((value) => value as ColValue);
    let cursor: string | undefined;
    let pageSize = firstPage;
    while (true) {
      const page = await this.store.doc.page.read({
        table: this.def.name,
        index: this.indexName,
        bounds,
        order: this.orderDir,
        pageSize,
        cursor,
        resumeAfterKey: cursor === undefined ? resumeAfterKey : undefined,
      });
      for (const doc of page.docs) this.tracker?.doc?.(doc._id);
      this.tracker?.authority?.readRange(
        page.docs.map((doc) => doc._id),
        this.indexName !== undefined,
      );
      await this.captureRange(bounds, page.docs, page.versions);
      if (page.docs.length) yield page.docs;
      if (page.cursor === null) return;
      cursor = page.cursor;
      pageSize = Math.min(pageSize * 2, DEFAULT_READ_PAGE);
    }
  }

  private async collectDirect(
    bounds: Bound[] | undefined,
    limit: number | undefined,
  ): Promise<RawDoc[]> {
    this.tracker?.table(this.def.name);
    if (limit === 0) return [];
    if (limit !== undefined && limit <= DEFAULT_READ_PAGE) {
      const page = await this.store.doc.page.read({
        table: this.def.name,
        index: this.indexName,
        bounds,
        order: this.orderDir,
        pageSize: limit,
      });
      for (const doc of page.docs) this.tracker?.doc?.(doc._id);
      this.tracker?.authority?.readRange(
        page.docs.map((doc) => doc._id),
        this.indexName !== undefined,
      );
      await this.captureRange(bounds, page.docs, page.versions);
      return page.docs;
    }
    const docs: RawDoc[] = [];
    let cursor: string | undefined;
    do {
      const remaining = limit === undefined ? DEFAULT_READ_PAGE : limit - docs.length;
      if (remaining <= 0) break;
      const page = await this.store.doc.page.read({
        table: this.def.name,
        index: this.indexName,
        bounds,
        order: this.orderDir,
        pageSize: Math.min(remaining, DEFAULT_READ_PAGE),
        cursor,
      });
      for (const doc of page.docs) this.tracker?.doc?.(doc._id);
      this.tracker?.authority?.readRange(
        page.docs.map((doc) => doc._id),
        this.indexName !== undefined,
      );
      await this.captureRange(bounds, page.docs, page.versions);
      docs.push(...page.docs);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    freezeNormalizedTree(docs);
    return docs;
  }

  private canUseDirectStorage(
    bounds: Bound[] | undefined,
    overlay: QueryOverlay | undefined,
  ): boolean {
    return (
      this.store.capabilities?.hasExactBounds === true &&
      !overlay &&
      !this.predicates.length &&
      boundsAreExact(bounds)
    );
  }

  private activeOverlay(): QueryOverlay | undefined {
    const overlay = this.overlay?.();
    return overlay && (overlay.staged.length || overlay.deleted.size) ? overlay : undefined;
  }

  /** Counts committed keys (no payload decode) adjusted by the overlay's staged/deleted ids. */
  private async countWithOverlay(
    bounds: Bound[] | undefined,
    overlay: QueryOverlay,
  ): Promise<number> {
    const overridden = new Set(overlay.staged.map((d) => d._id));
    let n = overlay.staged.filter(
      (d) => !overlay.deleted.has(d._id) && this.matchesBounds(d),
    ).length;
    let cursor: string | undefined;
    do {
      const page = await this.store.key.page.read({
        table: this.def.name,
        index: this.indexName,
        bounds,
        order: this.orderDir,
        cursor,
      });
      for (const id of page.ids) {
        if (!overlay.deleted.has(id) && !overridden.has(id)) n += 1;
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return n;
  }

  /** The order-key fields of this query: index fields, then `_creationTime`, then `_id`. */
  private orderFields(): OrderField[] {
    const fields = unique([...this.indexFields(), "_creationTime", "_id"]);
    return fields.map((field) => ({ field, segments: compileFieldPath(field) }));
  }

  private keyOf(doc: RawDoc, orderFields: readonly OrderField[]): KeyTuple {
    return orderFields.map((key) => docValue(doc, key));
  }

  /** Tuple comparison in emit order (direction applied). */
  private compareKeys(a: KeyTuple, b: KeyTuple): number {
    for (let i = 0; i < a.length; i += 1) {
      const c = compareConvex(a[i], b[i]);
      if (c !== 0) return this.orderDir === "desc" ? -c : c;
    }
    return 0;
  }

  private compareDocs(a: RawDoc, b: RawDoc, orderFields: readonly OrderField[]): number {
    for (const key of orderFields) {
      const c = compareConvex(docValue(a, key), docValue(b, key));
      if (c !== 0) return this.orderDir === "desc" ? -c : c;
    }
    return 0;
  }

  private indexFields(): string[] {
    if (!this.indexName) return [];
    return this.def.indexes.find((i) => i.name === this.indexName)?.fields ?? [];
  }

  private wireBound(field: string, value: ColValue, inclusive: boolean): ReadBound | undefined {
    if (value === undefined) return undefined;
    return { field, value: convexToJson(value as Value), inclusive };
  }

  /**
   * The wire {@link ReadRange} for this scan, or `undefined` for a full-table scan (which publishes
   * as `{kind:"all"}`). Bounds map from the last index column: an `eq` pins a point range, a `range`
   * carries its lower/upper.
   */
  private readRangeOf(bounds: Bound[] | undefined): ReadRange | undefined {
    if (this.indexName === undefined) return undefined;
    const range: ReadRange = {
      table: this.def.name,
      index: this.indexName,
      equality: [],
      order: this.orderDir,
      ...(this.limitCount === undefined ? {} : { limit: this.limitCount }),
    };
    const fields = this.indexFields();
    for (let index = 0; index < (bounds?.length ?? 0); index += 1) {
      const bound = bounds![index]!;
      if (bound.kind !== "eq") break;
      range.equality.push({ field: fields[index]!, value: convexToJson(bound.value as Value) });
    }
    const last = bounds?.[bounds.length - 1];
    if (last?.kind === "range") {
      const field = fields[(bounds?.length ?? 1) - 1]!;
      const lower = this.wireBound(field, last.lower as ColValue, last.lowerInclusive ?? true);
      const upper = this.wireBound(field, last.upper as ColValue, last.upperInclusive ?? true);
      if (lower !== undefined) range.lower = lower;
      if (upper !== undefined) range.upper = upper;
    }
    return range;
  }

  private async captureRange(
    bounds: Bound[] | undefined,
    members: readonly RawDoc[],
    versions: Record<string, number> | undefined,
  ): Promise<void> {
    if (this.tracker?.range === undefined) return;
    const range = this.readRangeOf(bounds);
    if (range === undefined) return;
    const ids = members.map((doc) => doc._id);
    const omitted = (this.def.crdtFields ?? []).map((field) => field.field);
    const memberHashes = await Promise.all(members.map((member) => hashDocument(member, omitted)));
    this.tracker.range(
      range,
      ids,
      memberHashes,
      await hashValue(ids.map((id, index) => ({ id, hash: memberHashes[index] }))),
      readVersion(members, versions),
    );
  }

  private buildBounds(): Bound[] | undefined {
    if (!this.bounds?.length || !this.indexName) return undefined;
    const index = this.def.indexes.find((i) => i.name === this.indexName);
    if (!index) return undefined;
    const out: Bound[] = [];
    let expressionIndex = 0;
    for (const field of index.fields) {
      const expression = this.bounds[expressionIndex];
      if (!expression) break;
      if (expression.field !== field) {
        throw new Error(
          `index range field ${expression.field} does not match index field ${field}`,
        );
      }
      if (expression.type === "eq") {
        out.push({ kind: "eq", value: expression.value });
        expressionIndex++;
      } else {
        const range: FieldRange = {};
        let hasLower = false;
        let hasUpper = false;
        while (this.bounds[expressionIndex]?.field === field) {
          const current = this.bounds[expressionIndex]!;
          switch (current.type) {
            case "gt":
            case "gte":
              if (hasLower) throw new Error(`duplicate lower bound on ${field}`);
              hasLower = true;
              range.lower = current.value;
              range.lowerInclusive = current.type === "gte";
              break;
            case "lt":
            case "lte":
              if (hasUpper) throw new Error(`duplicate upper bound on ${field}`);
              hasUpper = true;
              range.upper = current.value;
              range.upperInclusive = current.type === "lte";
              break;
            case "eq":
              throw new Error(`equality bound follows range bound on ${field}`);
          }
          expressionIndex++;
        }
        out.push({ kind: "range", ...range });
        break;
      }
    }
    if (expressionIndex < this.bounds.length) {
      const expression = this.bounds[expressionIndex]!;
      throw new Error(`index range field ${expression.field} is not usable by ${this.indexName}`);
    }
    return out.length ? out : undefined;
  }

  private matchesBounds(doc: RawDoc): boolean {
    for (const matcher of this.matchers) {
      const expression = matcher.expression;
      const value =
        expression.field === "_id" || expression.field === "_creationTime"
          ? doc[expression.field]
          : readFieldPath(doc, matcher.segments);
      switch (expression.type) {
        case "eq":
          if (!equalsConvex(value, expression.value)) return false;
          break;
        case "gt":
          if (compareConvex(value, expression.value) <= 0) return false;
          break;
        case "gte":
          if (compareConvex(value, expression.value) < 0) return false;
          break;
        case "lt":
          if (compareConvex(value, expression.value) >= 0) return false;
          break;
        case "lte":
          if (compareConvex(value, expression.value) > 0) return false;
          break;
      }
    }
    return true;
  }

  private withPlan(plan: QueryPlan): QueryBuilder<DM, T> {
    return new QueryBuilder(this.store, this.def, this.overlay, this.tracker, {
      bounds: Object.hasOwn(plan, "bounds") ? plan.bounds : this.bounds,
      indexName: plan.indexName ?? this.indexName,
      initializer: plan.initializer ?? false,
      limit: Object.hasOwn(plan, "limit") ? plan.limit : this.limitCount,
      orderDir: plan.orderDir ?? this.orderDir,
      orderSet: plan.orderSet ?? this.orderSet,
      predicates: plan.predicates ?? this.predicates,
    });
  }

  private consumeForUse(): QueryBuilder<DM, T> {
    if (this.initializer) {
      return this.withPlan({ initializer: false });
    }
    if (this.consumed) {
      throw new Error(
        "A query can only be chained once and can't be chained after iteration begins.",
      );
    }
    this.consumed = true;
    return this;
  }
}

function validateNonNegativeInteger(value: number, method: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${method}: n must be a non-negative integer`);
  }
}

function validatePositiveInteger(value: number, method: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${method}: n must be a positive integer`);
  }
}

/** Whether SQL represents these bounds exactly (no `null`-valued endpoint to widen). */
function boundsAreExact(bounds: Bound[] | undefined): boolean {
  // Every value (including `null` and `undefined`) encodes to an exact order key, so an `eq`
  // bound and a real range endpoint are exact. The one inexact case for a count PUSHDOWN is a
  // range endpoint whose value is `undefined`: the storage `Bound` cannot distinguish "endpoint
  // is undefined" from "no endpoint" (both serialize as absent), so a pushdown would treat it as
  // unbounded and overcount. Such bounds count through the stream instead (the scan re-checks via
  // `matchesBounds`). The endpoint was set iff its inclusivity flag is present.
  return !bounds?.some(
    (bound) =>
      bound.kind === "range" &&
      ((bound.lower === undefined && bound.lowerInclusive !== undefined) ||
        (bound.upper === undefined && bound.upperInclusive !== undefined)),
  );
}

const END = Symbol("end-cursor");
const PAGE_CURSOR_PREFIX = "v1:";
const PAGE_CURSOR_END = "v1:end";

/**
 * Pagination cursors are versioned, opaque encodings of the last returned document's order-key
 * tuple — stable under interleaved writes, O(pageSize) to resume. `undefined` elements (missing
 * index fields) are recorded in a positional mask because Convex JSON cannot carry undefined.
 */
function encodePageCursor(key: KeyTuple, fields: readonly OrderField[]): string {
  const missing: number[] = [];
  const values = key.map((value, i) => {
    if (value === undefined) {
      missing.push(i);
      return null;
    }
    return convexToJson(value as Value);
  });
  return (
    PAGE_CURSOR_PREFIX +
    toBase64Url(JSON.stringify({ f: fields.map((field) => field.field), k: values, u: missing }))
  );
}

function decodePageCursor(cursor: string | null): KeyTuple | typeof END | undefined {
  if (cursor === null) return undefined;
  if (cursor === PAGE_CURSOR_END) return END;
  if (!cursor.startsWith(PAGE_CURSOR_PREFIX)) {
    throw new Error(`invalid pagination cursor: ${cursor}`);
  }
  let parsed: { f: string[]; k: JSONValue[]; u: number[] };
  try {
    parsed = JSON.parse(fromBase64Url(cursor.slice(PAGE_CURSOR_PREFIX.length))) as {
      f: string[];
      k: JSONValue[];
      u: number[];
    };
  } catch {
    throw new Error(`invalid pagination cursor: ${cursor}`);
  }
  if (
    !Array.isArray(parsed.f) ||
    !parsed.f.every((field) => typeof field === "string") ||
    !Array.isArray(parsed.k) ||
    parsed.f.length !== parsed.k.length ||
    !Array.isArray(parsed.u)
  ) {
    throw new Error(`invalid pagination cursor: ${cursor}`);
  }
  const missing = new Set(parsed.u);
  return parsed.k.map((value, i) => (missing.has(i) ? undefined : jsonToConvex(value)));
}

export function pageCursorBoundary(cursor: string):
  | {
      rowId: string;
      values: Array<{ field: string; value?: JSONValue; missing?: true }>;
    }
  | undefined {
  if (cursor === PAGE_CURSOR_END) return undefined;
  if (!cursor.startsWith(PAGE_CURSOR_PREFIX))
    throw new Error(`invalid pagination cursor: ${cursor}`);
  const parsed = JSON.parse(fromBase64Url(cursor.slice(PAGE_CURSOR_PREFIX.length))) as {
    f: string[];
    k: JSONValue[];
    u: number[];
  };
  decodePageCursor(cursor);
  const missing = new Set(parsed.u);
  const rowId = parsed.k.at(-1);
  if (typeof rowId !== "string" || missing.has(parsed.k.length - 1)) {
    throw new Error("pagination cursor has no document boundary");
  }
  return {
    rowId,
    values: parsed.f.map((field, index) =>
      missing.has(index) ? { field, missing: true } : { field, value: parsed.k[index] },
    ),
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * The version a scan observed: the max adoption seq across the read rows, from the page's `versions`
 * sidecar (contract §11 D1). Absent entries → 0, which the server treats as "unversioned" and
 * re-reads authoritatively. The sidecar keeps versions out of the compact app-row JSON.
 */
function readVersion(
  docs: readonly RawDoc[],
  versions: Record<string, number> | undefined,
): number {
  if (versions === undefined) return 0;
  let version = 0;
  for (const doc of docs) {
    const seq = versions[doc._id];
    if (typeof seq === "number" && seq > version) version = seq;
  }
  return version;
}

function docValue(doc: RawDoc, key: OrderField): unknown {
  if (key.field === "_id" || key.field === "_creationTime") return doc[key.field];
  return readFieldPath(doc, key.segments);
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
    field: (fieldPath: string) => {
      const segments = compileFieldPath(fieldPath);
      return expr((doc) => readFieldPath(doc, segments));
    },
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
  // `undefined` is a valid bound — `q.eq("field", undefined)` queries documents missing that
  // field (Convex orders a missing field as `undefined`). `null`, NaN, ±Infinity and -0 are
  // valid too. Composite values cannot be bound.
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new Error(`query bound value is not supported: ${describeValue(value)}`);
}

function describeValue(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "undefined") return "undefined";
  return JSON.stringify(value) ?? typeof value;
}
