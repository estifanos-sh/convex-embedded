import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { defineFunctions } from "../../src/runtime/functions";
import { createRunner, type Runner } from "../../src/runtime/runner";
import { toStoreSchema } from "../../src/schema";
import { NativeStore } from "../../src/node/native";
import { nativeModule } from "./native";

const appSchema = defineSchema({
  items: defineTable({
    flag: v.optional(v.union(v.null(), v.string())),
    n: v.number(),
  }).index("by_flag", ["flag"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;
const { query, mutation } = defineFunctions<DataModel>();

const items = {
  seed: mutation({
    args: {
      rows: v.array(v.object({ flag: v.optional(v.union(v.null(), v.string())), n: v.number() })),
    },
    handler: async (ctx, args) => {
      for (const row of args.rows) {
        await ctx.db.insert("items", row.flag === undefined ? { n: row.n } : row);
      }
    },
  }),
  takeNullFlags: query({
    args: { count: v.number() },
    handler: (ctx, args) =>
      ctx.db
        .query("items")
        .withIndex("by_flag", (q) => q.eq("flag", null))
        .take(args.count),
  }),
  byFlag: query({
    args: {},
    handler: (ctx) => ctx.db.query("items").withIndex("by_flag").collect(),
  }),
  paginateByFlag: query({
    args: {
      cursor: v.union(v.string(), v.null()),
      endCursor: v.optional(v.union(v.string(), v.null())),
      numItems: v.number(),
    },
    handler: (ctx, args) =>
      ctx.db
        .query("items")
        .withIndex("by_flag")
        .paginate({ cursor: args.cursor, endCursor: args.endCursor, numItems: args.numItems }),
  }),
  countBig: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("items")
        .filter((q) => q.gte(q.field("n"), 100))
        .count(),
  }),
  collectBig: query({
    args: {},
    handler: (ctx) =>
      ctx.db
        .query("items")
        .filter((q) => q.gte(q.field("n"), 100))
        .collect(),
  }),
  mutateReadAlias: mutation({
    args: {},
    handler: async (ctx) => {
      const id = await ctx.db.insert("items", { flag: "alias", n: 1 });
      const staged = await ctx.db.get(id);
      (staged as { n: number }).n = 999;
      const viaQuery = await ctx.db
        .query("items")
        .withIndex("by_flag", (q) => q.eq("flag", "alias"))
        .first();
      (viaQuery as { n: number }).n = 999;
      return id;
    },
  }),
  readN: query({
    args: { id: v.id("items") },
    handler: async (ctx, args) => (await ctx.db.get(args.id))?.n ?? null,
  }),
  countedList: query({
    args: {},
    handler: (ctx) => {
      countedListRuns += 1;
      return ctx.db.query("items").withIndex("by_flag").collect();
    },
  }),
  countDuringMutation: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("items", { flag: "staged", n: 100 });
      const all = await ctx.db.query("items").count();
      const filtered = await ctx.db
        .query("items")
        .filter((q) => q.gte(q.field("n"), 100))
        .count();
      return { all, filtered };
    },
  }),
};

let countedListRuns = 0;

describe("streaming query engine", () => {
  test("identical watch subscriptions share one query execution", async () => {
    const r = await runner("stream_shared_watch.db");
    countedListRuns = 0;
    const first: unknown[] = [];
    const second: unknown[] = [];
    const offFirst = r.onUpdate("items:countedList", {}, (value) => first.push(value));
    const offSecond = r.onUpdate("items:countedList", {}, (value) => second.push(value));
    await waitUntil(() => first.length >= 1 && second.length >= 1);
    expect(countedListRuns).toBe(1);

    await r.runMutation("items:seed", { rows: [{ flag: "x", n: 1 }] });
    await waitUntil(() => first.length >= 2 && second.length >= 2);
    expect(countedListRuns).toBe(2);

    offFirst();
    await r.runMutation("items:seed", { rows: [{ flag: "y", n: 2 }] });
    await waitUntil(() => second.length >= 3);
    expect(first.length).toBe(2);
    offSecond();
  });

  test("filtered take refills past widened pages instead of under-filling", async () => {
    const r = await runner("stream_underfill.db");
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({ n: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ flag: null, n: 100 + i })),
    ];
    await r.runMutation("items:seed", { rows });
    const taken = (await r.runQuery("items:takeNullFlags", { count: 3 })) as { n: number }[];
    expect(taken.map((doc) => doc.n)).toEqual([100, 101, 102]);
  });

  test("orders undefined index values before null across interleaved creation", async () => {
    const r = await runner("stream_reorder.db");
    const rows = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? { n: i } : { flag: null as null, n: i },
    );
    await r.runMutation("items:seed", { rows });
    const all = (await r.runQuery("items:byFlag", {})) as { flag?: null; n: number }[];
    expect(all.map((doc) => doc.n)).toEqual([0, 2, 4, 6, 8, 1, 3, 5, 7, 9]);
  });

  test("paginates with stable keyset cursors and a terminal isDone page", async () => {
    const r = await runner("stream_paginate.db");
    await r.runMutation("items:seed", {
      rows: Array.from({ length: 5 }, (_, i) => ({ flag: `f${i}`, n: i })),
    });

    const page1 = (await r.runQuery("items:paginateByFlag", {
      cursor: null,
      numItems: 2,
    })) as { continueCursor: string; isDone: boolean; page: { n: number }[] };
    expect(page1.page.map((doc) => doc.n)).toEqual([0, 1]);
    expect(page1.isDone).toBe(false);

    const page2 = (await r.runQuery("items:paginateByFlag", {
      cursor: page1.continueCursor,
      numItems: 2,
    })) as typeof page1;
    expect(page2.page.map((doc) => doc.n)).toEqual([2, 3]);

    const page3 = (await r.runQuery("items:paginateByFlag", {
      cursor: page2.continueCursor,
      numItems: 2,
    })) as typeof page1;
    expect(page3.page.map((doc) => doc.n)).toEqual([4]);
    expect(page3.isDone).toBe(true);
    expect(page3.continueCursor).toBe("v1:end");

    const done = (await r.runQuery("items:paginateByFlag", {
      cursor: page3.continueCursor,
      numItems: 2,
    })) as typeof page1;
    expect(done.page).toEqual([]);
    expect(done.isDone).toBe(true);
    await expect(r.runQuery("items:paginateByFlag", { cursor: "2", numItems: 2 })).rejects.toThrow(
      "invalid pagination cursor",
    );

    const window = (await r.runQuery("items:paginateByFlag", {
      cursor: page1.continueCursor,
      endCursor: page2.continueCursor,
      numItems: 99,
    })) as typeof page1;
    expect(window.page.map((doc) => doc.n)).toEqual([2, 3]);
    expect(window.isDone).toBe(false);
    expect(window.continueCursor).toBe(page2.continueCursor);
  });

  test("predicate count matches collect through the stream", async () => {
    const r = await runner("stream_count.db");
    await r.runMutation("items:seed", {
      rows: Array.from({ length: 20 }, (_, i) => ({ flag: `f${i}`, n: i * 10 })),
    });
    const count = (await r.runQuery("items:countBig", {})) as number;
    const collected = (await r.runQuery("items:collectBig", {})) as unknown[];
    expect(count).toBe(collected.length);
    expect(count).toBe(10);
  });

  test("count inside a mutation sees staged writes", async () => {
    const r = await runner("stream_overlay_count.db");
    await r.runMutation("items:seed", {
      rows: [
        { flag: "a", n: 50 },
        { flag: "b", n: 150 },
      ],
    });
    const counts = (await r.runMutation("items:countDuringMutation", {})) as {
      all: number;
      filtered: number;
    };
    expect(counts.all).toBe(3);
    expect(counts.filtered).toBe(2);
  });

  test("mutating a doc returned from a staged read does not corrupt the commit", async () => {
    const r = await runner("stream_alias.db");
    const id = (await r.runMutation("items:mutateReadAlias", {})) as string;
    expect(await r.runQuery("items:readN", { id })).toBe(1);
  });
});

async function runner(name: string): Promise<Runner> {
  const storeSchema = toStoreSchema(appSchema);
  const store = await NativeStore.openWith(nativeModule().Store, tmp(name));
  await store.setup(storeSchema);
  return createRunner({ items }, store, storeSchema);
}

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

async function waitUntil(done: () => boolean): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
