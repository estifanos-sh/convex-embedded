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
import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import type {
  CountSpec,
  RuntimeStorage,
  ScanSpec,
  StoreSchema,
  StoredDoc,
  WriteBatch,
} from "../src/storage/types";
import { defineFunctions } from "../src/runtime/functions";
import { createRunner, type Runner } from "../src/runtime/runner";
import { openTurso } from "../src/node/turso";
import { EmbeddedStore } from "../src/storage/store";

// convex/schema.ts — plain Convex schema → the typed data model
const appSchema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
  tags: defineTable({
    category: v.optional(v.string()),
    name: v.string(),
  }).index("by_category", ["category"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;

const { query, mutation } = defineFunctions<DataModel>();
let flakyFails = false;
let flakyStarted: (() => void) | undefined;

// convex/messages.ts — typed plain Convex functions (ctx.db, args fully inferred)
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

// The storage schema (extracted indexed cols + indexes) — derived from appSchema by the §6 bundler later.
const storeSchema: StoreSchema = {
  tables: [
    {
      name: "messages",
      columns: [{ name: "channel", affinity: "TEXT" }],
      indexes: [{ name: "by_channel", fields: ["channel"] }],
    },
    {
      name: "tags",
      columns: [{ name: "category", affinity: "TEXT" }],
      indexes: [{ name: "by_category", fields: ["category"] }],
    },
  ],
};

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

async function runner(name: string): Promise<Runner> {
  const store = EmbeddedStore.open(await openTurso(tmp(name)));
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
  private readonly docs = new Map<string, StoredDoc>();

  get(_table: string, id: string): Promise<StoredDoc | undefined> {
    return Promise.resolve(this.docs.get(id));
  }

  scan(spec: ScanSpec): Promise<StoredDoc[] | null> {
    if (spec.index) return Promise.resolve(null);
    const rows = [...this.docs.values()]
      .filter((doc) => doc._id.startsWith(`${spec.table}|`))
      .sort((a, b) => {
        const byTime = a._creationTime - b._creationTime;
        if (byTime !== 0) return spec.order === "desc" ? -byTime : byTime;
        return spec.order === "desc" ? b._id.localeCompare(a._id) : a._id.localeCompare(b._id);
      });
    return Promise.resolve(spec.limit === undefined ? rows : rows.slice(0, spec.limit));
  }

  count(_spec: CountSpec): Promise<number> {
    return Promise.resolve(this.docs.size);
  }

  nextCreationTime(): number {
    return this.now++;
  }

  commit(batch: WriteBatch): Promise<void> {
    for (const upsert of batch.upserts) {
      this.docs.set(upsert.id, {
        _id: upsert.id,
        _creationTime: upsert.creationTime,
        data: upsert.data,
      });
    }
    for (const del of batch.deletes) this.docs.delete(del.id);
    return Promise.resolve();
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
