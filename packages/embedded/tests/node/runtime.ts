import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
} from "convex/server";
import { compareValues, ConvexError, v } from "convex/values";
import type { Value } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type {
  CommitOptions,
  CountSpec,
  KeyPage,
  MutationCall,
  MutationRecord,
  RuntimeStorage,
  DocPage,
  ScanSpec,
  StoreSchema,
  StoredDoc,
  WriteBatch,
} from "../../src/storage/types";
import { decodeError, encode, encodeError } from "../../src/runtime/codec";
import { defineFunctions } from "../../src/runtime/functions";
import { createRunner, type Runner } from "../../src/runtime/runner";
import { toStoreSchema } from "../../src/schema";
import { NativeStore } from "../../src/node/native";
import { nativeModule } from "./native";

const appSchema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
    meta: v.optional(v.any()),
    bytes: v.optional(v.bytes()),
  }).index("by_channel", ["channel"]),
  tags: defineTable({
    category: v.optional(v.union(v.string(), v.null())),
    name: v.string(),
  }).index("by_category", ["category"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;

const { query, mutation } = defineFunctions<DataModel>();
let flakyFails = false;
let flakyStarted: (() => void) | undefined;

const messages = {
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", { channel: args.channel, body: args.body }),
  }),
  list: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect(),
  }),
  get: query({
    args: { id: v.id("messages") },
    handler: (ctx, args) => ctx.db.get(args.id),
  }),
  readYourWrites: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const id = await ctx.db.insert("messages", { channel: args.channel, body: "x" });
      const back = await ctx.db.get(id);
      return back?._id === id;
    },
  }),
  modernDbSurface: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const id = await ctx.db.insert("messages", { channel: args.channel, body: "old" });
      const normalized = ctx.db.normalizeId("messages", id);
      const byTable = await ctx.db.get("messages", id);
      await ctx.db.patch("messages", id, { body: "patched" });
      await ctx.db.replace("messages", id, { channel: args.channel, body: "replaced" });
      const viaTable = await ctx.db.table("messages").get(id);
      const tableId = await ctx.db.table("messages").insert({
        channel: args.channel,
        body: "table",
      });
      await ctx.db.table("messages").patch(tableId, { body: "table-patched" });
      const tablePatched = await ctx.db.table("messages").get(tableId);
      await ctx.db.table("messages").replace(tableId, {
        channel: args.channel,
        body: "table-replaced",
      });
      const tableReplaced = await ctx.db.table("messages").get(tableId);
      await ctx.db.table("messages").delete(tableId);
      await ctx.db.delete("messages", id);
      return {
        byTable: byTable?.body,
        normalized,
        removed: (await ctx.db.get("messages", id)) === null,
        tablePatched: tablePatched?.body,
        tableRemoved: (await ctx.db.get("messages", tableId)) === null,
        tableReplaced: tableReplaced?.body,
        viaTable: viaTable?.body,
      };
    },
  }),
  wrongTableGet: mutation({
    args: { id: v.id("messages") },
    handler: (ctx, args) => ctx.db.get("tags", args.id as never),
  }),
  invalidInsert: mutation({
    args: {},
    handler: (ctx) => ctx.db.insert("messages", { channel: "missing-body" } as never),
  }),
  localAuthIdentity: query({
    args: {},
    handler: (ctx) => ctx.auth.getUserIdentity(),
  }),
  queryConsumers: query({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const base = ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel));
      const count = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .count();
      const iterated: string[] = [];
      for await (const message of base.limit(2)) {
        iterated.push(message.body);
      }
      const page = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .paginate({ cursor: null, numItems: 2 });
      return {
        count,
        iterated,
        page: page.page.map((message) => message.body),
        isDone: page.isDone,
      };
    },
  }),
  paginateZero: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .paginate({ cursor: null, numItems: 0 }),
  }),
  invalidTake: query({
    args: {},
    handler: (ctx) => ctx.db.query("messages").take(-1),
  }),
  withBody: query({
    args: { body: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("body"), args.body))
        .collect(),
  }),
  withMeta: query({
    args: { meta: v.any() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("meta" as never), args.meta))
        .collect(),
  }),
  withBytes: query({
    args: { bytes: v.bytes() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("bytes" as never), args.bytes as never))
        .collect(),
  }),
  bodyAfterA: query({
    args: { body: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .filter((q) => q.and(q.eq(q.field("body"), args.body), q.gt(q.field("_creationTime"), 0)))
        .collect(),
  }),
  reusesQueryInitializer: query({
    args: {},
    handler: async (ctx) => {
      const base = ctx.db.query("messages");
      const first = await base.filter((q) => q.eq(q.field("channel"), "a")).collect();
      const second = await base.filter((q) => q.eq(q.field("channel"), "b")).collect();
      return [first.map((m) => m.body), second.map((m) => m.body)];
    },
  }),
  rejectsConsumedQueryReuse: query({
    args: {},
    handler: async (ctx) => {
      const q = ctx.db.query("messages").filter((f) => f.eq(f.field("channel"), "a"));
      await q.collect();
      return q.collect();
    },
  }),
  rejectsUnreturnedIndexRangeBuilder: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", ((q: never) => {
          (q as { eq(field: string, value: string): unknown }).eq("channel", "a");
          return q;
        }) as never)
        .collect(),
  }),
  rejectsDuplicateOrder: query({
    args: {},
    handler: (ctx) =>
      (
        ctx.db.query("messages").order("asc") as unknown as {
          order(dir: "asc" | "desc"): { collect(): Promise<unknown[]> };
        }
      )
        .order("desc")
        .collect(),
  }),
  rename: mutation({
    args: { id: v.id("messages"), body: v.string() },
    handler: async (ctx, args) => {
      await ctx.db.patch(args.id, { body: args.body });
    },
  }),
  remove: mutation({
    args: { id: v.id("messages") },
    handler: async (ctx, args) => {
      await ctx.db.delete(args.id);
    },
  }),
  insertThenQuery: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      await ctx.db.insert("messages", { channel: args.channel, body: "a" });
      await ctx.db.insert("messages", { channel: args.channel, body: "b" });
      const seen = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect();
      return seen.map((m) => m.body);
    },
  }),
  insertRich: mutation({
    args: { bytes: v.bytes() },
    handler: async (ctx, args) => {
      await ctx.db.insert("messages", {
        channel: "rich",
        body: "rich",
        meta: { nested: ["a", 1, null] },
        bytes: args.bytes,
      } as never);
    },
  }),
  countExistingViaRunQuery: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const seen = (await ctx.runQuery("messages:list", { channel: args.channel })) as unknown[];
      return seen.length;
    },
  }),
  anyEcho: query({
    args: { payload: v.any() },
    handler: (_ctx, args) => args.payload,
  }),
  mutateArgsThenRunQuery: mutation({
    args: { payload: v.any() },
    handler: (ctx, args) => {
      (args.payload as Record<string, unknown>).tooBig = 1n << 80n;
      return ctx.runQuery("messages:anyEcho", args);
    },
  }),
  insertThenRunQuery: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      await ctx.db.insert("messages", { channel: args.channel, body: "staged" });
      const seen = (await ctx.runQuery("messages:list", { channel: args.channel })) as Array<{
        body: string;
      }>;
      return seen.map((message) => message.body);
    },
  }),
  childInsert: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", args),
  }),
  parentCallsChildThenFails: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      await ctx.runMutation("messages:childInsert", { channel: args.channel, body: "child" });
      throw new Error("parent failed");
    },
  }),
  parentCallsChildThenReads: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      await ctx.runMutation("messages:childInsert", { channel: args.channel, body: "child" });
      const seen = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect();
      return seen.map((message) => message.body);
    },
  }),
  echoChannelSlow: mutation({
    args: { channel: v.string() },
    handler: async (_ctx, args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return args.channel;
    },
  }),
  deleteThenQuery: mutation({
    args: { id: v.id("messages"), channel: v.string() },
    handler: async (ctx, args) => {
      await ctx.db.delete(args.id);
      const seen = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect();
      return seen.length;
    },
  }),
  insertWithSystemField: mutation({
    args: {},
    handler: (ctx) =>
      ctx.db.insert("messages", { _id: "messages|x", channel: "c", body: "b" } as never),
  }),
  patchConflictingCreationTime: mutation({
    args: { id: v.id("messages") },
    handler: (ctx, args) => ctx.db.patch(args.id, { _creationTime: 1 } as never),
  }),
  replaceMatchingSystemFields: mutation({
    args: { id: v.id("messages") },
    handler: async (ctx, args) => {
      const current = await ctx.db.get(args.id);
      await ctx.db.replace(args.id, {
        _creationTime: current?._creationTime,
        _id: current?._id,
        channel: "c",
        body: "round-tripped",
      } as never);
      return (await ctx.db.get(args.id))?.body;
    },
  }),
  deleteMissing: mutation({
    args: { id: v.id("messages") },
    handler: (ctx, args) => ctx.db.delete(args.id),
  }),
  deleteTwice: mutation({
    args: { id: v.id("messages") },
    handler: async (ctx, args) => {
      await ctx.db.delete(args.id);
      await ctx.db.delete(args.id);
    },
  }),
  echoLabels: query({
    args: { labels: v.record(v.union(v.literal("a"), v.literal("b")), v.string()) },
    handler: (_ctx, args) => args.labels,
  }),
  patchOutThenQuery: mutation({
    args: { id: v.id("messages") },
    handler: async (ctx, args) => {
      await ctx.db.patch(args.id, { channel: "d" });
      const stillC = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", "c"))
        .take(1);
      return stillC.length;
    },
  }),
  takeOverStaged: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("messages", { channel: "c", body: "1" });
      await ctx.db.insert("messages", { channel: "c", body: "2" });
      await ctx.db.insert("messages", { channel: "c", body: "3" });
      const top2 = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", "c"))
        .take(2);
      return top2.map((m) => m.body);
    },
  }),
  zeroLimitConsumers: query({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const base = ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel));
      const taken = await base.take(0);
      const limited: string[] = [];
      for await (const message of ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .limit(0)) {
        limited.push(message.body);
      }
      return { limited, taken };
    },
  }),
  firstOverStaged: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("messages", { channel: "z", body: "only" });
      const m = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", "z"))
        .first();
      return m?.body ?? null;
    },
  }),
  incrementSlow: mutation({
    args: { id: v.id("messages") },
    handler: async (ctx, args) => {
      const current = await ctx.db.get(args.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await ctx.db.patch(args.id, { body: String(Number(current?.body ?? "0") + 1) });
    },
  }),
  fail: query({
    args: {},
    handler: () => {
      throw new Error("query failed");
    },
  }),
  insertUncategorizedThenQuery: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("tags", { name: "untagged" });
      const seen = await ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.eq("category", undefined as never))
        .collect();
      return seen.map((tag) => tag.name);
    },
  }),
  insertNullCategoryThenQuery: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("tags", { name: "nulled", category: null as never });
      const seen = await ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.eq("category", null as never))
        .collect();
      return seen.map((tag) => tag.name);
    },
  }),
  missingTags: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.eq("category", undefined as never))
        .collect(),
  }),
  nullTags: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.eq("category", null as never))
        .collect(),
  }),
  firstNullTag: query({
    args: {},
    handler: async (ctx) => {
      const tag = await ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.eq("category", null as never))
        .first();
      return tag?.name ?? null;
    },
  }),
  seedCategoryCount: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("tags", { name: "missing" });
      await ctx.db.insert("tags", { name: "nulled", category: null as never });
      await ctx.db.insert("tags", { name: "string", category: "a" });
    },
  }),
  categoryAfterUndefinedCount: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("tags")
        .withIndex("by_category", (q) => q.gt("category", undefined as never))
        .count(),
  }),
  badReturn: query({
    args: {},
    returns: v.string(),
    handler: () => 1 as never,
  }),
  badMutationReturn: mutation({
    args: {},
    returns: v.string(),
    handler: async (ctx) => {
      await ctx.db.insert("tags", { name: "should-not-persist" });
      return 1 as never;
    },
  }),
  flakyList: query({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      flakyStarted?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (flakyFails) {
        flakyFails = false;
        throw new Error("flaky query failed");
      }
      return ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect();
    },
  }),
};

const storeSchema: StoreSchema = toStoreSchema(appSchema);

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

async function runner(name: string): Promise<Runner> {
  const store = await NativeStore.openWith(nativeModule().Store, tmp(name));
  await store.setup(storeSchema);
  return createRunner({ messages }, store, storeSchema);
}

async function nextUpdate<T>(updates: T[], seen: number): Promise<T> {
  const started = Date.now();
  while (updates.length <= seen) {
    if (Date.now() - started > 1_000) {
      throw new Error(`timed out waiting for update ${seen + 1}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return updates[seen] as T;
}

class FakeStorage implements RuntimeStorage {
  private now = 1;
  private seq = 0;
  private readonly docs = new Map<string, StoredDoc>();
  private readonly mutations = new Map<string, MutationRecord & { args: string; name: string }>();

  // A deliberately broad single-page backend: bounds are ignored (the runtime re-checks every
  // doc), everything comes back in one page, and exact count pushdown is unsupported so the
  // runtime counts through the document stream. Rows ARE returned in exact Convex order by the
  // index fields (then _creationTime, _id), mirroring the real order-key backend.
  readonly doc = {
    read: (_table: string, id: string): Promise<StoredDoc | undefined> =>
      Promise.resolve(this.docs.get(id)),
    scan: (spec: ScanSpec): Promise<DocPage> =>
      Promise.resolve({ cursor: null, docs: this.rows(spec) }),
    count: (_spec: CountSpec): Promise<number | null> => Promise.resolve(null),
  };

  readonly key = {
    scan: (spec: ScanSpec): Promise<KeyPage> => {
      const rows = this.rows(spec);
      return Promise.resolve({
        cursor: null,
        ids: rows.map((doc) => doc._id),
        creationTimes: rows.map((doc) => doc._creationTime),
      });
    },
  };

  readonly clock = {
    next: (): number => this.now++,
  };

  readonly mutation = {
    begin: (call: MutationCall): Promise<MutationRecord> => {
      const existing = this.mutations.get(call.mutationId);
      if (existing) {
        if (existing.args !== call.args || existing.name !== call.name) {
          throw new Error(`mutation id reused with different call: ${call.mutationId}`);
        }
        return Promise.resolve(existing);
      }
      const record: MutationRecord & { args: string; name: string } = {
        args: call.args,
        mutationId: call.mutationId,
        name: call.name,
        status: "accepted",
      };
      this.mutations.set(call.mutationId, record);
      return Promise.resolve(record);
    },
    fail: (mutationId: string, error: string): Promise<void> => {
      const record = this.mutations.get(mutationId);
      if (record) {
        record.error = error;
        record.status = "failed";
      }
      return Promise.resolve();
    },
  };

  precommitMutation(call: MutationCall): void {
    this.mutations.set(call.mutationId, {
      args: call.args,
      mutationId: call.mutationId,
      name: call.name,
      status: "committed",
    });
  }

  private rows(spec: ScanSpec): StoredDoc[] {
    const index = spec.index
      ? storeSchema.tables
          .find((t) => t.name === spec.table)
          ?.indexes.find((i) => i.name === spec.index)
      : undefined;
    const fields = [...(index?.fields ?? [])];
    for (const f of ["_creationTime", "_id"]) if (!fields.includes(f)) fields.push(f);
    const dir = spec.order === "desc" ? -1 : 1;
    const read = (doc: StoredDoc, field: string): unknown =>
      field.split(".").reduce<unknown>((cur, seg) => (cur as Record<string, unknown>)?.[seg], doc);
    return [...this.docs.values()]
      .filter((doc) => doc._id.startsWith(`${spec.table}|`))
      .sort((a, b) => {
        for (const field of fields) {
          const c = compareValues(read(a, field) as Value, read(b, field) as Value);
          if (c !== 0) return dir * c;
        }
        return 0;
      });
  }

  commit(batch: WriteBatch, options?: CommitOptions) {
    for (const upsert of batch.upserts) {
      this.docs.set(upsert.id, {
        ...upsert.data,
        _id: upsert.id,
        _creationTime: upsert.creationTime,
      });
    }
    for (const del of batch.deletes) this.docs.delete(del.id);
    this.seq += 1;
    if (options?.mutationId) {
      const record = this.mutations.get(options.mutationId);
      if (record) {
        record.commitSeq = this.seq;
        record.result = options.mutationResult;
        record.status = "committed";
      }
    }
    return Promise.resolve({
      changedTables: [...new Set([...batch.upserts, ...batch.deletes].map((write) => write.table))],
      commitSeq: this.seq,
    });
  }
}

describe("runtime", () => {
  test("runs a mutation then a query, and get resolves the id", async () => {
    const r = await runner("rt_basic.db");
    const id = (await r.runMutation("messages:send", { channel: "general", body: "hi" })) as string;
    expect(typeof id).toBe("string");

    const list = (await r.runQuery("messages:list", { channel: "general" })) as { body: string }[];
    expect(list.map((m) => m.body)).toEqual(["hi"]);

    const got = (await r.runQuery("messages:get", { id })) as { _id: string; body: string } | null;
    expect(got?._id).toBe(id);
    expect(got?.body).toBe("hi");
  });

  test("indexed query selects only the matching channel", async () => {
    const r = await runner("rt_index.db");
    await r.runMutation("messages:send", { channel: "a", body: "1" });
    await r.runMutation("messages:send", { channel: "b", body: "2" });
    await r.runMutation("messages:send", { channel: "a", body: "3" });

    const a = (await r.runQuery("messages:list", { channel: "a" })) as { body: string }[];
    expect(a.map((m) => m.body)).toEqual(["1", "3"]);
  });

  test("read-your-writes inside a mutation", async () => {
    const r = await runner("rt_ryow.db");
    const ok = (await r.runMutation("messages:readYourWrites", { channel: "c" })) as boolean;
    expect(ok).toBe(true);
  });

  test("modern ctx.db overloads and normalizeId match Convex call shape", async () => {
    const r = await runner("rt_modern_db.db");
    const result = (await r.runMutation("messages:modernDbSurface", { channel: "modern" })) as {
      byTable: string;
      normalized: string;
      removed: boolean;
      tablePatched: string;
      tableRemoved: boolean;
      tableReplaced: string;
      viaTable: string;
    };
    expect(result.byTable).toBe("old");
    expect(result.normalized).toMatch(/^messages\|/);
    expect(result.tablePatched).toBe("table-patched");
    expect(result.tableReplaced).toBe("table-replaced");
    expect(result.tableRemoved).toBe(true);
    expect(result.viaTable).toBe("replaced");
    expect(result.removed).toBe(true);
  });

  test("table/id overload rejects ids from another table", async () => {
    const r = await runner("rt_wrong_table_get.db");
    const id = (await r.runMutation("messages:send", { channel: "x", body: "x" })) as string;
    await expect(r.runMutation("messages:wrongTableGet", { id })).rejects.toThrow(
      "id does not belong to table tags",
    );
  });

  test("writes are validated against the Convex table schema", async () => {
    const r = await runner("rt_schema_validate.db");
    await expect(r.runMutation("messages:invalidInsert", {})).rejects.toThrow("messages.body");
  });

  test("insert rejects a document carrying a system field", async () => {
    const r = await runner("rt_insert_system_field.db");
    await expect(r.runMutation("messages:insertWithSystemField", {})).rejects.toThrow(
      'system field "_id"',
    );
  });

  test("patch rejects a conflicting _creationTime", async () => {
    const r = await runner("rt_patch_system_field.db");
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    await expect(r.runMutation("messages:patchConflictingCreationTime", { id })).rejects.toThrow(
      '"_creationTime"',
    );
  });

  test("replace accepts system fields that match the stored document", async () => {
    const r = await runner("rt_replace_system_field.db");
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    expect(await r.runMutation("messages:replaceMatchingSystemFields", { id })).toBe(
      "round-tripped",
    );
  });

  test("delete throws when the document does not exist", async () => {
    const r = await runner("rt_delete_missing.db");
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    await r.runMutation("messages:remove", { id });
    await expect(r.runMutation("messages:deleteMissing", { id })).rejects.toThrow(
      "document not found",
    );
  });

  test("delete of the same id twice in one mutation throws", async () => {
    const r = await runner("rt_delete_twice.db");
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    await expect(r.runMutation("messages:deleteTwice", { id })).rejects.toThrow(
      "document not found",
    );
  });

  test("v.record validates union and literal keys", async () => {
    const r = await runner("rt_record_keys.db");
    expect(await r.runQuery("messages:echoLabels", { labels: { a: "x", b: "y" } })).toEqual({
      a: "x",
      b: "y",
    });
    await expect(r.runQuery("messages:echoLabels", { labels: { c: "z" } })).rejects.toThrow();
  });

  test("accepts null-prototype objects as plain Convex objects", async () => {
    const r = await runner("rt_null_proto.db");
    const payload = Object.assign(Object.create(null), { ok: true });
    expect(await r.runQuery("messages:anyEcho", { payload })).toEqual({ ok: true });
  });

  test("encodeError/decodeError preserves ConvexError data and plain error names", () => {
    const convexError = decodeError(encodeError(new ConvexError({ code: 42, reason: "nope" })));
    expect(convexError).toBeInstanceOf(ConvexError);
    expect((convexError as ConvexError<{ code: number; reason: string }>).data).toEqual({
      code: 42,
      reason: "nope",
    });

    const named = new Error("boom");
    named.name = "CustomError";
    const plain = decodeError(encodeError(named));
    expect(plain.name).toBe("CustomError");
    expect(plain.message).toBe("boom");

    // Legacy plain-string payloads decode to a plain Error carrying that text.
    expect(decodeError("mutation failed: x").message).toBe("mutation failed: x");
  });

  test("local auth identity is null when unauthenticated", async () => {
    const r = await runner("rt_auth_null.db");
    expect(await r.runQuery("messages:localAuthIdentity", {})).toBeNull();
  });

  test("query count, limit, async iteration, and pagination execute", async () => {
    const r = await runner("rt_query_consumers.db");
    await r.runMutation("messages:send", { channel: "q", body: "a" });
    await r.runMutation("messages:send", { channel: "q", body: "b" });
    await r.runMutation("messages:send", { channel: "q", body: "c" });
    expect(await r.runQuery("messages:queryConsumers", { channel: "q" })).toEqual({
      count: 3,
      isDone: false,
      iterated: ["a", "b"],
      page: ["a", "b"],
    });
    await expect(r.runQuery("messages:invalidTake", {})).rejects.toThrow("take");
  });

  test("Convex filter builder runs over the scan", async () => {
    const r = await runner("rt_filter.db");
    await r.runMutation("messages:send", { channel: "a", body: "keep" });
    await r.runMutation("messages:send", { channel: "a", body: "drop" });
    const kept = (await r.runQuery("messages:withBody", { body: "keep" })) as unknown[];
    expect(kept.length).toBe(1);
  });

  test("Convex filter builder composes boolean and comparison expressions", async () => {
    const r = await runner("rt_filter_composed.db");
    await r.runMutation("messages:send", { channel: "a", body: "keep" });
    await r.runMutation("messages:send", { channel: "a", body: "drop" });

    const kept = (await r.runQuery("messages:bodyAfterA", { body: "keep" })) as {
      body: string;
    }[];
    expect(kept.map((m) => m.body)).toEqual(["keep"]);
  });

  test("Convex filter equality follows Convex values for objects and bytes", async () => {
    const r = await runner("rt_filter_values.db");
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await r.runMutation("messages:insertRich", { bytes });

    const byObject = (await r.runQuery("messages:withMeta", {
      meta: { nested: ["a", 1, null] },
    })) as { body: string }[];
    expect(byObject.map((m) => m.body)).toEqual(["rich"]);

    const byBytes = (await r.runQuery("messages:withBytes", { bytes })) as { body: string }[];
    expect(byBytes.map((m) => m.body)).toEqual(["rich"]);
  });

  test("query initializer can be reused but chained queries are single-use", async () => {
    const r = await runner("rt_query_lifecycle.db");
    await r.runMutation("messages:send", { channel: "a", body: "one" });
    await r.runMutation("messages:send", { channel: "b", body: "two" });

    expect(await r.runQuery("messages:reusesQueryInitializer", {})).toEqual([["one"], ["two"]]);
    await expect(r.runQuery("messages:rejectsConsumedQueryReuse", {})).rejects.toThrow(
      "A query can only be chained once",
    );
  });

  test("index range callbacks must return the chained builder", async () => {
    const r = await runner("rt_index_range_lifecycle.db");
    await expect(r.runQuery("messages:rejectsUnreturnedIndexRangeBuilder", {})).rejects.toThrow(
      "IndexRangeBuilder has already been used",
    );
  });

  test("order can only be specified once", async () => {
    const r = await runner("rt_duplicate_order.db");
    await expect(r.runQuery("messages:rejectsDuplicateOrder", {})).rejects.toThrow(
      "order can only be specified once",
    );
  });

  test("patch and delete persist", async () => {
    const r = await runner("rt_patch.db");
    const id = (await r.runMutation("messages:send", { channel: "a", body: "old" })) as string;
    await r.runMutation("messages:rename", { id, body: "new" });
    expect(((await r.runQuery("messages:get", { id })) as { body: string }).body).toBe("new");

    await r.runMutation("messages:remove", { id });
    expect(await r.runQuery("messages:get", { id })).toBeNull();
  });

  test("query() sees staged writes inside a mutation", async () => {
    const r = await runner("rt_query_ryow.db");
    const bodies = (await r.runMutation("messages:insertThenQuery", { channel: "c" })) as string[];
    expect(bodies).toEqual(["a", "b"]);
  });

  test("ctx.runQuery can execute another local query", async () => {
    const r = await runner("rt_ctx_run_query.db");
    await r.runMutation("messages:send", { channel: "ctx", body: "x" });
    expect(await r.runMutation("messages:countExistingViaRunQuery", { channel: "ctx" })).toBe(1);
  });

  test("ctx.runQuery revalidates mutated branded args", async () => {
    const r = await runner("rt_ctx_run_query_revalidate.db");
    await expect(r.runMutation("messages:mutateArgsThenRunQuery", { payload: {} })).rejects.toThrow(
      "does not fit into a 64-bit signed integer",
    );
  });

  test("ctx.runQuery sees staged writes inside a mutation", async () => {
    const r = await runner("rt_ctx_run_query_staged.db");
    expect(await r.runMutation("messages:insertThenRunQuery", { channel: "ctx-staged" })).toEqual([
      "staged",
    ]);
  });

  test("nested runMutation stages into the parent transaction", async () => {
    const r = await runner("rt_nested_mutation.db");
    await expect(
      r.runMutation("messages:parentCallsChildThenFails", { channel: "nested" }),
    ).rejects.toThrow("parent failed");
    expect(await r.runQuery("messages:list", { channel: "nested" })).toEqual([]);
    expect(
      await r.runMutation("messages:parentCallsChildThenReads", { channel: "nested" }),
    ).toEqual(["child"]);
  });

  test("query() hides a staged delete inside a mutation", async () => {
    const r = await runner("rt_query_del.db");
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    const remaining = (await r.runMutation("messages:deleteThenQuery", {
      id,
      channel: "c",
    })) as number;
    expect(remaining).toBe(0);
  });

  test("take(n) stays full when a staged patch moves a row out of bounds", async () => {
    const r = await runner("rt_patch_out.db");
    const a = (await r.runMutation("messages:send", { channel: "c", body: "a" })) as string;
    await r.runMutation("messages:send", { channel: "c", body: "b" });
    expect(await r.runMutation("messages:patchOutThenQuery", { id: a })).toBe(1);
  });

  test("take(n) merges staged additions and limits", async () => {
    const r = await runner("rt_take_staged.db");
    expect(await r.runMutation("messages:takeOverStaged", {})).toEqual(["1", "2"]);
  });

  test("zero take and limit do not emit rows", async () => {
    const r = await runner("rt_zero_limits.db");
    await r.runMutation("messages:send", { channel: "zero", body: "x" });
    expect(await r.runQuery("messages:zeroLimitConsumers", { channel: "zero" })).toEqual({
      limited: [],
      taken: [],
    });
  });

  test("paginate rejects zero items instead of emitting a row", async () => {
    const r = await runner("rt_zero_paginate.db");
    await r.runMutation("messages:send", { channel: "zero-page", body: "x" });
    await expect(r.runQuery("messages:paginateZero", { channel: "zero-page" })).rejects.toThrow(
      "paginate: n must be a positive integer",
    );
  });

  test("first() sees a staged-only match", async () => {
    const r = await runner("rt_first_staged.db");
    expect(await r.runMutation("messages:firstOverStaged", {})).toBe("only");
  });

  test("optional index fields keep Convex missing and null semantics", async () => {
    const r = await runner("rt_optional_index.db");
    expect(await r.runMutation("messages:insertUncategorizedThenQuery", {})).toEqual(["untagged"]);
    expect(await r.runMutation("messages:insertNullCategoryThenQuery", {})).toEqual(["nulled"]);
    expect(
      ((await r.runQuery("messages:missingTags", {})) as { name: string }[]).map((t) => t.name),
    ).toEqual(["untagged"]);
    expect(
      ((await r.runQuery("messages:nullTags", {})) as { name: string }[]).map((t) => t.name),
    ).toEqual(["nulled"]);
    expect(await r.runQuery("messages:firstNullTag", {})).toBe("nulled");
  });

  test("range bounds against undefined do not use exact count pushdown", async () => {
    const r = await runner("rt_undefined_range_count.db");
    await r.runMutation("messages:seedCategoryCount", {});
    expect(await r.runQuery("messages:categoryAfterUndefinedCount", {})).toBe(2);
  });

  test("concurrent mutations run serially", async () => {
    const r = await runner("rt_serial_mutations.db");
    const id = (await r.runMutation("messages:send", { channel: "counter", body: "0" })) as string;

    await Promise.all([
      r.runMutation("messages:incrementSlow", { id }),
      r.runMutation("messages:incrementSlow", { id }),
    ]);

    const got = (await r.runQuery("messages:get", { id })) as { body: string };
    expect(got.body).toBe("2");
  });

  test("runMutation snapshots args before the queued handler starts", async () => {
    const r = await runner("rt_mutation_args_snapshot.db");
    const args = { channel: "snap" };
    const promise = r.runMutation("messages:echoChannelSlow", args);
    args.channel = "mutated";
    expect(await promise).toBe("snap");
  });

  test("runner works with a structural storage backend and broad-scan fallback", async () => {
    const r = createRunner({ messages }, new FakeStorage(), storeSchema);
    await r.runMutation("messages:send", { channel: "fake", body: "a" });
    await r.runMutation("messages:send", { channel: "other", body: "b" });

    const seen = (await r.runQuery("messages:list", { channel: "fake" })) as { body: string }[];
    expect(seen.map((message) => message.body)).toEqual(["a"]);
  });

  test("runner replays a committed mutation id without applying writes again", async () => {
    const r = createRunner({ messages }, new FakeStorage(), storeSchema);
    const first = (await r.runMutation(
      "messages:send",
      { channel: "dedupe", body: "a" },
      { mutationId: "mutation:1" },
    )) as string;
    const second = (await r.runMutation(
      "messages:send",
      { channel: "dedupe", body: "a" },
      { mutationId: "mutation:1" },
    )) as string;

    expect(second).toBe(first);
    const seen = (await r.runQuery("messages:list", { channel: "dedupe" })) as { body: string }[];
    expect(seen.map((message) => message.body)).toEqual(["a"]);
  });

  test("runner replays a committed void mutation with the same normalized result", async () => {
    const r = createRunner({ messages }, new FakeStorage(), storeSchema);
    const id = (await r.runMutation("messages:send", {
      channel: "void-replay",
      body: "before",
    })) as string;

    const first = await r.runMutation(
      "messages:rename",
      { id, body: "after" },
      { mutationId: "mutation:void" },
    );
    const second = await r.runMutation(
      "messages:rename",
      { id, body: "after" },
      { mutationId: "mutation:void" },
    );

    expect(first).toBeNull();
    expect(second).toBe(first);
    expect(((await r.runQuery("messages:get", { id })) as { body: string }).body).toBe("after");
  });

  test("runner treats a committed mutation record without a result as a completed void replay", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    const id = (await r.runMutation("messages:send", {
      channel: "old-void-replay",
      body: "before",
    })) as string;
    store.precommitMutation({
      args: encode({ id, body: "after" }),
      mutationId: "mutation:old-void",
      name: "messages:rename",
    });

    expect(
      await r.runMutation(
        "messages:rename",
        { id, body: "after" },
        { mutationId: "mutation:old-void" },
      ),
    ).toBeNull();
    expect(((await r.runQuery("messages:get", { id })) as { body: string }).body).toBe("before");
  });

  test("runner loads lazy modules on demand and caches successful imports", async () => {
    let loads = 0;
    const r = createRunner(
      {
        messages: async () => {
          loads++;
          return messages;
        },
      },
      new FakeStorage(),
      storeSchema,
    );

    await r.runMutation("messages:send", { channel: "lazy", body: "a" });
    await r.runQuery("messages:list", { channel: "lazy" });

    expect(loads).toBe(1);
  });

  test("runner drops failed lazy module imports from the cache", async () => {
    let loads = 0;
    const r = createRunner(
      {
        messages: async () => {
          loads++;
          if (loads === 1) throw new Error("module load failed");
          return messages;
        },
      },
      new FakeStorage(),
      storeSchema,
    );

    await expect(r.runQuery("messages:list", { channel: "lazy" })).rejects.toThrow(
      "module load failed",
    );
    await expect(r.runQuery("messages:list", { channel: "lazy" })).resolves.toEqual([]);
    expect(loads).toBe(2);
  });

  test("runner accepts generated-style refs and real Convex registered exports", async () => {
    const r = createRunner(
      {
        real: {
          list: queryGeneric({
            args: { channel: v.string() },
            handler: (_ctx, args) => [{ body: args.channel }],
          }),
          send: mutationGeneric({
            args: { channel: v.string() },
            handler: (_ctx, args) => args.channel,
          }),
        },
      },
      new FakeStorage(),
      storeSchema,
    );

    const list = makeFunctionReference<"query", { channel: string }, { body: string }[]>(
      "real:list",
    );
    const send = makeFunctionReference<"mutation", { channel: string }, string>("real:send");
    expect(await r.runQuery(list, { channel: "generated" })).toEqual([{ body: "generated" }]);
    expect(await r.runMutation(send, { channel: "generated" })).toBe("generated");
  });

  test("string refs support default exports", async () => {
    const r = createRunner(
      { defaults: { default: query({ args: {}, handler: () => "ok" }) } },
      new FakeStorage(),
      storeSchema,
    );
    expect(await r.runQuery("defaults", {})).toBe("ok");
    expect(await r.runQuery("defaults:default", {})).toBe("ok");
  });

  test("function validators reject bad args and bad returns", async () => {
    const r = await runner("rt_validators.db");
    await expect(r.runMutation("messages:send", { channel: 1, body: "x" })).rejects.toThrow(
      "args.channel must be a string",
    );
    await expect(r.runQuery("messages:badReturn", {})).rejects.toThrow(
      "return value must be a string",
    );
  });

  test("mutation return validation rejects before committing staged writes", async () => {
    const r = await runner("rt_bad_mutation_return.db");
    await expect(r.runMutation("messages:badMutationReturn", {})).rejects.toThrow(
      "return value must be a string",
    );
    const tags = (await r.runQuery("messages:missingTags", {})) as { name: string }[];
    expect(tags.map((tag) => tag.name)).toEqual([]);
  });

  test("onUpdate emits the initial query result and reruns after matching writes", async () => {
    const r = await runner("rt_on_update.db");
    const updates: { body: string }[][] = [];
    const off = r.onUpdate("messages:list", { channel: "live" }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect(await nextUpdate(updates, 0)).toEqual([]);

    await r.runMutation("messages:send", { channel: "live", body: "a" });
    expect((await nextUpdate(updates, 1)).map((m) => m.body)).toEqual(["a"]);

    await r.runMutation("messages:send", { channel: "live", body: "b" });
    expect((await nextUpdate(updates, 2)).map((m) => m.body)).toEqual(["a", "b"]);
    off();
  });

  test("onUpdate does not emit when the query result is unchanged", async () => {
    const r = await runner("rt_on_update_unchanged.db");
    const updates: { body: string }[][] = [];
    const off = r.onUpdate("messages:list", { channel: "live" }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect(await nextUpdate(updates, 0)).toEqual([]);
    await r.runMutation("messages:send", { channel: "other", body: "x" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(updates).toEqual([[]]);
    off();
  });

  test("onUpdate cleanup stops later callbacks", async () => {
    const r = await runner("rt_on_update_cleanup.db");
    const updates: { body: string }[][] = [];
    const off = r.onUpdate("messages:list", { channel: "live" }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect(await nextUpdate(updates, 0)).toEqual([]);
    off();
    await r.runMutation("messages:send", { channel: "live", body: "a" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(updates).toEqual([[]]);
  });

  test("onUpdate snapshots args at registration", async () => {
    const r = await runner("rt_on_update_args_snapshot.db");
    const args = { channel: "live" };
    const updates: { body: string }[][] = [];
    const off = r.onUpdate("messages:list", args, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect(await nextUpdate(updates, 0)).toEqual([]);
    args.channel = "other";
    await r.runMutation("messages:send", { channel: "live", body: "a" });

    expect((await nextUpdate(updates, 1)).map((m) => m.body)).toEqual(["a"]);
    off();
  });

  test("onUpdate reports query errors without leaving an unhandled run", async () => {
    const r = await runner("rt_on_update_error.db");
    const errors: unknown[] = [];
    const off = r.onUpdate(
      "messages:fail",
      {},
      () => {
        throw new Error("should not receive a value");
      },
      (error) => {
        errors.push(error);
      },
    );

    const first = await nextUpdate(errors, 0);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toBe("query failed");
    off();
  });

  test("onUpdate retries a dirty query after the running query fails", async () => {
    const r = await runner("rt_on_update_dirty_error.db");
    flakyFails = true;
    const started = new Promise<void>((resolve) => {
      flakyStarted = resolve;
    });
    const updates: { body: string }[][] = [];
    const errors: unknown[] = [];
    const off = r.onUpdate(
      "messages:flakyList",
      { channel: "live" },
      (value) => {
        updates.push(value as { body: string }[]);
      },
      (error) => {
        errors.push(error);
      },
    );

    await started;
    await r.runMutation("messages:send", { channel: "live", body: "a" });
    const firstError = await nextUpdate(errors, 0);
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe("flaky query failed");
    expect((await nextUpdate(updates, 0)).map((m) => m.body)).toEqual(["a"]);

    off();
    flakyStarted = undefined;
  });
});
