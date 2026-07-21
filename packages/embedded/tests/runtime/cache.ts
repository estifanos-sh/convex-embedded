import { type DataModelFromSchemaDefinition, defineSchema, defineTable } from "convex/server";
import { convexToJson, v } from "convex/values";
import type { Value } from "convex/values";
import { compareValues } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type { EmbeddedEvent } from "../../src/events";
import { isEmbeddedError } from "../../src/error";
import type {
  CountSpec,
  DocPage,
  IdMapping,
  KeyPage,
  ReadSpec,
  RemoteScope,
  RemoteSurface,
  RemoteTick,
  ResultEntry,
  RuntimeStorage,
  StoredDoc,
  WriteBatch,
} from "../../src/storage/types";
import { defineFunctions } from "../../src/runtime/functions";
import { consumeRemoteTick } from "../../src/rev";
import { createReader, toSchema } from "../../src/runtime/database";
import type { ReadAuthority } from "../../src/runtime/cache";
import type { ReadTracker } from "../../src/runtime/query";
import { createRunner, type Runner } from "../../src/runtime/runner";
import { NativeStore } from "../../src/node/native";
import { toRuntimeStoreSchema } from "../../src/schema";
import { getTimerTime } from "../../src/time";
import { nativeModule } from "../testkit/native";
import { temporaryPath } from "../testkit/runtime";

const appSchema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
  }).index("by_channel", ["channel"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;
const storeSchema = toRuntimeStoreSchema(appSchema);
const { mutation, query } = defineFunctions<DataModel>().replicated;

const mutationProbe: { id?: string } = {};

const functions = {
  // Aggregates over the whole table: the `count()` is never covered by one watch's member set, so
  // the evaluation is foreign and the read path must cache-serve (§4.5).
  stats: query({
    args: { channel: v.string() },
    handler: async (ctx, { channel }) => {
      const latest = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", channel))
        .order("desc")
        .first();
      const total = await ctx.db.query("messages").count();
      return { latest, total };
    },
  }),
  agg: query({
    args: { channel: v.string() },
    handler: async (ctx, { channel }) => {
      return {
        total: await ctx.db
          .query("messages")
          .withIndex("by_channel", (q) => q.eq("channel", channel))
          .count(),
        label: "local",
      };
    },
  }),
  // A partial list omits `body`: complete-document matching encodes nothing, so the entry references
  // no rows and a body edit produces no list re-emit (§5 benchmark invariant).
  list: query({
    args: { channel: v.string() },
    handler: async (ctx, { channel }) => {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", channel))
        .collect();
      return rows.map((row) => ({ _id: row._id, channel: row.channel, title: row.title }));
    },
  }),
  byId: query({
    args: { id: v.string() },
    handler: async (ctx, { id }) => ctx.db.get("messages", id as never),
  }),
  // A typed `v.id` argument: the third disclosure seam. A hosted id in this slot must not throw at
  // argument validation — the runtime resolves it to its local twin, or admits it verbatim so the
  // handler runs foreign and the watch discloses the row.
  point: query({
    args: { id: v.id("messages") },
    handler: async (ctx, { id }) => ctx.db.get("messages", id),
  }),
  // Single-argument `db.get(id)`: the production point-query shape. An undisclosed hosted id has no
  // derivable table, so the read must resolve foreign+null instead of throwing `unknown table`.
  whole: query({
    args: { id: v.id("messages") },
    handler: async (ctx, { id }) => ctx.db.get(id),
  }),
  touch: mutation({
    args: { id: v.id("messages") },
    handler: async (_ctx, { id }) => {
      mutationProbe.id = id;
      return id;
    },
  }),
};

/**
 * A slim remote-capable runtime store for the retained-result read path: docs, id mappings, retained
 * bases, and the results table are directly seedable, and the published remote scope is captured so
 * a test can read the TS-authoritative `resultCacheKey` the runtime formed.
 */
class CacheStore implements RuntimeStorage {
  private time = 1;
  readonly docs = new Map<string, StoredDoc>();
  readonly bases = new Map<string, StoredDoc>();
  readonly ids = new Map<string, IdMapping>();
  readonly results = new Map<string, ResultEntry>();
  scope: RemoteScope | undefined;

  constructor(private readonly withRemote = true) {}

  seedDoc(doc: StoredDoc, hostedId: string): void {
    this.docs.set(doc._id, doc);
    this.ids.set(`messages\0${doc._id}`, {
      table: "messages",
      localId: doc._id,
      mapping: "mapped",
      convexId: hostedId,
      createdTime: 1,
      updatedTime: 1,
    });
  }

  dirtyDelete(localId: string, base: StoredDoc, hostedId: string): void {
    this.docs.delete(localId);
    this.bases.set(localId, base);
    this.ids.set(`messages\0${localId}`, {
      table: "messages",
      localId,
      mapping: "deleted",
      convexId: hostedId,
      createdTime: 1,
      updatedTime: 2,
    });
  }

  readonly capabilities = { hasExactBounds: false };

  readonly doc = {
    read: (_table: string, id: string): Promise<StoredDoc | undefined> =>
      Promise.resolve(this.docs.get(id)),
    version: {
      read: (_table: string, _id: string): Promise<number | undefined> => Promise.resolve(1),
    },
    crdt: {
      read: (): Promise<number | undefined> => Promise.resolve(undefined),
      snapshot: { read: () => Promise.resolve([]) },
    },
    page: {
      read: (spec: ReadSpec): Promise<DocPage> =>
        Promise.resolve({ cursor: null, docs: this.rows(spec) }),
    },
    count: {
      read: (_spec: CountSpec): Promise<number | null> => Promise.resolve(null),
    },
    base: {
      read: (_table: string, id: string): Promise<StoredDoc | undefined> =>
        Promise.resolve(this.bases.get(id)),
    },
  };

  readonly key = {
    page: {
      read: (spec: ReadSpec): Promise<KeyPage> => {
        const rows = this.rows(spec);
        return Promise.resolve({
          cursor: null,
          ids: rows.map((row) => row._id),
          creationTimes: rows.map((row) => row._creationTime),
        });
      },
    },
  };

  readonly clock = { read: (): number => this.time++ };

  readonly id = {
    write: (mapping: IdMapping): Promise<void> => {
      this.ids.set(`${mapping.table}\0${mapping.localId}`, { ...mapping });
      return Promise.resolve();
    },
    read: (table: string, localId: string): Promise<IdMapping | undefined> =>
      Promise.resolve(this.ids.get(`${table}\0${localId}`)),
    page: {
      read: (table: string): Promise<IdMapping[]> =>
        Promise.resolve([...this.ids.values()].filter((mapping) => mapping.table === table)),
    },
    delete: (table: string, localId: string): Promise<void> => {
      this.ids.delete(`${table}\0${localId}`);
      return Promise.resolve();
    },
  };

  readonly result = {
    read: (key: string): Promise<ResultEntry | undefined> => Promise.resolve(this.results.get(key)),
    write: (entry: ResultEntry): Promise<boolean> => {
      this.results.set(entry.key, entry);
      return Promise.resolve(true);
    },
    delete: (key: string): Promise<void> => {
      this.results.delete(key);
      return Promise.resolve();
    },
  };

  get remote(): RemoteSurface | undefined {
    if (!this.withRemote) return undefined;
    return {
      scope: {
        write: (scope: RemoteScope): Promise<void> => {
          this.scope = scope;
          return Promise.resolve();
        },
      },
    } as unknown as RemoteSurface;
  }

  commit(_batch: WriteBatch): Promise<never> {
    return Promise.reject(new Error("CacheStore does not commit; seed directly"));
  }

  private rows(spec: ReadSpec): StoredDoc[] {
    const index = spec.index
      ? storeSchema.tables
          .find((t) => t.name === spec.table)
          ?.indexes.find((i) => i.name === spec.index)
      : undefined;
    const fields = [...(index?.fields ?? [])];
    for (const field of ["_creationTime", "_id"]) if (!fields.includes(field)) fields.push(field);
    const dir = spec.order === "desc" ? -1 : 1;
    const at = (doc: StoredDoc, field: string): unknown =>
      field.split(".").reduce<unknown>((cur, seg) => (cur as Record<string, unknown>)?.[seg], doc);
    return [...this.docs.values()]
      .filter((doc) => doc._id.startsWith(`${spec.table}|`))
      .sort((a, b) => {
        for (const field of fields) {
          const c = compareValues(at(a, field) as Value, at(b, field) as Value);
          if (c !== 0) return dir * c;
        }
        return 0;
      });
  }
}

function encodeSkeleton(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(convexToJson(value as Value)));
}

function encodePaths(rows: Array<{ path: string; table: string; rowId: string }>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}

function makeEntry(
  key: string,
  skeleton: unknown,
  rows: Array<{ path: string; table: string; rowId: string }> = [],
): ResultEntry {
  return {
    key,
    function: "cache:test",
    args: "{}",
    schemaHash: "local",
    moduleHash: "local",
    skeleton: encodeSkeleton(skeleton),
    paths: encodePaths(rows),
    skeletonHash: "test",
    clock: 1,
  };
}

function localId(table: string, suffix: string): string {
  return `${table}|${suffix.padStart(32, "0")}`;
}

// A pull page carrying only a rewritten result skeleton (no member/projection row): the tick reports
// the membership-free change through `changedResults`, and nothing through `changedTables`.
function resultTick(changedResults: string[]): RemoteTick {
  return {
    changedResults,
    changedTables: [],
    pullAttempted: 1,
    pullDiagnostics: 0,
    pullChangesApplied: 0,
    pullSnapshots: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushRebases: 0,
    pushed: 0,
    pushFailed: 0,
    received: 0,
    reconnected: false,
    retainedRevisions: [],
    rowsApplied: 0,
    sent: 0,
    receiptsPushed: 0,
    storeJobs: 0,
  };
}

// Drive the REAL consumeRemoteTick path for a result-only pull — the production trigger, with no
// hand-rolled `r.invalidate`. This is the reactive proof the membership-free re-emit works.
function pullResultSkeleton(r: Runner, keys: string[]): void {
  consumeRemoteTick(resultTick(keys), r, () => undefined);
}

// A whole-doc point disclosure tick: the encoded root skeleton ships alongside its member row, so the
// pull reports the applied member (changedTables) and the rewritten entry (changedResults) together.
function memberTick(changedTables: string[], changedResults: string[]): RemoteTick {
  return { ...resultTick(changedResults), changedTables, rowsApplied: changedTables.length };
}
function pullDisclosure(r: Runner, changedTables: string[], changedResults: string[]): void {
  consumeRemoteTick(memberTick(changedTables, changedResults), r, () => undefined);
}

async function nextUpdate<T>(updates: T[], seen: number): Promise<T> {
  const started = getTimerTime();
  while (updates.length <= seen) {
    if (getTimerTime() - started > 1_000)
      throw new Error(`timed out waiting for update ${seen + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return updates[seen] as T;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = getTimerTime();
  while (!check()) {
    if (getTimerTime() - started > 1_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runner(store: CacheStore, events?: EmbeddedEvent[]): Runner {
  return createRunner({ cache: functions }, store, storeSchema, {
    remote: true,
    ...(events ? { emit: (event) => events.push(event) } : {}),
  });
}

describe("retained-result cache read path", () => {
  test("no-drift: the published scope key is the key the read path cache-serves", async () => {
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:agg", { channel: "live" }, (value) => updates.push(value));

    // First eval is foreign (count) with no entry -> local compute, and publishes the scope.
    await nextUpdate(updates, 0);
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;
    expect(typeof key).toBe("string");

    // Simulate the S3 pull apply: write the entry under the SAME published key, then drive the real
    // result-only tick — the membership-free change re-emits with no manual invalidate.
    await store.result.write(makeEntry(key, { total: 42, label: "server" }));
    pullResultSkeleton(r, [key]);

    const served = await nextUpdate(updates, 1);
    expect(served).toEqual({ total: 42, label: "server" });
    off();
  });

  test("a membership-free result change re-emits the new value through the real tick path", async () => {
    // The class the cache exists for: an aggregate/scalar whose value changes server-side with NO
    // change to any member/projection row this device holds. The stale-serve bug served the old
    // reconstruction forever; the fix reruns the foreign watch purely from `changedResults`.
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:agg", { channel: "live" }, (value) => updates.push(value));

    // Foreign first eval, no entry: local compute over the empty table (total 0).
    expect(await nextUpdate(updates, 0)).toEqual({ total: 0, label: "local" });
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;

    // A pull writes a result skeleton (empty members). The reactive path re-emits — no r.invalidate.
    await store.result.write(makeEntry(key, { total: 42, label: "server" }));
    pullResultSkeleton(r, [key]);
    expect(await nextUpdate(updates, 1)).toEqual({ total: 42, label: "server" });

    // The result changes AGAIN with no member/projection row touched: still re-emits by key alone.
    await store.result.write(makeEntry(key, { total: 99, label: "server" }));
    pullResultSkeleton(r, [key]);
    expect(await nextUpdate(updates, 2)).toEqual({ total: 99, label: "server" });
    off();
  });

  test("transformed result splices the current local projection of a referenced row", async () => {
    const store = new CacheStore();
    const id = localId("messages", "a");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "clean" } as StoredDoc,
      "hostedA",
    );
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:stats", { channel: "live" }, (value) => updates.push(value));
    await nextUpdate(updates, 0);
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;

    await store.result.write(
      makeEntry(key, { latest: null, total: 7 }, [
        { path: "/latest", table: "messages", rowId: "hostedA" },
      ]),
    );
    pullResultSkeleton(r, [key]);
    const served = (await nextUpdate(updates, 1)) as { latest: StoredDoc; total: number };
    expect(served.total).toBe(7);
    expect(served.latest.title).toBe("clean");

    // A local dirty edit to the referenced row's title is spliced (§4.3 optimistic).
    store.docs.set(id, {
      _id: id,
      _creationTime: 1,
      channel: "live",
      title: "edited",
    } as StoredDoc);
    r.invalidate(["messages"], "local");
    const edited = (await nextUpdate(updates, 2)) as { latest: StoredDoc; total: number };
    expect(edited.latest.title).toBe("edited");
    expect(edited.total).toBe(7);
    off();
  });

  test("a dirty-deleted referenced row reconstructs from its last accepted base", async () => {
    const store = new CacheStore();
    const id = localId("messages", "b");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "before" } as StoredDoc,
      "hostedB",
    );
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:stats", { channel: "live" }, (value) => updates.push(value));
    await nextUpdate(updates, 0);
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;
    await store.result.write(
      makeEntry(key, { latest: null, total: 3 }, [
        { path: "/latest", table: "messages", rowId: "hostedB" },
      ]),
    );

    // Locally dirty-delete the row: doc.read misses, but its retained base still reconstructs.
    store.dirtyDelete(
      id,
      { _id: id, _creationTime: 1, channel: "live", title: "before" } as StoredDoc,
      "hostedB",
    );
    pullResultSkeleton(r, [key]);
    const served = (await nextUpdate(updates, 1)) as { latest: StoredDoc; total: number };
    expect(served.latest.title).toBe("before");
    expect(served.total).toBe(3);
    off();
  });

  test("cache-serve emits an internal data event with source 'cache'", async () => {
    const store = new CacheStore();
    const events: EmbeddedEvent[] = [];
    const r = runner(store, events);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:agg", { channel: "live" }, (value) => updates.push(value));
    await nextUpdate(updates, 0);
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;
    await store.result.write(makeEntry(key, { total: 9, label: "server" }));
    pullResultSkeleton(r, [key]);
    await nextUpdate(updates, 1);
    expect(events.some((e) => e.type === "data" && e.source === "cache")).toBe(true);
    off();
  });

  test("partial list + body edit produces zero list re-emits", async () => {
    const store = new CacheStore();
    const id = localId("messages", "c");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "t", body: "one" } as StoredDoc,
      "hostedC",
    );
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:list", { channel: "live" }, (value) => updates.push(value));
    // Wait for the list to settle (foreign-first-eval then a covered rerun may both fire).
    await nextUpdate(updates, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const before = updates.length;

    // Editing only `body` — a field the partial list omits — must not re-emit the list.
    store.docs.set(id, {
      _id: id,
      _creationTime: 1,
      channel: "live",
      title: "t",
      body: "two",
    } as StoredDoc);
    r.invalidate(["messages"], "local");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(updates.length).toBe(before);
    off();
  });

  test("the native result binding round-trips an Int64/Bytes skeleton (S3 FFI)", async () => {
    const store = await NativeStore.openWith(
      nativeModule().Store,
      temporaryPath("rt_cache_native"),
    );
    await store.setup(storeSchema);
    const skeleton = { count: 9_007_199_254_740_993n, digest: new Uint8Array([7, 8, 9]).buffer };
    const rows = [{ path: "/latest", table: "messages", rowId: "hostedX" }];
    const entry: ResultEntry = {
      key: "native-key",
      function: "cache:agg",
      args: '{"channel":"live"}',
      schemaHash: "local",
      moduleHash: "local",
      skeleton: new TextEncoder().encode(JSON.stringify(convexToJson(skeleton as Value))),
      paths: new TextEncoder().encode(JSON.stringify(rows)),
      skeletonHash: "hash-1",
      clock: 3,
    };
    expect(await store.result!.write(entry)).toBe(true);
    // Same skeletonhash -> zero-write fast path.
    expect(await store.result!.write(entry)).toBe(false);
    const read = await store.result!.read("native-key");
    expect(read).toBeDefined();
    expect(new TextDecoder().decode(read!.skeleton)).toBe(new TextDecoder().decode(entry.skeleton));
    expect(new TextDecoder().decode(read!.paths)).toBe(new TextDecoder().decode(entry.paths));
    expect(read!.clock).toBe(3);
    await store.result!.delete("native-key");
    expect(await store.result!.read("native-key")).toBeUndefined();
    await store.close();
  });

  test("a local-only runtime never marks a query foreign", async () => {
    const store = new CacheStore(false);
    const r = runner(store);
    const updates: unknown[] = [];
    // A local-only agg entry would be ignored; the value is the LOCAL compute (empty table => 0).
    await store.result.write(makeEntry("unused", { total: 999, label: "server" }));
    const off = r.onUpdate("cache:agg", { channel: "live" }, (value) => updates.push(value));
    const value = (await nextUpdate(updates, 0)) as { total: number; label: string };
    expect(value).toEqual({ total: 0, label: "local" });
    const snapshot = (await r.devtools({ kind: "snapshot" })) as {
      runtime: { foreignEvaluations?: number; cacheServes?: number };
    };
    expect(snapshot.runtime.foreignEvaluations).toBe(0);
    expect(snapshot.runtime.cacheServes).toBe(0);
    off();
  });

  test("a get watch on an unmapped hosted id publishes it verbatim, then reruns on disclosure", async () => {
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:byId", { id: "hostedZ" }, (value) => updates.push(value));

    expect(await nextUpdate(updates, 0)).toBeNull();
    await waitFor(() => store.scope !== undefined, "scope not published");
    const subscription = store.scope!.subscriptions[0]!;
    expect((subscription.args as { id: string }).id).toBe("hostedZ");

    const id = localId("messages", "z");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "disclosed" } as StoredDoc,
      "hostedZ",
    );
    r.invalidate(["messages"], "remote");
    const served = (await nextUpdate(updates, 1)) as StoredDoc;
    expect(served._id).toBe(id);
    expect(served.title).toBe("disclosed");
    off();
  });

  test("real tick: whole-doc point disclosure reruns a get watch on an unmapped hosted id", async () => {
    // The Cut 7 benchmark flow: an observer subscribes documents:get{hostedId} for a row it does not
    // hold. The server encodes the complete-document result as a root skeleton (`null`) and ships the
    // row as a member. The pull reports the applied member (changedTables) AND the rewritten entry
    // (changedResults). No manual invalidate — this is the production trigger the earlier tests faked.
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:byId", { id: "hostedW" }, (value) => updates.push(value));

    expect(await nextUpdate(updates, 0)).toBeNull();
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;

    const id = localId("messages", "w");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "t", body: "seed" } as StoredDoc,
      "hostedW",
    );
    await store.result.write(
      makeEntry(key, null, [{ path: "", table: "messages", rowId: "hostedW" }]),
    );
    pullDisclosure(r, ["messages"], [key]);

    const served = (await nextUpdate(updates, 1)) as StoredDoc;
    expect(served._id).toBe(id);
    expect((served as unknown as { body: string }).body).toBe("seed");
    off();
  });

  test("real tick: point disclosure that ships no member (result channel only) still resolves the row", async () => {
    // The adversarial variant: if the server's root-match pruning ever shipped the row ONLY through
    // the result channel (no member, changedTables empty), the watch must still resolve — the row and
    // its mapping are present locally and the reconstruction splices at the root pointer.
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:byId", { id: "hostedV" }, (value) => updates.push(value));

    expect(await nextUpdate(updates, 0)).toBeNull();
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;

    const id = localId("messages", "v");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "t", body: "seed" } as StoredDoc,
      "hostedV",
    );
    await store.result.write(
      makeEntry(key, null, [{ path: "", table: "messages", rowId: "hostedV" }]),
    );
    pullDisclosure(r, [], [key]);

    const served = (await nextUpdate(updates, 1)) as StoredDoc;
    expect(served._id).toBe(id);
    expect((served as unknown as { body: string }).body).toBe("seed");
    off();
  });

  test("db.get resolves a mapped hosted id to its local row; unmapped stays foreign+null", async () => {
    const schema = toSchema(storeSchema);
    const probe = (): { authority: ReadAuthority; points: string[]; tracker: ReadTracker } => {
      const points: string[] = [];
      const authority: ReadAuthority = {
        foreign: false,
        readPoint(present) {
          if (!present) authority.foreign = true;
        },
        readRange() {},
        readCount() {},
        readSearch() {},
      };
      return {
        authority,
        points,
        tracker: { table() {}, point: (base) => points.push(base.id), authority },
      };
    };

    const mapped = new CacheStore();
    const id = localId("messages", "m");
    mapped.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "hit" } as StoredDoc,
      "hostedM",
    );
    const hit = probe();
    const doc = (await createReader<DataModel>(mapped, schema, hit.tracker).get(
      "messages",
      "hostedM" as never,
    )) as StoredDoc | null;
    expect(doc?._id).toBe(id);
    expect(doc?.title).toBe("hit");
    expect(hit.authority.foreign).toBe(false);
    expect(hit.points).toEqual([id]);

    const miss = probe();
    const absent = await createReader<DataModel>(mapped, schema, miss.tracker).get(
      "messages",
      "hostedUnknown" as never,
    );
    expect(absent).toBeNull();
    expect(miss.authority.foreign).toBe(true);
    expect(miss.points).toEqual([]);
  });
});

describe("hosted ids in typed v.id arguments", () => {
  const message = (id: string, title: string): StoredDoc =>
    ({ _id: id, _creationTime: 1, channel: "live", title }) as StoredDoc;

  test("a single-argument db.get on an undisclosed hosted id runs foreign+null, then serves on disclosure", async () => {
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const errors: unknown[] = [];
    const off = r.onUpdate(
      "cache:whole",
      { id: "hostedS" },
      (value) => updates.push(value),
      (error) => errors.push(error),
    );

    expect(await nextUpdate(updates, 0)).toBeNull();
    expect(errors).toEqual([]);
    await waitFor(() => store.scope !== undefined, "scope not published");
    const key = store.scope!.subscriptions[0]!.resultCacheKey;

    const id = localId("messages", "s");
    store.seedDoc(
      { _id: id, _creationTime: 1, channel: "live", title: "t", body: "seed" } as StoredDoc,
      "hostedS",
    );
    await store.result.write(
      makeEntry(key, null, [{ path: "", table: "messages", rowId: "hostedS" }]),
    );
    pullDisclosure(r, ["messages"], [key]);

    const served = (await nextUpdate(updates, 1)) as StoredDoc;
    expect(served._id).toBe(id);
    expect(errors).toEqual([]);
    off();
  });

  test("route admits an undisclosed hosted id at a typed v.id query position", async () => {
    // The Cut 7 seed gate: the client consults route() before wiring the watch, so the route probe
    // must share resolveQueryArgs' hosted-id admission or the point subscription dies at validation.
    const store = new CacheStore();
    const r = runner(store);
    await expect(r.route("cache:point", { id: "hostedR" }, "query")).resolves.toEqual({
      execution: "local",
      placement: "replicated",
    });
  });

  test("a local-only runtime still rejects a hosted id at route validation", async () => {
    const store = new CacheStore(false);
    const r = runner(store);
    await expect(r.route("cache:point", { id: "hostedR" }, "query")).rejects.toThrow(
      /must be an id for table/,
    );
  });

  test("an unmapped hosted id runs foreign without throwing, then substitutes on disclosure", async () => {
    const store = new CacheStore();
    const r = runner(store);
    const updates: unknown[] = [];
    const errors: unknown[] = [];
    const off = r.onUpdate(
      "cache:point",
      { id: "hostedP" },
      (value) => updates.push(value),
      (error) => errors.push(error),
    );

    // No throw at validation: the handler ran and db.get returned foreign+null.
    expect(await nextUpdate(updates, 0)).toBeNull();
    expect(errors).toEqual([]);
    await waitFor(() => store.scope !== undefined, "scope not published");
    expect((store.scope!.subscriptions[0]!.args as { id: string }).id).toBe("hostedP");

    const id = localId("messages", "fa");
    store.seedDoc(message(id, "disclosed"), "hostedP");
    r.invalidate(["messages"], "remote");
    const served = (await nextUpdate(updates, 1)) as StoredDoc;
    expect(served._id).toBe(id);
    expect(served.title).toBe("disclosed");
    off();
  });

  test("a mapped hosted id is substituted immediately and reads the local row", async () => {
    const store = new CacheStore();
    const id = localId("messages", "b");
    store.seedDoc(message(id, "mapped"), "hostedB");
    const r = runner(store);
    const updates: unknown[] = [];
    const off = r.onUpdate("cache:point", { id: "hostedB" }, (value) => updates.push(value));
    const served = (await nextUpdate(updates, 0)) as StoredDoc;
    expect(served._id).toBe(id);
    expect(served.title).toBe("mapped");
    off();
  });

  test("the watch keys identically whether the app passes the local id or its hosted twin", async () => {
    const subscribe = async (
      appArgs: Record<string, unknown>,
    ): Promise<{ key: string; args: unknown }> => {
      const store = new CacheStore();
      const id = localId("messages", "c");
      store.seedDoc(message(id, "twin"), "hostedC");
      const r = runner(store);
      const off = r.onUpdate("cache:point", appArgs, () => {});
      await waitFor(() => store.scope !== undefined, "scope not published");
      const subscription = store.scope!.subscriptions[0]!;
      off();
      return { key: subscription.resultCacheKey, args: subscription.args };
    };

    const hosted = await subscribe({ id: "hostedC" });
    const local = await subscribe({ id: localId("messages", "c") });
    // hostedPullArgs maps local->hosted, so both canonicalize to the hosted form and key identically.
    expect((hosted.args as { id: string }).id).toBe("hostedC");
    expect(local.args).toEqual(hosted.args);
    expect(local.key).toBe(hosted.key);
  });

  test("a mutation rejects an unmapped hosted id at admission and never runs the handler", async () => {
    const store = new CacheStore();
    const r = runner(store);
    mutationProbe.id = undefined;
    let caught: unknown;
    await r.runMutation("cache:touch", { id: "hostedX" }).catch((error) => (caught = error));
    expect(isEmbeddedError(caught, "EMBEDDED_UNSUPPORTED")).toBe(true);
    expect(String((caught as Error).message)).toMatch(/not disclosed locally/);
    expect(mutationProbe.id).toBeUndefined();
  });

  test("a mutation substitutes a mapped hosted id before the handler runs", async () => {
    const store = new CacheStore();
    const id = localId("messages", "d");
    store.seedDoc(message(id, "mapped"), "hostedD");
    const r = runner(store);
    mutationProbe.id = undefined;
    // The seed-only CacheStore rejects the commit; the handler runs (and records the id it saw)
    // first, which is all this asserts: admission substituted the mapped local id.
    await r.runMutation("cache:touch", { id: "hostedD" }).catch(() => undefined);
    expect(mutationProbe.id).toBe(id);
  });

  test("a local id for the wrong table still fails validation", async () => {
    const store = new CacheStore();
    const r = runner(store);
    const errors: unknown[] = [];
    const off = r.onUpdate(
      "cache:point",
      { id: localId("other", "e") },
      () => {},
      (error) => errors.push(error),
    );
    await waitFor(() => errors.length > 0, "expected a wrong-table validation error");
    expect(String((errors[0] as Error).message)).toMatch(/must be an id for table messages/);
    off();
  });
});
