import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import type { StoreSchema } from "../src/storage/types";
import { toSchema } from "../src/runtime/database";
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
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;

const { query, mutation } = defineFunctions<DataModel>();

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
        .filter((d) => d.body === args.body)
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
};

// The storage schema (extracted indexed cols + indexes) — derived from appSchema by the §6 bundler later.
const storeSchema: StoreSchema = {
  tables: [
    {
      name: "messages",
      columns: [{ name: "channel", affinity: "TEXT" }],
      indexes: [{ name: "by_channel", fields: ["channel"] }],
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
  return createRunner({ messages }, store, toSchema(storeSchema));
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

  test("a JS .filter() runs over the scan", async () => {
    const r = await runner("rt_filter.db");
    await r.runMutation("messages:send", { channel: "a", body: "keep" });
    await r.runMutation("messages:send", { channel: "a", body: "drop" });
    const kept = (await r.runQuery("messages:withBody", { body: "keep" })) as unknown[];
    expect(kept.length).toBe(1);
  });

  test("patch and delete persist", async () => {
    const r = await runner("rt_patch.db");
    const id = (await r.runMutation("messages:send", { channel: "a", body: "old" })) as string;
    await r.runMutation("messages:rename", { id, body: "new" });
    expect(((await r.runQuery("messages:get", { id })) as { body: string }).body).toBe("new");

    await r.runMutation("messages:remove", { id });
    expect(await r.runQuery("messages:get", { id })).toBeNull();
  });
});
