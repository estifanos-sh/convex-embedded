import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  componentsGeneric,
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
} from "convex/server";
import { compareValues, convexToJson, ConvexError, v } from "convex/values";
import type { Value } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type {
  EmbeddedDataEvent,
  DiagnosticEvent as EmbeddedEvent,
  EmbeddedSchedulerEvent,
  EmbeddedStorageEvent,
  EmbeddedDataWrite,
} from "../../src/events";
import type {
  CommitOptions,
  CountSpec,
  KeyPage,
  IdMapping,
  MutationCall,
  MutationRecord,
  RemoteScope,
  RemoteSurface,
  RuntimeStorage,
  DocPage,
  ReadSpec,
  StoreSchema,
  StoredDoc,
  WriteBatch,
} from "../../src/storage/types";
import { decode, decodeError, encode, encodeError } from "../../src/runtime/codec";
import {
  commitTsPlaceholder,
  hasPendingCommitTs,
  knownPendingCommitTsRead,
  pendingCommitTsRead,
} from "../../src/runtime/pending";
import { defineFunctions } from "../../src/runtime/functions";
import { seedEntropy, withEntropy } from "../../src/entropy";
import { createRunner, type Runner } from "../../src/runtime/runner";
import { toRuntimeStoreSchema, toStoreSchema } from "../../src/schema";
import { NativeStore } from "../../src/node/native";
import { getTimerTime } from "../../src/time";
import { read as readTime } from "../testkit/time";
import { e } from "../../src/values";
import { base as textBase } from "../../src/text";
import { createTextField } from "../../src/text/field";
import { nativeModule } from "../testkit/native";

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
  stamps: defineTable({
    label: v.string(),
    stamp: v.commitTs(),
  }).index("by_stamp", ["stamp"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;

const functions = defineFunctions<DataModel>();
const { query, mutation } = functions.replicated;
const { action } = functions.remote;
let flakyFails = false;
let flakyStarted: (() => void) | undefined;

const messages = {
  stampCommitTs: mutation({
    args: {},
    returns: v.commitTs(),
    handler: async (ctx) => {
      const stamp = ctx.db.vars.commitTs;
      await ctx.db.insert("messages", {
        body: "timestamped",
        channel: "timestamp",
        meta: { stamp },
      });
      return stamp;
    },
  }),
  stageAndFindCommitTs: mutation({
    args: { label: v.string() },
    returns: v.object({ found: v.string(), stamp: v.commitTs() }),
    handler: async (ctx, args) => {
      const stamp = ctx.db.vars.commitTs;
      await ctx.db.insert("stamps", { label: args.label, stamp });
      const found = await ctx.db
        .query("stamps")
        .withIndex("by_stamp", (q) => q.eq("stamp", stamp))
        .unique();
      return { found: found?.label ?? "missing", stamp };
    },
  }),
  echo: query({
    args: { value: v.any() },
    returns: v.any(),
    handler: (_ctx, args) => args.value,
  }),
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", { channel: args.channel, body: args.body }),
  }),
  migrateChannel: mutation({
    visibility: "internal",
    args: { from: v.string(), to: v.string() },
    handler: async (ctx, args) => {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.from))
        .collect();
      for (const row of rows) await ctx.db.patch(row._id, { channel: args.to });
      return rows.length;
    },
  }),
  list: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect(),
  }),
  listTake: query({
    args: { channel: v.string(), limit: v.number() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .take(args.limit),
  }),
  strictList: query({
    args: {},
    returns: v.array(
      v.object({
        _creationTime: v.number(),
        _id: v.id("messages"),
        body: v.string(),
        bytes: v.optional(v.bytes()),
        channel: v.string(),
        meta: v.optional(v.any()),
      }),
    ),
    handler: (ctx) => ctx.db.query("messages").collect(),
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
  insertThenPatchBody: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      const id = await ctx.db.insert("messages", { channel: args.channel, body: "before" });
      await ctx.db.patch(id, { body: "after" });
      return id;
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
  queryStorageStoreType: query({
    args: {},
    handler: (ctx) => typeof (ctx.storage as { store?: unknown }).store,
  }),
  echoAction: action({
    args: { text: v.string() },
    handler: async (ctx, args) => ({
      identity: await ctx.auth.getUserIdentity(),
      text: args.text,
    }),
  }),
  internalAction: action({
    args: {},
    visibility: "internal",
    handler: () => "secret",
  }),
  mutationStorageShape: mutation({
    args: {},
    handler: (ctx) => ({
      delete: typeof (ctx.storage as { delete?: unknown }).delete,
      generateUploadUrl: typeof (ctx.storage as { generateUploadUrl?: unknown }).generateUploadUrl,
      get: typeof (ctx.storage as { get?: unknown }).get,
      store: typeof (ctx.storage as { store?: unknown }).store,
    }),
  }),
  actionStorageShape: action({
    args: {},
    handler: (ctx) => ({
      delete: typeof (ctx.storage as { delete?: unknown }).delete,
      generateUploadUrl: typeof (ctx.storage as { generateUploadUrl?: unknown }).generateUploadUrl,
      get: typeof (ctx.storage as { get?: unknown }).get,
      store: typeof (ctx.storage as { store?: unknown }).store,
    }),
  }),
  storageMetadata: query({
    args: { id: v.string() },
    handler: (ctx, args) =>
      (
        ctx.db.system as {
          get(table: "_storage", id: string): Promise<unknown>;
        }
      ).get("_storage", args.id),
  }),
  storeFile: action({
    args: { text: v.string() },
    handler: async (ctx, args) => {
      const storage = ctx.storage as {
        store(blob: Blob): Promise<string>;
      };
      const id = await storage.store(new Blob([args.text], { type: "text/plain" }));
      return { id };
    },
  }),
  storeFileThenFail: action({
    args: {},
    handler: async (ctx) => {
      await (
        ctx.storage as {
          store(blob: Blob): Promise<string>;
        }
      ).store(new Blob(["orphan"]));
      throw new Error("after file store");
    },
  }),
  storeThenDeleteFile: action({
    args: {},
    handler: async (ctx) => {
      const storage = ctx.storage as {
        delete(id: string): Promise<void>;
        store(blob: Blob): Promise<string>;
      };
      const id = await storage.store(new Blob(["delete-me"]));
      await storage.delete(id);
      return id;
    },
  }),
  mutationRunActionType: mutation({
    args: {},
    handler: (ctx) => typeof (ctx as { runAction?: unknown }).runAction,
  }),
  scheduleChild: mutation({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      (
        ctx.scheduler as { runAfter(ms: number, ref: string, args: unknown): Promise<string> }
      ).runAfter(10_000, "messages:childInsert", {
        body: "scheduled",
        channel: args.channel,
      }),
  }),
  scheduleImmediate: mutation({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      (
        ctx.scheduler as { runAfter(ms: number, ref: string, args: unknown): Promise<string> }
      ).runAfter(0, "messages:childInsert", {
        body: "scheduled",
        channel: args.channel,
      }),
  }),
  scheduleCommitTs: mutation({
    args: {},
    handler: (ctx) =>
      (
        ctx.scheduler as { runAfter(ms: number, ref: string, args: unknown): Promise<string> }
      ).runAfter(0, "messages:childStamp", { value: ctx.db.vars.commitTs }),
  }),
  childStamp: mutation({
    visibility: "internal",
    args: { value: v.any() },
    handler: () => null,
  }),
  cancelScheduled: mutation({
    args: { id: v.string() },
    handler: (ctx, args) =>
      (ctx.scheduler as { cancel(id: string): Promise<void> }).cancel(args.id),
  }),
  scheduleThenThrow: mutation({
    args: { channel: v.string() },
    handler: async (ctx, args) => {
      await (
        ctx.scheduler as { runAfter(ms: number, ref: string, args: unknown): Promise<string> }
      ).runAfter(0, "messages:childInsert", { body: "scheduled", channel: args.channel });
      throw new Error("schedule rollback boom");
    },
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
  page: query({
    args: {
      channel: v.string(),
      paginationOpts: v.object({
        cursor: v.union(v.string(), v.null()),
        numItems: v.number(),
      }),
    },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .paginate(args.paginationOpts),
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

const storeSchema: StoreSchema = toRuntimeStoreSchema(appSchema);

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
  const started = getTimerTime();
  while (updates.length <= seen) {
    if (getTimerTime() - started > 1_000) {
      throw new Error(`timed out waiting for update ${seen + 1}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return updates[seen] as T;
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const started = getTimerTime();
  while (!(await check())) {
    if (getTimerTime() - started > 1_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeStorage implements RuntimeStorage {
  private now = 1;
  private seq = 0;
  private commitTs = 0n;
  private readonly docs = new Map<string, StoredDoc>();
  private readonly ids = new Map<string, IdMapping>();
  private readonly mutations = new Map<string, MutationRecord & { args: string; name: string }>();
  mutationWriteCalls = 0;
  readonly pushEnvelopes: Array<{
    afterImages: unknown[];
    crdt: unknown[];
    reads?: Array<{
      kind: string;
      equality?: Array<{ field: string; value: unknown; commitTs?: true }>;
      members?: string[];
    }>;
  }> = [];

  constructor(readonly remote?: RemoteSurface) {}

  /**
   * A deliberately broad single-page backend: bounds are ignored (the runtime re-checks every
   * doc), everything comes back in one page, and exact count pushdown is unsupported so the
   * runtime counts through the document stream. Rows ARE returned in exact Convex order by the
   * index fields (then _creationTime, _id), mirroring the real order-key backend.
   */
  readonly doc = {
    read: (_table: string, id: string): Promise<StoredDoc | undefined> =>
      Promise.resolve(this.docs.get(id)),
    version: {
      read: (_table: string, _id: string): Promise<number | undefined> =>
        Promise.resolve(undefined),
    },
    crdt: {
      read: (_table: string, _id: string, _field: string): Promise<number | undefined> =>
        Promise.resolve(undefined),
      snapshot: { read: (_table: string, _id: string) => Promise.resolve([]) },
    },
    page: {
      read: (spec: ReadSpec): Promise<DocPage> =>
        Promise.resolve({ cursor: null, docs: this.rows(spec) }),
    },
    count: {
      read: (_spec: CountSpec): Promise<number | null> => Promise.resolve(null),
    },
  };

  readonly key = {
    page: {
      read: (spec: ReadSpec): Promise<KeyPage> => {
        const rows = this.rows(spec);
        return Promise.resolve({
          cursor: null,
          ids: rows.map((doc) => doc._id),
          creationTimes: rows.map((doc) => doc._creationTime),
        });
      },
    },
  };

  readonly clock = {
    read: (): number => this.now++,
  };

  readonly mutation = {
    write: (call: MutationCall): Promise<MutationRecord> => {
      this.mutationWriteCalls += 1;
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

  readonly id = {
    write: (mapping: IdMapping): Promise<void> => {
      this.ids.set(`${mapping.table}\0${mapping.localId}`, { ...mapping });
      return Promise.resolve();
    },
    read: (table: string, localId: string): Promise<IdMapping | undefined> => {
      const mapping = this.ids.get(`${table}\0${localId}`);
      return Promise.resolve(mapping ? { ...mapping } : undefined);
    },
    page: {
      read: (table: string): Promise<IdMapping[]> =>
        Promise.resolve(
          [...this.ids.values()]
            .filter((mapping) => mapping.table === table)
            .map((item) => ({
              ...item,
            })),
        ),
    },
    delete: (table: string, localId: string): Promise<void> => {
      this.ids.delete(`${table}\0${localId}`);
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

  rebaseCreationTime(id: string, creationTime: number): void {
    const document = this.docs.get(id);
    if (!document) throw new Error(`missing test document: ${id}`);
    this.docs.set(id, { ...document, _creationTime: creationTime });
  }

  private rows(spec: ReadSpec): StoredDoc[] {
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
    const commitTs = options?.commitTs === true ? (this.commitTs += 1n) : undefined;
    if (commitTs !== undefined && options !== undefined) {
      for (const write of batch.docWrites) {
        if (write.pendingCommitTs !== true && !hasPendingCommitTs(write.data)) continue;
        write.data = knownPendingCommitTsRead(write.data, commitTs);
        const entries = Array.isArray(write.cols) ? write.cols : Object.entries(write.cols);
        for (const [name, value] of entries) {
          if (typeof value !== "object" || value?.kind !== "commitTs") continue;
          if (Array.isArray(write.cols)) {
            const entry = write.cols.find(([candidate]) => candidate === name);
            if (entry) entry[1] = commitTs;
          } else {
            write.cols[name] = commitTs;
          }
        }
      }
      for (const write of batch.localFieldWrites ?? []) {
        if (write.pendingCommitTs !== true && !hasPendingCommitTs(write.value)) continue;
        write.value = knownPendingCommitTsRead(write.value, commitTs);
      }
      if (
        options.source === "local" &&
        "mutation" in options &&
        (options.mutation === "existing" || options.mutation === "terminal") &&
        options.mutationResultCommitTs === true &&
        options.mutationResult !== undefined
      ) {
        options.mutationResult = encode(
          pendingCommitTsRead(decode(options.mutationResult), commitTs),
        );
      }
      if (
        options.source === "local" &&
        "push" in options &&
        options.push?.afterImagesCommitTs === true
      ) {
        const envelope = JSON.parse(options.push.json) as {
          afterImages: Array<{ content: string; value?: unknown }>;
        };
        for (const image of envelope.afterImages) {
          if (image.content === "value") image.value = resolveJsonCommitTs(image.value, commitTs);
        }
        options.push.json = JSON.stringify(envelope);
      }
    }
    if (options?.source === "local" && "push" in options && options.push !== undefined) {
      this.pushEnvelopes.push(
        JSON.parse(options.push.json) as { afterImages: unknown[]; crdt: unknown[] },
      );
    }
    if (
      options?.source === "local" &&
      (options.mutation === "existing" || options.mutation === "terminal")
    ) {
      const record = this.mutations.get(options.mutationId);
      if (!record) {
        if (options.mutation !== "terminal") {
          return Promise.reject(new Error(`mutation is not accepted: ${options.mutationId}`));
        }
        this.mutations.set(options.mutationId, {
          args: options.mutationArgs,
          mutationId: options.mutationId,
          name: options.mutationName,
          status: "accepted",
        });
      } else if (record.status !== "accepted") {
        return Promise.reject(new Error(`mutation is not accepted: ${options.mutationId}`));
      }
    }
    const changes = [
      ...batch.docWrites.map((docWrite) => ({
        id: docWrite.id,
        op: "write" as const,
        row: {
          ...docWrite.data,
          _id: docWrite.id,
          _creationTime: docWrite.creationTime,
        },
        table: docWrite.table,
      })),
      ...batch.deletes.map((deleted) => ({
        id: deleted.id,
        op: "delete" as const,
        table: deleted.table,
      })),
    ];
    for (const docWrite of batch.docWrites) {
      this.docs.set(docWrite.id, {
        ...docWrite.data,
        _id: docWrite.id,
        _creationTime: docWrite.creationTime,
      });
    }
    for (const del of batch.deletes) this.docs.delete(del.id);
    for (const mapping of batch.idMappings ?? []) {
      this.ids.set(`${mapping.table}\0${mapping.localId}`, { ...mapping });
    }
    this.seq += 1;
    if (options?.source === "local" && options.mutation !== "none") {
      const record = this.mutations.get(options.mutationId);
      if (!record) throw new Error(`mutation disappeared during commit: ${options.mutationId}`);
      record.commitSeq = this.seq;
      record.result = "mutationResult" in options ? options.mutationResult : undefined;
      record.status = "committed";
    }
    return Promise.resolve({
      changedTables: [
        ...new Set([...batch.docWrites, ...batch.deletes].map((write) => write.table)),
      ],
      changes,
      commitSeq: this.seq,
      ...(commitTs === undefined ? {} : { commitTs }),
    });
  }
}

function resolveJsonCommitTs(value: unknown, timestamp: bigint): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveJsonCommitTs(item, timestamp));
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).length === 1 && fields.$commitTs === null) {
      return convexToJson(timestamp as Value);
    }
    return Object.fromEntries(
      Object.entries(fields).map(([key, item]) => [key, resolveJsonCommitTs(item, timestamp)]),
    );
  }
  return value;
}

describe("runtime", () => {
  test("resolves db.vars.commitTs atomically in the returned value and stored document", async () => {
    const r = await runner("commit-timestamp");
    const first = (await r.runMutation("messages:stampCommitTs", {})) as bigint;
    const second = (await r.runMutation("messages:stampCommitTs", {})) as bigint;

    expect(typeof first).toBe("bigint");
    expect(typeof second).toBe("bigint");
    expect(second).toBeGreaterThan(first);
    const rows = (await r.runQuery("messages:list", { channel: "timestamp" })) as Array<{
      meta: { stamp: bigint };
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.meta.stamp).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      [first, second].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  test("replicated pushes retain logical result hashing and resolve only durable after-images", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    const mutationId = "mutation:commit-timestamp-push";
    await store.mutation.write({ args: "{}", mutationId, name: "messages:stampCommitTs" });

    const result = await r.runMutation(
      "messages:stampCommitTs",
      {},
      {
        mutationId,
        mutationIsFresh: true,
        pushCall: { fn: "messages:stampCommitTs", rngSeed: mutationId },
      },
    );

    expect(result).toBe(1n);
    expect(store.pushEnvelopes).toMatchObject([
      {
        afterImages: [
          {
            value: { meta: { stamp: convexToJson(1n) } },
          },
        ],
      },
    ]);
  });

  test("staged index equality keeps the logical marker distinct from literal max int64", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    await r.runMutation("messages:send", { body: "seed", channel: "unrelated" });
    await store.commit(
      {
        docWrites: [
          {
            table: "stamps",
            id: "stamps|ffffffffffffffffffffffffffffffff",
            data: { label: "literal-max", stamp: (1n << 63n) - 1n },
            cols: [["stamp", (1n << 63n) - 1n]],
            creationTime: 1,
          },
        ],
        deletes: [],
      },
      { changes: "omit", source: "remote" },
    );

    const result = (await r.runMutation("messages:stageAndFindCommitTs", {
      label: "pending",
    })) as { found: string; stamp: bigint };
    expect(result).toEqual({ found: "pending", stamp: 1n });
  });

  test("replicated commit timestamp witnesses exclude the physical MAX_INT64 sentinel row", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    const literalMaxId = "stamps|ffffffffffffffffffffffffffffffff";
    await store.commit(
      {
        docWrites: [
          {
            table: "stamps",
            id: literalMaxId,
            data: { label: "literal-max", stamp: (1n << 63n) - 1n },
            cols: [["stamp", (1n << 63n) - 1n]],
            creationTime: 1,
          },
        ],
        deletes: [],
      },
      { changes: "omit", source: "remote" },
    );
    const mutationId = "mutation:commit-timestamp-witness";
    await store.mutation.write({ args: "{}", mutationId, name: "messages:stageAndFindCommitTs" });

    await r.runMutation(
      "messages:stageAndFindCommitTs",
      { label: "pending" },
      {
        mutationId,
        mutationIsFresh: true,
        pushCall: { fn: "messages:stageAndFindCommitTs", rngSeed: mutationId },
      },
    );

    const range = store.pushEnvelopes[0]?.reads?.find((read) => read.kind === "range");
    expect(range?.equality).toMatchObject([{ field: "stamp", commitTs: true }]);
    expect(range?.members).not.toContain(literalMaxId);
  });

  test("top-level queries and scheduled arguments reject the pending timestamp", async () => {
    const r = createRunner({ messages }, new FakeStorage(), storeSchema);
    await expect(r.runQuery("messages:echo", { value: commitTsPlaceholder })).rejects.toThrow(
      "db.vars.commitTs",
    );
    const nativeStore = await NativeStore.openWith(
      nativeModule().Store,
      tmp("rt_commit_timestamp_schedule_reject.db"),
    );
    await nativeStore.setup(storeSchema);
    const nativeRunner = createRunner({ messages }, nativeStore, storeSchema);
    await expect(nativeRunner.runMutation("messages:scheduleCommitTs", {})).rejects.toThrow(
      "db.vars.commitTs",
    );
    await nativeStore.close();
  });

  test("separates plain after-images from CRDT effects", async () => {
    const crdtSchema = defineSchema({
      docs: defineTable({
        body: e.text(),
        title: v.string(),
      }),
    });
    type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
    const { mutation: crdtMutation } = defineFunctions<CrdtDataModel>().replicated;
    const docs = {
      seed: crdtMutation({
        args: {},
        handler: (ctx) => ctx.db.insert("docs", { body: "seed", title: "first" }),
      }),
      body: crdtMutation({
        args: { id: v.id("docs") },
        handler: (ctx, args) =>
          ctx.db.text.splice("docs", args.id, "body", {
            delete: 0,
            index: 4,
            insert: " body",
          }),
      }),
      title: crdtMutation({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.patch(args.id, { title: "plain" }),
      }),
      mixed: crdtMutation({
        args: { id: v.id("docs") },
        handler: async (ctx, args) => {
          await ctx.db.text.splice("docs", args.id, "body", {
            delete: 0,
            index: 9,
            insert: " mixed",
          });
          await ctx.db.patch(args.id, { title: "mixed" });
        },
      }),
    };
    const store = new FakeStorage();
    const runner = createRunner({ docs }, store, toStoreSchema(crdtSchema));
    const id = (await runner.runMutation("docs:seed", {})) as string;
    const push = async (name: "body" | "title" | "mixed", ordinal: number) => {
      const mutationId = `mutation:crdt-contract:${ordinal}`;
      await store.mutation.write({ args: "test", mutationId, name: `docs:${name}` });
      await runner.runMutation(
        `docs:${name}`,
        { id },
        {
          mutationIsFresh: true,
          mutationId,
          pushCall: { fn: `documents:${name}`, rngSeed: mutationId },
        },
      );
      return store.pushEnvelopes.at(-1)!;
    };

    expect(await push("body", 1)).toMatchObject({
      afterImages: [],
      crdt: [{ field: "body", kind: "text" }],
    });
    expect(await push("title", 2)).toMatchObject({
      afterImages: [{ content: "value", rowId: id, table: "docs" }],
      crdt: [],
    });
    expect(await push("mixed", 3)).toMatchObject({
      afterImages: [{ content: "value", rowId: id, table: "docs" }],
      crdt: [{ field: "body", kind: "text" }],
    });
  });

  test("seeds every entropy source from one stream on the local push path", async () => {
    const entropySchema = defineSchema({ notes: defineTable({ body: v.string() }) });
    type EntropyModel = DataModelFromSchemaDefinition<typeof entropySchema>;
    const { mutation: entropyMutation } = defineFunctions<EntropyModel>().replicated;
    const draws: unknown[] = [];
    const notes = {
      seed: entropyMutation({
        args: {},
        handler: (ctx) => ctx.db.insert("notes", { body: "seed" }),
      }),
      mix: entropyMutation({
        args: { id: v.id("notes") },
        handler: async (ctx, args) => {
          draws.push(Math.random());
          draws.push(crypto.randomUUID());
          draws.push([...crypto.getRandomValues(new Uint8Array(10))]);
          draws.push(Math.random());
          draws.push([...crypto.getRandomValues(new Uint8Array(3))]);
          draws.push(crypto.randomUUID());
          await ctx.db.patch(args.id, { body: "next" });
          return null;
        },
      }),
    };
    const store = new FakeStorage();
    const runner = createRunner({ notes }, store, toStoreSchema(entropySchema));
    const id = (await runner.runMutation("notes:seed", {})) as string;
    const seed = "shared-entropy-seed";
    await store.mutation.write({ args: "test", mutationId: seed, name: "notes:mix" });
    await runner.runMutation(
      "notes:mix",
      { id },
      { mutationIsFresh: true, mutationId: seed, pushCall: { fn: "notes:mix", rngSeed: seed } },
    );

    const stream = seedEntropy(seed);
    expect(draws).toEqual([
      stream.random(),
      stream.uuid(),
      [...stream.fill(new Uint8Array(10))],
      stream.random(),
      [...stream.fill(new Uint8Array(3))],
      stream.uuid(),
    ]);
    expect(draws[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("a concurrent query does not observe a replaying mutation's shimmed clock", async () => {
    const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
    type Model = DataModelFromSchemaDefinition<typeof schema>;
    const { mutation, query } = defineFunctions<Model>().replicated;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => (signalPaused = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const notes = {
      seed: mutation({ args: {}, handler: (ctx) => ctx.db.insert("notes", { body: "seed" }) }),
      mix: mutation({
        args: { id: v.id("notes") },
        handler: async (ctx, args) => {
          signalPaused();
          await barrier;
          await ctx.db.patch(args.id, { body: "next" });
          return null;
        },
      }),
      now: query({ args: {}, handler: () => readTime() }),
    };
    const store = new FakeStorage();
    const runner = createRunner({ notes }, store, toStoreSchema(schema));
    const id = (await runner.runMutation("notes:seed", {})) as string;
    const seed = "gate-clock-seed";
    await store.mutation.write({ args: "test", mutationId: seed, name: "notes:mix" });
    const realBaseline = readTime();
    const mutationRun = runner.runMutation(
      "notes:mix",
      { id },
      { mutationIsFresh: true, mutationId: seed, pushCall: { fn: "notes:mix", rngSeed: seed } },
    );
    await paused;
    const queryRun = runner.runQuery("notes:now", {});
    release();
    await mutationRun;
    expect((await queryRun) as number).toBeGreaterThanOrEqual(realBaseline);
  });

  test("a concurrent query cannot advance a replaying mutation's entropy stream", async () => {
    const runOnce = async (concurrentQuery: boolean): Promise<string[]> => {
      const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
      type Model = DataModelFromSchemaDefinition<typeof schema>;
      const { mutation, query } = defineFunctions<Model>().replicated;
      const draws: string[] = [];
      let signalPaused!: () => void;
      const paused = new Promise<void>((resolve) => (signalPaused = resolve));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const notes = {
        seed: mutation({ args: {}, handler: (ctx) => ctx.db.insert("notes", { body: "seed" }) }),
        mix: mutation({
          args: { id: v.id("notes") },
          handler: async (ctx, args) => {
            draws.push(crypto.randomUUID());
            signalPaused();
            await barrier;
            draws.push(crypto.randomUUID());
            await ctx.db.patch(args.id, { body: "next" });
            return null;
          },
        }),
        noise: query({ args: {}, handler: () => `${Math.random()}:${crypto.randomUUID()}` }),
      };
      const store = new FakeStorage();
      const runner = createRunner({ notes }, store, toStoreSchema(schema));
      const id = (await runner.runMutation("notes:seed", {})) as string;
      const seed = "gate-stream-seed";
      await store.mutation.write({ args: "test", mutationId: seed, name: "notes:mix" });
      const mutationRun = runner.runMutation(
        "notes:mix",
        { id },
        { mutationIsFresh: true, mutationId: seed, pushCall: { fn: "notes:mix", rngSeed: seed } },
      );
      await paused;
      const queryRun = concurrentQuery ? runner.runQuery("notes:noise", {}) : undefined;
      release();
      await mutationRun;
      await queryRun;
      return draws;
    };
    const withQuery = await runOnce(true);
    const withoutQuery = await runOnce(false);
    expect(withQuery).toEqual(withoutQuery);
    const reference = seedEntropy("gate-stream-seed");
    expect(withQuery).toEqual([reference.uuid(), reference.uuid()]);
  });

  test("a replaying mutation, a concurrent query, and a second mutation all settle", async () => {
    const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
    type Model = DataModelFromSchemaDefinition<typeof schema>;
    const { mutation, query } = defineFunctions<Model>().replicated;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => (signalPaused = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const notes = {
      seed: mutation({ args: {}, handler: (ctx) => ctx.db.insert("notes", { body: "seed" }) }),
      mix: mutation({
        args: { id: v.id("notes") },
        handler: async (ctx, args) => {
          signalPaused();
          await barrier;
          await ctx.db.patch(args.id, { body: "a" });
          await ctx.db.patch(args.id, { body: "b" });
          return null;
        },
      }),
      bump: mutation({
        args: { id: v.id("notes") },
        handler: (ctx, args) => ctx.db.patch(args.id, { body: "bumped" }),
      }),
      count: query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect() }),
    };
    const store = new FakeStorage();
    const runner = createRunner({ notes }, store, toStoreSchema(schema));
    const id = (await runner.runMutation("notes:seed", {})) as string;
    const seed = "gate-liveness-seed";
    await store.mutation.write({ args: "test", mutationId: seed, name: "notes:mix" });
    const mutationRun = runner.runMutation(
      "notes:mix",
      { id },
      { mutationIsFresh: true, mutationId: seed, pushCall: { fn: "notes:mix", rngSeed: seed } },
    );
    await paused;
    const queryRun = runner.runQuery("notes:count", {});
    const secondRun = runner.runMutation("notes:bump", { id });
    release();
    await expect(Promise.all([mutationRun, queryRun, secondRun])).resolves.toHaveLength(3);
  });

  test("keeps Math.random-only sequences identical and reuses them on retry", () => {
    const legacy = (seed: string): (() => number) => {
      let state = 2_166_136_261;
      for (let index = 0; index < seed.length; index += 1) {
        state = Math.imul(state ^ seed.charCodeAt(index), 16_777_619);
      }
      return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const legacyDraw = legacy("retry-seed");
    const first = seedEntropy("retry-seed");
    const second = seedEntropy("retry-seed");
    for (let index = 0; index < 32; index += 1) {
      const value = first.random();
      expect(value).toBe(legacyDraw());
      expect(second.random()).toBe(value);
    }
  });

  const platformFillError = (view: ArrayBufferView): { name: string; dom: boolean } => {
    try {
      crypto.getRandomValues(view as never);
    } catch (error) {
      return { name: (error as Error).name, dom: error instanceof DOMException };
    }
    return { name: "no throw", dom: false };
  };

  test("rejects non-integer getRandomValues views with the platform error", async () => {
    const platform = platformFillError(new Float64Array(2));
    expect(platform).toEqual({ name: "TypeMismatchError", dom: true });
    const shimmed = await withEntropy(1, "guard-seed", () =>
      platformFillError(new Float64Array(2)),
    );
    expect(shimmed).toEqual(platform);
    expect(
      await withEntropy(1, "guard-seed", () => platformFillError(new Float32Array(2))),
    ).toEqual(platform);
    expect(
      await withEntropy(1, "guard-seed", () => platformFillError(new DataView(new ArrayBuffer(8)))),
    ).toEqual(platform);
  });

  test("rejects getRandomValues views over 65536 bytes with the platform error", async () => {
    const platform = platformFillError(new Uint8Array(65_537));
    expect(platform).toEqual({ name: "QuotaExceededError", dom: true });
    const shimmed = await withEntropy(1, "guard-seed", () =>
      platformFillError(new Uint8Array(65_537)),
    );
    expect(shimmed).toEqual(platform);
    const drawn = await withEntropy(1, "guard-seed", () => {
      expect(platformFillError(new Uint8Array(65_536))).toEqual({ name: "no throw", dom: false });
      return Math.random();
    });
    const reference = seedEntropy("guard-seed");
    reference.fill(new Uint8Array(65_536));
    expect(drawn).toBe(reference.random());
  });

  test("embedded CRDT fields use intent APIs after insert", { timeout: 30_000 }, async () => {
    const crdtSchema = defineSchema({
      docs: defineTable({
        title: v.string(),
        body: e.text(),
        votes: e.count(),
        tags: e.set(v.string()),
      }),
    });
    type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
    const { mutation: crdtMutation, query: crdtQuery } =
      defineFunctions<CrdtDataModel>().replicated;
    const docs = {
      seed: crdtMutation({
        args: {},
        handler: (ctx) =>
          ctx.db.insert("docs", { body: "", tags: ["draft"], title: "first", votes: 0 }),
      }),
      seedUnicode: crdtMutation({
        args: {},
        handler: (ctx) =>
          ctx.db.insert("docs", { body: "a🙂b", tags: [], title: "unicode", votes: 0 }),
      }),
      applyIntents: crdtMutation({
        args: { id: v.id("docs") },
        handler: async (ctx, args) => {
          await ctx.db.count.add("docs", args.id, "votes", 3);
          await ctx.db.set.add("docs", args.id, "tags", "urgent");
          await ctx.db.set.delete("docs", args.id, "tags", "draft");
          await ctx.db.text.splice("docs", args.id, "body", {
            delete: 0,
            index: 0,
            insert: "hello",
          });
        },
      }),
      patchBody: crdtMutation({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.patch(args.id, { body: "direct" }),
      }),
      spliceUnicode: crdtMutation({
        args: { id: v.id("docs") },
        handler: (ctx, args) =>
          ctx.db.text.splice("docs", args.id, "body", { delete: 1, index: 3, insert: "c" }),
      }),
      replaceDoc: crdtMutation({
        args: { id: v.id("docs") },
        handler: (ctx, args) =>
          ctx.db.replace(args.id, { body: "direct", tags: [], title: "replaced", votes: 1 }),
      }),
      get: crdtQuery({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.get(args.id),
      }),
    };
    const crdtStoreSchema = toStoreSchema(crdtSchema);
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_crdt_fields.db"));
    await store.setup(crdtStoreSchema);
    const r = createRunner({ docs }, store, crdtStoreSchema);

    const id = (await r.runMutation("docs:seed", {})) as string;
    await r.runMutation("docs:applyIntents", { id });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({
      body: "hello",
      tags: ["urgent"],
      title: "first",
      votes: 3,
    });
    const unicodeId = (await r.runMutation("docs:seedUnicode", {})) as string;
    await r.runMutation("docs:spliceUnicode", { id: unicodeId });
    expect(await r.runQuery("docs:get", { id: unicodeId })).toMatchObject({ body: "a🙂c" });
    await expect(r.runMutation("docs:patchBody", { id })).rejects.toThrow(
      "patch cannot write embedded text field docs.body",
    );
    await expect(r.runMutation("docs:replaceDoc", { id })).rejects.toThrow(
      "replace cannot write embedded CRDT fields on docs",
    );
  });

  test("text.splice enforces an optional whole-base fingerprint", { timeout: 30_000 }, async () => {
    const crdtSchema = defineSchema({
      docs: defineTable({ body: e.text(), title: v.string() }),
    });
    type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
    const { mutation: crdtMutation, query: crdtQuery } =
      defineFunctions<CrdtDataModel>().replicated;
    const docs = {
      seed: crdtMutation({
        args: {},
        handler: (ctx) => ctx.db.insert("docs", { body: "hello", title: "t" }),
      }),
      splice: crdtMutation({
        args: { id: v.id("docs"), base: v.optional(v.string()) },
        handler: (ctx, args) =>
          ctx.db.text.splice("docs", args.id, "body", {
            delete: 0,
            index: 5,
            insert: " world",
            base: args.base,
          }),
      }),
      get: crdtQuery({ args: { id: v.id("docs") }, handler: (ctx, args) => ctx.db.get(args.id) }),
    };
    const storeSchema = toStoreSchema(crdtSchema);
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_text_base.db"));
    await store.setup(storeSchema);
    const r = createRunner({ docs }, store, storeSchema);

    const id = (await r.runMutation("docs:seed", {})) as string;
    await expect(
      r.runMutation("docs:splice", { id, base: await textBase("goodbye") }),
    ).rejects.toThrow(/docs\.body changed since this edit was computed/);
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "hello" });

    await r.runMutation("docs:splice", { id, base: await textBase("hello") });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "hello world" });

    await r.runMutation("docs:splice", { id });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "hello world world" });
  });

  test(
    "createTextField's clean write carries the materialized body's base and never false-rejects",
    { timeout: 30_000 },
    async () => {
      const crdtSchema = defineSchema({
        docs: defineTable({ body: e.text(), title: v.string() }),
      });
      type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
      const { mutation: crdtMutation, query: crdtQuery } =
        defineFunctions<CrdtDataModel>().replicated;
      const docs = {
        seed: crdtMutation({
          args: { body: v.string() },
          handler: (ctx, args) => ctx.db.insert("docs", { body: args.body, title: "t" }),
        }),
        write: crdtMutation({
          args: {
            id: v.id("docs"),
            title: v.optional(v.string()),
            splices: v.array(
              v.object({
                base: v.optional(v.string()),
                delete: v.number(),
                index: v.number(),
                insert: v.string(),
              }),
            ),
          },
          handler: async (ctx, args) => {
            for (const s of args.splices) {
              await ctx.db.text.splice("docs", args.id, "body", {
                delete: s.delete,
                index: s.index,
                insert: s.insert,
                base: s.base,
              });
            }
            if (args.title !== undefined) await ctx.db.patch(args.id, { title: args.title });
            const doc = await ctx.db.get(args.id);
            if (!doc) throw new Error("document not found");
            return doc;
          },
        }),
        get: crdtQuery({ args: { id: v.id("docs") }, handler: (ctx, args) => ctx.db.get(args.id) }),
      };
      const storeSchema = toStoreSchema(crdtSchema);
      const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_text_field_clean.db"));
      await store.setup(storeSchema);
      const r = createRunner({ docs }, store, storeSchema);

      const seeded = "hello world";
      const id = (await r.runMutation("docs:seed", { body: seeded })) as string;
      const readBody = async () =>
        ((await r.runQuery("docs:get", { id })) as { body: string }).body;

      let materialized = await readBody();
      expect(materialized).toBe(seeded);
      expect(await textBase(materialized)).toBe(await textBase(seeded));

      let writes = 0;
      const field = createTextField<{ body: string; title: string }>({
        read: () => materialized,
        write: async (splice, base) => {
          writes += 1;
          const doc = (await r.runMutation("docs:write", {
            id,
            splices: [{ ...splice, base }],
          })) as { body: string; title: string };
          materialized = await readBody();
          return doc;
        },
        extract: (result) => result.body,
        delayMs: 1,
        maxLatencyMs: 4,
      });

      const desired = "hello brave world";
      field.queue(desired);
      field.flush();
      await field.settle();

      expect(writes).toBe(1);
      expect(field.isDirty).toBe(false);
      expect(await readBody()).toBe(desired);
      field.close();
    },
  );

  test(
    "createTextField rebases once when the store diverges under a pending write",
    { timeout: 30_000 },
    async () => {
      const crdtSchema = defineSchema({
        docs: defineTable({ body: e.text(), title: v.string() }),
      });
      type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
      const { mutation: crdtMutation, query: crdtQuery } =
        defineFunctions<CrdtDataModel>().replicated;
      const docs = {
        seed: crdtMutation({
          args: { body: v.string() },
          handler: (ctx, args) => ctx.db.insert("docs", { body: args.body, title: "t" }),
        }),
        write: crdtMutation({
          args: {
            id: v.id("docs"),
            splices: v.array(
              v.object({
                base: v.optional(v.string()),
                delete: v.number(),
                index: v.number(),
                insert: v.string(),
              }),
            ),
          },
          handler: async (ctx, args) => {
            for (const s of args.splices) {
              await ctx.db.text.splice("docs", args.id, "body", {
                delete: s.delete,
                index: s.index,
                insert: s.insert,
                base: s.base,
              });
            }
            const doc = await ctx.db.get(args.id);
            if (!doc) throw new Error("document not found");
            return doc;
          },
        }),
        get: crdtQuery({ args: { id: v.id("docs") }, handler: (ctx, args) => ctx.db.get(args.id) }),
      };
      const storeSchema = toStoreSchema(crdtSchema);
      const store = await NativeStore.openWith(
        nativeModule().Store,
        tmp("rt_text_field_rebase.db"),
      );
      await store.setup(storeSchema);
      const r = createRunner({ docs }, store, storeSchema);

      const seeded = "hello world";
      const id = (await r.runMutation("docs:seed", { body: seeded })) as string;
      const readBody = async () =>
        ((await r.runQuery("docs:get", { id })) as { body: string }).body;

      let materialized = await readBody();
      let writes = 0;
      let injected = false;
      const field = createTextField<{ body: string; title: string }>({
        read: () => materialized,
        write: async (splice, base) => {
          writes += 1;
          if (!injected) {
            injected = true;
            await r.runMutation("docs:write", {
              id,
              splices: [{ delete: 0, index: seeded.length, insert: "!" }],
            });
            materialized = await readBody();
          }
          const doc = (await r.runMutation("docs:write", {
            id,
            splices: [{ ...splice, base }],
          })) as { body: string; title: string };
          materialized = await readBody();
          return doc;
        },
        extract: (result) => result.body,
        delayMs: 1,
        maxLatencyMs: 4,
      });

      const desired = "hello brave world";
      field.queue(desired);
      field.flush();
      await field.settle();

      expect(writes).toBe(2);
      expect(field.isDirty).toBe(false);
      expect(await readBody()).toBe(desired);
      field.close();
    },
  );

  test(
    "count.add enforces finite deltas, results, and a zero no-op",
    { timeout: 30_000 },
    async () => {
      const crdtSchema = defineSchema({
        docs: defineTable({ title: v.string(), votes: e.count() }),
      });
      type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
      const { mutation: crdtMutation, query: crdtQuery } =
        defineFunctions<CrdtDataModel>().replicated;
      const docs = {
        seed: crdtMutation({
          args: { votes: v.number() },
          handler: (ctx, args) => ctx.db.insert("docs", { title: "first", votes: args.votes }),
        }),
        seedBad: crdtMutation({
          args: {},
          handler: (ctx) => ctx.db.insert("docs", { title: "bad", votes: Number.NaN }),
        }),
        add: crdtMutation({
          args: { id: v.id("docs"), delta: v.number() },
          handler: (ctx, args) => ctx.db.count.add("docs", args.id, "votes", args.delta),
        }),
        get: crdtQuery({
          args: { id: v.id("docs") },
          handler: (ctx, args) => ctx.db.get(args.id),
        }),
      };
      const crdtStoreSchema = toStoreSchema(crdtSchema);
      const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_crdt_count.db"));
      await store.setup(crdtStoreSchema);
      const r = createRunner({ docs }, store, crdtStoreSchema);

      const id = (await r.runMutation("docs:seed", { votes: 0 })) as string;
      await r.runMutation("docs:add", { id, delta: 5 });
      expect(await r.runQuery("docs:get", { id })).toMatchObject({ votes: 5 });

      await expect(r.runMutation("docs:add", { id, delta: Number.NaN })).rejects.toThrow(
        "delta must be a finite number",
      );
      await expect(
        r.runMutation("docs:add", { id, delta: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow("delta must be a finite number");
      expect(await r.runQuery("docs:get", { id })).toMatchObject({ votes: 5 });

      await r.runMutation("docs:add", { id, delta: 0 });
      expect(await r.runQuery("docs:get", { id })).toMatchObject({ votes: 5 });
      await r.runMutation("docs:add", { id, delta: 2 });
      expect(await r.runQuery("docs:get", { id })).toMatchObject({ votes: 7 });

      const big = (await r.runMutation("docs:seed", { votes: Number.MAX_VALUE })) as string;
      await expect(r.runMutation("docs:add", { id: big, delta: Number.MAX_VALUE })).rejects.toThrow(
        "result must be a finite number",
      );
      expect(await r.runQuery("docs:get", { id: big })).toMatchObject({ votes: Number.MAX_VALUE });
      await r.runMutation("docs:add", { id: big, delta: -1 });
      expect(await r.runQuery("docs:get", { id: big })).toMatchObject({
        votes: Number.MAX_VALUE - 1,
      });

      await expect(r.runMutation("docs:seedBad", {})).rejects.toThrow(
        "initial count must be a finite number",
      );
      await store.close();
    },
  );

  test(
    "text.splice uses UTF-16 offsets and guards scalar boundaries",
    { timeout: 30_000 },
    async () => {
      const crdtSchema = defineSchema({
        docs: defineTable({ title: v.string(), body: e.text() }),
      });
      type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
      const { mutation: crdtMutation, query: crdtQuery } =
        defineFunctions<CrdtDataModel>().replicated;
      const docs = {
        seed: crdtMutation({
          args: { body: v.string() },
          handler: (ctx, args) => ctx.db.insert("docs", { title: "first", body: args.body }),
        }),
        seedBad: crdtMutation({
          args: {},
          handler: (ctx) => ctx.db.insert("docs", { title: "bad", body: "x\uDC00" }),
        }),
        splice: crdtMutation({
          args: { id: v.id("docs"), index: v.number(), delete: v.number(), insert: v.string() },
          handler: (ctx, args) =>
            ctx.db.text.splice("docs", args.id, "body", {
              index: args.index,
              delete: args.delete,
              insert: args.insert,
            }),
        }),
        appendAtLength: crdtMutation({
          args: { id: v.id("docs"), insert: v.string() },
          handler: async (ctx, args) => {
            const document = await ctx.db.get(args.id);
            const body = (document?.body ?? "") as string;
            await ctx.db.text.splice("docs", args.id, "body", {
              index: body.length,
              delete: 0,
              insert: args.insert,
            });
          },
        }),
        get: crdtQuery({
          args: { id: v.id("docs") },
          handler: (ctx, args) => ctx.db.get(args.id),
        }),
      };
      const crdtStoreSchema = toStoreSchema(crdtSchema);
      const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_crdt_splice.db"));
      await store.setup(crdtStoreSchema);
      const r = createRunner({ docs }, store, crdtStoreSchema);

      const astral = (await r.runMutation("docs:seed", { body: "a🙂b" })) as string;
      await r.runMutation("docs:appendAtLength", { id: astral, insert: "!" });
      expect(await r.runQuery("docs:get", { id: astral })).toMatchObject({ body: "a🙂b!" });

      const targeted = (await r.runMutation("docs:seed", { body: "a🙂b" })) as string;
      await r.runMutation("docs:splice", { id: targeted, index: 1, delete: 2, insert: "" });
      expect(await r.runQuery("docs:get", { id: targeted })).toMatchObject({ body: "ab" });

      const guard = (await r.runMutation("docs:seed", { body: "a🙂b" })) as string;
      await expect(
        r.runMutation("docs:splice", { id: guard, index: 2, delete: 0, insert: "X" }),
      ).rejects.toThrow("Unicode scalar boundary");
      await expect(
        r.runMutation("docs:splice", { id: guard, index: 1, delete: 1, insert: "X" }),
      ).rejects.toThrow("Unicode scalar boundary");
      await expect(
        r.runMutation("docs:splice", { id: guard, index: 0, delete: 0, insert: "\uD800" }),
      ).rejects.toThrow("unpaired surrogate");
      expect(await r.runQuery("docs:get", { id: guard })).toMatchObject({ body: "a🙂b" });
      await r.runMutation("docs:splice", { id: guard, index: 1, delete: 0, insert: "Z" });
      expect(await r.runQuery("docs:get", { id: guard })).toMatchObject({ body: "aZ🙂b" });

      const bmp = (await r.runMutation("docs:seed", { body: "hello" })) as string;
      await r.runMutation("docs:splice", { id: bmp, index: 1, delete: 2, insert: "i" });
      expect(await r.runQuery("docs:get", { id: bmp })).toMatchObject({ body: "hilo" });

      await expect(r.runMutation("docs:seedBad", {})).rejects.toThrow(
        "initial text is not valid Unicode",
      );
      await store.close();
    },
  );

  test("applies multiple splices in one mutation using progressive indices and replays idempotently", async () => {
    const crdtSchema = defineSchema({
      docs: defineTable({ title: v.string(), body: e.text() }),
    });
    type CrdtDataModel = DataModelFromSchemaDefinition<typeof crdtSchema>;
    const { mutation: crdtMutation, query: crdtQuery } =
      defineFunctions<CrdtDataModel>().replicated;
    const docs = {
      seed: crdtMutation({
        args: { body: v.string() },
        handler: (ctx, args) => ctx.db.insert("docs", { title: "first", body: args.body }),
      }),
      writeSplices: crdtMutation({
        args: {
          id: v.id("docs"),
          splices: v.array(v.object({ index: v.number(), delete: v.number(), insert: v.string() })),
        },
        handler: async (ctx, args) => {
          for (const splice of args.splices) {
            await ctx.db.text.splice("docs", args.id, "body", splice);
          }
        },
      }),
      get: crdtQuery({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.get(args.id),
      }),
    };
    const crdtStoreSchema = toStoreSchema(crdtSchema);
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_crdt_multisplice.db"));
    await store.setup(crdtStoreSchema);
    const r = createRunner({ docs }, store, crdtStoreSchema);

    const id = (await r.runMutation("docs:seed", { body: "ab" })) as string;
    await r.runMutation(
      "docs:writeSplices",
      {
        id,
        splices: [
          { index: 1, delete: 0, insert: "CD" },
          { index: 4, delete: 0, insert: "E" },
          { index: 0, delete: 0, insert: "Z" },
        ],
      },
      { mutationIsFresh: true, mutationId: "mutation:multi-splice" },
    );
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "ZaCDbE" });

    await r.runMutation(
      "docs:writeSplices",
      {
        id,
        splices: [
          { index: 1, delete: 0, insert: "CD" },
          { index: 4, delete: 0, insert: "E" },
          { index: 0, delete: 0, insert: "Z" },
        ],
      },
      { mutationId: "mutation:multi-splice" },
    );
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "ZaCDbE" });

    await store.close();
  });

  test("initializes a new optional CRDT field through an ordinary migration mutation", async () => {
    const conversionSchema = defineSchema({
      docs: defineTable({
        legacyBody: v.string(),
        body: v.optional(e.text()),
      }),
    });
    type ConversionDataModel = DataModelFromSchemaDefinition<typeof conversionSchema>;
    const { mutation: conversionMutation, query: conversionQuery } =
      defineFunctions<ConversionDataModel>().replicated;
    const docs = {
      seed: conversionMutation({
        args: { legacyBody: v.string() },
        handler: (ctx, args) => ctx.db.insert("docs", { legacyBody: args.legacyBody }),
      }),
      convert: conversionMutation({
        visibility: "internal",
        args: { id: v.id("docs") },
        handler: async (ctx, args) => {
          const document = await ctx.db.get(args.id);
          if (!document || document.body !== undefined) return null;
          await ctx.db.text.splice("docs", args.id, "body", {
            index: 0,
            delete: 0,
            insert: document.legacyBody,
          });
          return null;
        },
      }),
      get: conversionQuery({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.get(args.id),
      }),
    };
    const storeSchema = toStoreSchema(conversionSchema);
    expect(storeSchema.tables[0]?.crdtFields).toMatchObject([{ field: "body", kind: "text" }]);
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_crdt_conversion.db"));
    await store.setup(storeSchema);
    const r = createRunner({ docs }, store, storeSchema);
    const id = (await r.runMutation("docs:seed", { legacyBody: "converted" })) as string;
    await r.runMutation("docs:convert", { id }, { allowInternal: true });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "converted" });
    await store.close();
  });

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

  test("runs a local-only administrative migration as an ordinary internal mutation", async () => {
    const r = await runner("rt_local_migration.db");
    await r.runMutation("messages:send", { channel: "old", body: "a" });
    await r.runMutation("messages:send", { channel: "old", body: "b" });
    expect(
      await r.runMutation(
        "messages:migrateChannel",
        { from: "old", to: "new" },
        { allowInternal: true },
      ),
    ).toBe(2);
    expect(await r.runQuery("messages:list", { channel: "old" })).toEqual([]);
    expect(await r.runQuery("messages:list", { channel: "new" })).toHaveLength(2);
  });

  test("native direct one-docWrite path preserves mutation id replay", async () => {
    const r = await runner("rt_one_doc_write_mutation_id.db");
    const first = (await r.runMutation(
      "messages:send",
      { channel: "direct", body: "hi" },
      { mutationIsFresh: true, mutationId: "mutation:direct-one-docWrite" },
    )) as string;
    const second = (await r.runMutation(
      "messages:send",
      { channel: "direct", body: "hi" },
      { mutationId: "mutation:direct-one-docWrite" },
    )) as string;

    expect(second).toBe(first);
    const list = (await r.runQuery("messages:list", { channel: "direct" })) as { body: string }[];
    expect(list.map((m) => m.body)).toEqual(["hi"]);
  });

  test("indexed query selects only the matching channel", async () => {
    const r = await runner("rt_index.db");
    await r.runMutation("messages:send", { channel: "a", body: "1" });
    await r.runMutation("messages:send", { channel: "b", body: "2" });
    await r.runMutation("messages:send", { channel: "a", body: "3" });

    const a = (await r.runQuery("messages:list", { channel: "a" })) as { body: string }[];
    expect(a.map((m) => m.body)).toEqual(["1", "3"]);
  });

  test("insert then data-only patch keeps indexed columns in the same mutation", async () => {
    const r = await runner("rt_insert_patch_keeps_index.db");
    const id = (await r.runMutation("messages:insertThenPatchBody", {
      channel: "same-mutation",
    })) as string;

    const list = (await r.runQuery("messages:list", { channel: "same-mutation" })) as Array<{
      _id: string;
      body: string;
    }>;
    expect(list.map((doc) => [doc._id, doc.body])).toEqual([[id, "after"]]);
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

  test("component revs fail clearly in the local runtime", async () => {
    const components = componentsGeneric() as unknown as {
      child: {
        writer: { add: unknown };
      };
    };
    const bridge = {
      callComponent: mutation({
        args: {},
        handler: async (ctx) => {
          await ctx.runMutation(components.child.writer.add as never, { body: "component" });
          return null;
        },
      }),
    };
    const r = createRunner({ bridge }, new FakeStorage(), storeSchema);

    await expect(r.runMutation("bridge:callComponent", {})).rejects.toThrow(
      "Unsupported component function reference",
    );
  });

  test("installed revision component calls execute locally and commit atomically", async () => {
    const components = componentsGeneric() as unknown as {
      embedded: {
        rev: {
          create: unknown;
          list: unknown;
          restore: unknown;
        };
      };
    };
    const bridge = {
      savepoint: mutation({
        args: { id: v.id("messages"), fail: v.boolean() },
        handler: async (ctx, args) => {
          const document = await ctx.db.get(args.id);
          if (!document) throw new Error("Document not found.");
          const { _id, _creationTime, ...value } = document;
          const revision = await ctx.runMutation(components.embedded.rev.create as never, {
            table: "messages",
            rowId: args.id,
            value,
            deleted: false,
          });
          if (args.fail) throw new Error("rollback");
          return revision;
        },
      }),
      history: query({
        args: { id: v.id("messages") },
        handler: (ctx, args) =>
          ctx.runQuery(components.embedded.rev.list as never, {
            table: "messages",
            rowId: args.id,
            paginationOpts: { cursor: null, numItems: 10 },
          }),
      }),
      edit: mutation({
        args: { id: v.id("messages"), body: v.string() },
        handler: (ctx, args) => ctx.db.patch(args.id, { body: args.body }),
      }),
      restore: mutation({
        args: { id: v.id("messages"), revId: v.string(), write: v.boolean() },
        handler: async (ctx, args) => {
          const revision = (await ctx.runMutation(components.embedded.rev.restore as never, {
            table: "messages",
            rowId: args.id,
            revId: args.revId,
          })) as { deleted: boolean; value?: Record<string, unknown> };
          if (args.write) {
            if (revision.deleted) await ctx.db.delete(args.id);
            else await ctx.db.replace(args.id, revision.value as never);
          }
          return null;
        },
      }),
    };
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_component_rev.db"));
    await store.setup(storeSchema);
    const r = createRunner({ bridge, messages }, store, storeSchema);
    const id = (await r.runMutation("messages:send", {
      channel: "local",
      body: "draft",
    })) as string;

    const revision = (await r.runMutation("bridge:savepoint", { id, fail: false })) as {
      revId: string;
      value: { body: string };
    };
    expect(revision.revId).toBeTruthy();
    expect(revision.value.body).toBe("draft");

    await expect(r.runMutation("bridge:savepoint", { id, fail: true })).rejects.toThrow("rollback");
    const history = (await r.runQuery("bridge:history", { id })) as { page: unknown[] };
    expect(history.page).toHaveLength(1);

    await r.runMutation("bridge:edit", { id, body: "changed" });
    await expect(
      r.runMutation("bridge:restore", { id, revId: revision.revId, write: false }),
    ).rejects.toThrow("matching document replace");
    await r.runMutation("bridge:restore", { id, revId: revision.revId, write: true });
    const restored = (await r.runQuery("messages:get", { id })) as { body: string };
    expect(restored.body).toBe("draft");
    const restoredHistory = (await r.runQuery("bridge:history", { id })) as { page: unknown[] };
    expect(restoredHistory.page).toHaveLength(2);
  });

  test("revision restore replaces the opaque CRDT head atomically", async () => {
    const revisionSchema = defineSchema({
      docs: defineTable({ body: e.text(), title: v.string() }),
    });
    type RevisionDataModel = DataModelFromSchemaDefinition<typeof revisionSchema>;
    const { mutation: revisionMutation, query: revisionQuery } =
      defineFunctions<RevisionDataModel>().replicated;
    const components = componentsGeneric() as unknown as {
      embedded: { rev: { create: unknown; restore: unknown } };
    };
    const docs = {
      seed: revisionMutation({
        args: {},
        handler: (ctx) => ctx.db.insert("docs", { body: "", title: "draft" }),
      }),
      edit: revisionMutation({
        args: { id: v.id("docs"), index: v.number(), insert: v.string() },
        handler: (ctx, args) =>
          ctx.db.text.splice("docs", args.id, "body", {
            index: args.index,
            delete: 0,
            insert: args.insert,
          }),
      }),
      savepoint: revisionMutation({
        args: { id: v.id("docs") },
        handler: async (ctx, args) => {
          const document = await ctx.db.get(args.id);
          if (!document) throw new Error("Document not found.");
          return await ctx.runMutation(components.embedded.rev.create as never, {
            table: "docs",
            rowId: args.id,
            value: { body: document.body, title: document.title },
            deleted: false,
          });
        },
      }),
      editAndSavepoint: revisionMutation({
        args: { id: v.id("docs"), index: v.number(), insert: v.string() },
        handler: async (ctx, args) => {
          await ctx.db.text.splice("docs", args.id, "body", {
            index: args.index,
            delete: 0,
            insert: args.insert,
          });
          const document = await ctx.db.get(args.id);
          if (!document) throw new Error("Document not found.");
          return await ctx.runMutation(components.embedded.rev.create as never, {
            table: "docs",
            rowId: args.id,
            value: { body: document.body, title: document.title },
            deleted: false,
          });
        },
      }),
      restore: revisionMutation({
        args: { id: v.id("docs"), revId: v.string() },
        handler: async (ctx, args) => {
          const revision = (await ctx.runMutation(components.embedded.rev.restore as never, {
            table: "docs",
            rowId: args.id,
            revId: args.revId,
          })) as { deleted: boolean; value?: { body: string; title: string } };
          if (revision.deleted || !revision.value) throw new Error("Revision is deleted.");
          await ctx.db.replace(args.id, revision.value);
        },
      }),
      get: revisionQuery({
        args: { id: v.id("docs") },
        handler: (ctx, args) => ctx.db.get(args.id),
      }),
    };
    const revisionStoreSchema = toRuntimeStoreSchema(revisionSchema);
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_component_crdt_rev.db"));
    await store.setup(revisionStoreSchema);
    const r = createRunner({ docs }, store, revisionStoreSchema);

    const id = (await r.runMutation("docs:seed", {})) as string;
    const empty = (await r.runMutation("docs:savepoint", { id })) as { revId: string };
    await r.runMutation("docs:edit", { id, index: 0, insert: "hello" });
    const saved = (await r.runMutation("docs:savepoint", { id })) as { revId: string };
    await r.runMutation("docs:edit", { id, index: 5, insert: " world" });
    await r.runMutation("docs:restore", { id, revId: saved.revId });
    await r.runMutation("docs:edit", { id, index: 5, insert: "!" });

    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "hello!" });
    await r.runMutation("docs:restore", { id, revId: empty.revId });
    await r.runMutation("docs:edit", { id, index: 0, insert: "fresh" });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "fresh" });
    const sameMutation = (await r.runMutation("docs:editAndSavepoint", {
      id,
      index: 5,
      insert: " now",
    })) as { revId: string };
    await r.runMutation("docs:edit", { id, index: 9, insert: " later" });
    await r.runMutation("docs:restore", { id, revId: sameMutation.revId });
    expect(await r.runQuery("docs:get", { id })).toMatchObject({ body: "fresh now" });
    await store.close();
  });

  test("devtools snapshot skips Convex system entrypoint modules", async () => {
    const r = createRunner(
      {
        "convex.config": async () => {
          throw new Error(
            "Component definition does not have the required componentDefinitionPath property. This code only works in Convex runtime.",
          );
        },
        messages,
      },
      new FakeStorage(),
      storeSchema,
    );

    const snapshot = (await r.devtools({ kind: "snapshot" })) as {
      functions: Array<{ path: string }>;
    };
    const paths = snapshot.functions.map((fn) => fn.path);

    expect(paths).toContain("messages:list");
    expect(paths).not.toContain("convex.config");
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

  test("delete preserves the hosted id needed by remote replay", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_delete_hosted_id.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const id = (await r.runMutation("messages:send", { channel: "c", body: "x" })) as string;
    await store.id.write({
      table: "messages",
      localId: id,
      mapping: "mapped",
      convexId: "hosted-message-id",
      createdTime: 10,
      updatedTime: 20,
    });

    await r.runMutation("messages:remove", { id });

    expect(await store.id.read("messages", id)).toMatchObject({
      localId: id,
      mapping: "deleted",
      convexId: "hosted-message-id",
      createdTime: 10,
    });
    await store.close();
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

    expect(decodeError("mutation failed: x").message).toBe("mutation failed: x");
  });

  test("local auth identity is null when unauthenticated", async () => {
    const r = await runner("rt_auth_null.db");
    expect(await r.runQuery("messages:localAuthIdentity", {})).toBeNull();
  });

  test("auth snapshots and action execution work locally", async () => {
    const r = await runner("rt_action_auth.db");
    const auth = {
      issuer: "https://issuer.example",
      subject: "user-1",
      tokenIdentifier: "issuer|user-1",
    };
    expect(await r.runQuery("messages:localAuthIdentity", {}, { auth })).toMatchObject(auth);
    expect(await r.runAction("messages:echoAction", { text: "hello" }, { auth })).toMatchObject({
      identity: auth,
      text: "hello",
    });
    await expect(r.runAction("messages:internalAction", {})).rejects.toThrow("internal");
    expect(await r.runAction("messages:internalAction", {}, { allowInternal: true })).toBe(
      "secret",
    );
    expect(await r.runMutation("messages:mutationRunActionType", {})).toBe("undefined");
    expect(await r.runQuery("messages:queryStorageStoreType", {})).toBe("undefined");
    expect(await r.runMutation("messages:mutationStorageShape", {})).toEqual({
      delete: "function",
      generateUploadUrl: "function",
      get: "undefined",
      store: "undefined",
    });
    expect(await r.runAction("messages:actionStorageShape", {})).toEqual({
      delete: "function",
      generateUploadUrl: "function",
      get: "function",
      store: "function",
    });
  });

  test("local file storage stores metadata and enqueues a pending upload", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_storage_files.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const events: EmbeddedEvent[] = [];
    const unsubscribe = r.subscribeEvents?.((event) => events.push(event));
    const result = (await r.runAction("messages:storeFile", { text: "abc" })) as {
      id: string;
    };
    expect(result.id.startsWith("_storage|")).toBe(true);
    expect(
      (await r.runQuery("messages:storageMetadata", { id: result.id })) as { size: number },
    ).toMatchObject({ size: 3, contentType: "text/plain" });
    expect((await store.blob.read(result.id))?.byteLength).toBe(3);
    expect((await store.file.read(result.id))?.contentType).toBe("text/plain");
    expect(await store.id.read("_storage", result.id)).toMatchObject({
      localId: result.id,
      mapping: "local",
    });
    expect(await store.upload.read()).toMatchObject([
      { lease: "pending", localStorageId: result.id, size: 3 },
    ]);

    await expect(r.runAction("messages:storeFileThenFail", {})).rejects.toThrow("after file store");
    expect(await store.upload.read()).toHaveLength(2);

    const deleted = (await r.runAction("messages:storeThenDeleteFile", {})) as string;
    expect(await store.blob.read(deleted)).toBeNull();
    expect(await store.file.read(deleted)).toBeUndefined();
    expect(await store.id.read("_storage", deleted)).toMatchObject({
      localId: deleted,
      mapping: "deleted",
    });
    const deleteEvent = events.find(
      (event): event is EmbeddedStorageEvent =>
        event.type === "storage" &&
        event.deletes.some((row) => row.table === "_storage" && row.id === deleted),
    );
    expect(deleteEvent?.docWrites).toContainEqual(
      expect.objectContaining({
        id: `_storage|${deleted}`,
        row: expect.objectContaining({ localId: deleted, mapping: "deleted" }),
        table: "_id_mappings",
      }),
    );
    unsubscribe?.();
    await store.close();
  });

  test("scheduler state changes emit persisted rows", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_scheduler_events.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const events: EmbeddedEvent[] = [];
    const unsubscribe = r.subscribeEvents?.((event) => events.push(event));

    const jobId = (await r.runMutation("messages:scheduleImmediate", {
      channel: "sched-events",
    })) as string;
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "scheduler" &&
            event.docWrites.some(
              (docWrite) => docWrite.id === jobId && docWrite.row.state === "complete",
            ),
        ),
      "timed out waiting for scheduler completion event",
    );

    const schedulerRows = events.flatMap((event): EmbeddedDataWrite[] =>
      event.type === "scheduler" ? event.docWrites : [],
    );
    expect(schedulerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: jobId,
          row: expect.objectContaining({ state: "pending" }),
          table: "_scheduled_jobs",
        }),
        expect.objectContaining({
          id: jobId,
          row: expect.objectContaining({ state: "running" }),
          table: "_scheduled_jobs",
        }),
        expect.objectContaining({
          id: jobId,
          row: expect.objectContaining({ state: "complete" }),
          table: "_scheduled_jobs",
        }),
      ]),
    );
    expect(await r.runQuery("messages:list", { channel: "sched-events" })).toMatchObject([
      { body: "scheduled" },
    ]);
    unsubscribe?.();
    await store.close();
  });

  test("remote-enabled runners persist schedule intent without executing it locally", async () => {
    const store = await NativeStore.openWith(
      nativeModule().Store,
      tmp("rt_remote_scheduler_intent.db"),
    );
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema, { remote: true });

    const jobId = (await r.runMutation("messages:scheduleImmediate", {
      channel: "remote-schedule",
    })) as string;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await r.runQuery("messages:list", { channel: "remote-schedule" })).toEqual([]);
    expect(await store.schedule.read()).toMatchObject([{ jobId, state: "pending" }]);
    await store.close();
  });

  test("a local-only schedule is visible in the store after its mutation commits", async () => {
    const store = await NativeStore.openWith(
      nativeModule().Store,
      tmp("rt_schedule_local_atomic.db"),
    );
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);

    const jobId = (await r.runMutation("messages:scheduleChild", {
      channel: "local-atomic",
    })) as string;

    expect(await store.schedule.read()).toMatchObject([{ jobId, state: "pending" }]);
    await store.close();
  });

  test("scheduling rolls back when the enclosing mutation throws", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_schedule_rollback.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const events: EmbeddedEvent[] = [];
    const unsubscribe = r.subscribeEvents?.((event) => events.push(event));

    await expect(
      r.runMutation("messages:scheduleThenThrow", { channel: "rollback" }),
    ).rejects.toThrow("schedule rollback boom");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.some((event) => event.type === "scheduler")).toBe(false);
    expect(await store.schedule.read()).toEqual([]);
    expect(await r.runQuery("messages:list", { channel: "rollback" })).toEqual([]);
    unsubscribe?.();
    await store.close();
  });

  test("scheduler cancel emits a canceled docWrite", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_scheduler_cancel.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const events: EmbeddedEvent[] = [];
    const unsubscribe = r.subscribeEvents?.((event) => events.push(event));

    const jobId = (await r.runMutation("messages:scheduleChild", {
      channel: "sched-cancel",
    })) as string;
    await r.runMutation("messages:cancelScheduled", { id: jobId });

    const schedulerEvent = events.find(
      (event): event is EmbeddedSchedulerEvent =>
        event.type === "scheduler" &&
        event.docWrites.some(
          (docWrite) => docWrite.id === jobId && docWrite.row.state === "canceled",
        ),
    );
    expect(schedulerEvent?.deletes).toEqual([]);
    expect(await store.schedule.read()).toMatchObject([{ jobId, state: "canceled" }]);
    unsubscribe?.();
    await store.close();
  });

  test("devtools clear emits row delete events", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_clear_events.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const events: EmbeddedEvent[] = [];
    const unsubscribe = r.subscribeEvents?.((event) => events.push(event));

    const messageId = (await r.runMutation("messages:send", {
      body: "clear",
      channel: "clear",
    })) as string;
    const file = (await r.runAction("messages:storeFile", { text: "abc" })) as { id: string };
    const jobId = (await r.runMutation("messages:scheduleChild", { channel: "clear" })) as string;
    await r.devtools({ kind: "clearData" });

    const clearEvent = events.find(
      (event): event is EmbeddedDataEvent =>
        event.type === "data" &&
        event.deletes.some((row) => row.table === "messages" && row.id === messageId) &&
        event.deletes.some((row) => row.table === "_storage" && row.id === file.id) &&
        event.deletes.some((row) => row.table === "_scheduled_jobs" && row.id === jobId),
    );
    expect(clearEvent?.deletes).toEqual(
      expect.arrayContaining([
        { id: messageId, table: "messages" },
        { id: file.id, table: "_storage" },
        { id: file.id, table: "_pending_uploads" },
        { id: `_storage|${file.id}`, table: "_id_mappings" },
        { id: jobId, table: "_scheduled_jobs" },
      ]),
    );
    expect(await store.schedule.read()).toEqual([]);
    unsubscribe?.();
    await store.close();
  });

  test("scheduler persists local jobs", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_scheduler.db"));
    await store.setup(storeSchema);
    const r = createRunner({ messages }, store, storeSchema);
    const jobId = (await r.runMutation("messages:scheduleChild", { channel: "sched" })) as string;
    expect(jobId.startsWith("_scheduled_functions|")).toBe(true);
    expect(await store.schedule.lease.write(getTimerTime() + 20_000)).toMatchObject({
      jobId,
      kind: "mutation",
      name: "messages:childInsert",
      state: "running",
    });
    await store.close();
  });

  test("scheduler pumps due jobs when the runner opens", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_scheduler_resume.db"));
    await store.setup(storeSchema);
    const now = getTimerTime();
    await store.schedule.write({
      args: encode({ body: "scheduled", channel: "resume" }),
      createdTime: now - 2,
      dueTime: now - 1,
      jobId: "job:resume",
      kind: "mutation",
      name: "messages:childInsert",
      state: "pending",
      updatedTime: now - 2,
    });
    const r = createRunner({ messages }, store, storeSchema);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await r.runQuery("messages:list", { channel: "resume" })).toMatchObject([
      { body: "scheduled" },
    ]);
    expect(await store.schedule.lease.write(getTimerTime() + 1_000)).toBeUndefined();
    await store.close();
  });

  test("scheduler wakes persisted future jobs after the runner opens", async () => {
    const store = await NativeStore.openWith(
      nativeModule().Store,
      tmp("rt_scheduler_future_resume.db"),
    );
    await store.setup(storeSchema);
    const now = getTimerTime();
    await store.schedule.write({
      args: encode({ body: "scheduled", channel: "future-resume" }),
      createdTime: now,
      dueTime: now + 30,
      jobId: "job:future-resume",
      kind: "mutation",
      name: "messages:childInsert",
      state: "pending",
      updatedTime: now,
    });
    const r = createRunner({ messages }, store, storeSchema);

    await waitFor(
      async () =>
        ((await r.runQuery("messages:list", { channel: "future-resume" })) as unknown[]).length ===
        1,
      "scheduler did not wake a persisted future job",
    );
    expect(await store.schedule.read()).toMatchObject([
      { jobId: "job:future-resume", state: "complete" },
    ]);
    await store.close();
  });

  test("scheduler reclaims expired running jobs after restart", async () => {
    const store = await NativeStore.openWith(
      nativeModule().Store,
      tmp("rt_scheduler_running_resume.db"),
    );
    await store.setup(storeSchema);
    const now = Math.trunc(getTimerTime());
    await store.schedule.write({
      args: encode({ body: "scheduled", channel: "running-resume" }),
      createdTime: now - 10,
      dueTime: now - 10,
      jobId: "job:running-resume",
      kind: "mutation",
      leaseUntil: now + 30,
      name: "messages:childInsert",
      state: "running",
      updatedTime: now - 5,
    });
    expect(await store.schedule.read()).toMatchObject([
      { jobId: "job:running-resume", leaseUntil: now + 30, state: "running" },
    ]);
    const r = createRunner({ messages }, store, storeSchema);

    await waitFor(
      async () =>
        ((await r.runQuery("messages:list", { channel: "running-resume" })) as unknown[]).length ===
        1,
      "scheduler did not reclaim an expired running job",
    );
    expect(await store.schedule.read()).toMatchObject([
      { jobId: "job:running-resume", state: "complete" },
    ]);
    await store.close();
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

  test("indexed take returns a shareable frozen result", async () => {
    const r = await runner("rt_query_take_shareable.db");
    await r.runMutation("messages:send", { channel: "q", body: "a" });
    await r.runMutation("messages:send", { channel: "q", body: "b" });

    const result = (await r.runQuery("messages:listTake", {
      channel: "q",
      limit: 2,
    })) as Array<{ body: string }>;

    expect(result.map((message) => message.body)).toEqual(["a", "b"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(() => {
      result.push({ body: "mutated" });
    }).toThrow(TypeError);
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

  test("replicated nested app mutations fail closed before staging writes", async () => {
    const r = await runner("rt_nested_mutation.db");
    await expect(
      r.runMutation("messages:parentCallsChildThenFails", { channel: "nested" }),
    ).rejects.toThrow("cannot call nested app mutations");
    expect(await r.runQuery("messages:list", { channel: "nested" })).toEqual([]);
    await expect(
      r.runMutation("messages:parentCallsChildThenReads", { channel: "nested" }),
    ).rejects.toThrow("cannot call nested app mutations");
    expect(await r.runQuery("messages:list", { channel: "nested" })).toEqual([]);
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

  test("pagination does not repeat its boundary after authoritative creation time adoption", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    const firstId = (await r.runMutation("messages:send", {
      channel: "cursor-rebase",
      body: "first",
    })) as string;
    await r.runMutation("messages:send", { channel: "cursor-rebase", body: "second" });
    const first = (await r.runQuery("messages:page", {
      channel: "cursor-rebase",
      paginationOpts: { cursor: null, numItems: 1 },
    })) as { continueCursor: string; page: Array<{ body: string }> };

    store.rebaseCreationTime(firstId, 1_000_000);
    const second = (await r.runQuery("messages:page", {
      channel: "cursor-rebase",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    })) as { page: Array<{ body: string }> };

    expect(second.page.map((document) => document.body)).toEqual(["second"]);
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

  test("fresh mutation id commits terminal row without a pre-handler begin", async () => {
    const store = new FakeStorage();
    const r = createRunner({ messages }, store, storeSchema);
    const first = (await r.runMutation(
      "messages:send",
      { channel: "fresh-dedupe", body: "a" },
      { mutationIsFresh: true, mutationId: "mutation:fresh-success" },
    )) as string;

    expect(store.mutationWriteCalls).toBe(0);

    const second = (await r.runMutation(
      "messages:send",
      { channel: "fresh-dedupe", body: "a" },
      { mutationId: "mutation:fresh-success" },
    )) as string;

    expect(second).toBe(first);
    expect(store.mutationWriteCalls).toBe(1);
    const seen = (await r.runQuery("messages:list", { channel: "fresh-dedupe" })) as {
      body: string;
    }[];
    expect(seen.map((message) => message.body)).toEqual(["a"]);
  });

  test("fresh mutation id failures remain terminal and replayable", async () => {
    let calls = 0;
    const store = new FakeStorage();
    const r = createRunner(
      {
        messages: {
          ...messages,
          failFresh: mutation({
            args: {},
            handler: () => {
              calls += 1;
              throw new Error("fresh failed");
            },
          }),
        },
      },
      store,
      storeSchema,
    );

    await expect(
      r.runMutation(
        "messages:failFresh",
        {},
        {
          mutationIsFresh: true,
          mutationId: "mutation:fresh-failed",
        },
      ),
    ).rejects.toThrow("fresh failed");
    expect(calls).toBe(1);
    expect(store.mutationWriteCalls).toBe(1);

    await expect(
      r.runMutation("messages:failFresh", {}, { mutationId: "mutation:fresh-failed" }),
    ).rejects.toThrow("fresh failed");
    expect(calls).toBe(1);
    expect(store.mutationWriteCalls).toBe(2);
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

  test("runner accepts generated-style revs with explicit placement metadata", async () => {
    const r = createRunner(
      {
        real: {
          list: Object.assign(
            queryGeneric({
              args: { channel: v.string() },
              handler: (_ctx, args) => [{ body: args.channel }],
            }),
            { __embeddedPlacement: "replicated" as const },
          ),
          send: Object.assign(
            mutationGeneric({
              args: { channel: v.string() },
              handler: (_ctx, args) => args.channel,
            }),
            { __embeddedPlacement: "replicated" as const },
          ),
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

  test("string revs support default exports", async () => {
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

  test("return validation names stale local ids and the browser storage reset path", async () => {
    const store = await NativeStore.openWith(nativeModule().Store, tmp("rt_stale_id.db"));
    await store.setup(storeSchema);
    await store.commit({
      deletes: [],
      docWrites: [
        {
          cols: { channel: "general" },
          creationTime: 1,
          data: { body: "stale", channel: "general" },
          id: "tags|badlocalrow000000000000000000",
          table: "messages",
        },
      ],
    });
    const r = createRunner({ messages }, store, storeSchema);

    await expect(r.runQuery("messages:strictList", {})).rejects.toThrow(
      'return value[0]._id must be an id for table messages; received "tags|badlocalrow000000000000000000"',
    );
    await expect(r.runQuery("messages:strictList", {})).rejects.toThrow(
      "Clearing only localStorage does not reset the embedded database.",
    );
    await store.close();
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

  test("onUpdate skips data-only patches outside scanned rows", async () => {
    const r = await runner("rt_on_update_data_only_hidden.db");
    const first = (await r.runMutation("messages:send", {
      body: "first",
      channel: "live",
    })) as string;
    const second = (await r.runMutation("messages:send", {
      body: "second",
      channel: "live",
    })) as string;
    const updates: { body: string }[][] = [];
    const off = r.onUpdate("messages:listTake", { channel: "live", limit: 1 }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect((await nextUpdate(updates, 0)).map((m) => m.body)).toEqual(["first"]);
    await r.runMutation("messages:rename", { id: second, body: "second hidden" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(updates.map((rows) => rows.map((row) => row.body))).toEqual([["first"]]);

    await r.runMutation("messages:rename", { id: first, body: "first visible" });
    expect((await nextUpdate(updates, 1)).map((m) => m.body)).toEqual(["first visible"]);
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

  test("onUpdate publishes and revokes one exact hosted query subscription", async () => {
    const remoteScopes: RemoteScope[] = [];
    const remote: RemoteSurface = {
      close: async () => undefined,
      start: async () => undefined,
      scope: {
        write: async (scope) => {
          remoteScopes.push(scope);
        },
      },
    };
    const store = new FakeStorage(remote);
    const r = createRunner({ messages }, store, storeSchema);
    await r.runMutation("messages:send", {
      body: "a",
      channel: "live",
    });
    await r.runMutation("messages:send", { body: "hidden", channel: "other" });
    const updates: { body: string }[][] = [];

    const off = r.onUpdate("messages:list", { channel: "live" }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect((await nextUpdate(updates, 0)).map((row) => row.body)).toEqual(["a"]);
    await waitFor(
      () => remoteScopes.at(-1)?.subscriptions.length === 1,
      "watch did not publish its hosted query subscription",
    );
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      {
        fn: "messages:list",
        args: { channel: "live" },
        resultCacheKey: expect.any(String),
      },
    ]);

    r.invalidate(["messages"], "remote");
    await waitFor(() => updates.length > 0, "watch did not remain active");
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      {
        fn: "messages:list",
        args: { channel: "live" },
        resultCacheKey: expect.any(String),
      },
    ]);

    off();
    await waitFor(() => remoteScopes.at(-1)?.subscriptions.length === 0, "watch was not revoked");
  });

  test("onUpdate publishes overlapping queries as independent subscriptions", async () => {
    const remoteScopes: RemoteScope[] = [];
    const remote: RemoteSurface = {
      close: async () => undefined,
      start: async () => undefined,
      scope: {
        write: async (scope) => {
          remoteScopes.push(scope);
        },
      },
    };
    const store = new FakeStorage(remote);
    const r = createRunner({ messages }, store, storeSchema);
    const stopLive = r.onUpdate("messages:list", { channel: "live" }, () => undefined);
    const stopOther = r.onUpdate("messages:list", { channel: "other" }, () => undefined);
    await waitFor(() => remoteScopes.at(-1)?.subscriptions.length === 2, "queries were collapsed");
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      { fn: "messages:list", args: { channel: "live" }, resultCacheKey: expect.any(String) },
      { fn: "messages:list", args: { channel: "other" }, resultCacheKey: expect.any(String) },
    ]);
    stopLive();
    await waitFor(
      () => remoteScopes.at(-1)?.subscriptions.length === 1,
      "removed query subscription remained active",
    );
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      { fn: "messages:list", args: { channel: "other" }, resultCacheKey: expect.any(String) },
    ]);
    stopOther();
  });

  test("onUpdate translates validator-declared query ids in remote scope args", async () => {
    const remoteScopes: RemoteScope[] = [];
    const remote: RemoteSurface = {
      close: async () => undefined,
      start: async () => undefined,
      scope: {
        write: async (scope) => {
          remoteScopes.push(scope);
        },
      },
    };
    const store = new FakeStorage(remote);
    const r = createRunner({ messages }, store, storeSchema);
    const localId = (await r.runMutation("messages:send", {
      body: "mapped",
      channel: "live",
    })) as string;
    await store.id.write({
      table: "messages",
      localId,
      convexId: "messages|server-query-id",
      mapping: "mapped",
      createdTime: 1,
      updatedTime: 2,
    });

    const off = r.onUpdate("messages:get", { id: localId }, () => undefined);
    await waitFor(
      () =>
        (remoteScopes.at(-1)?.subscriptions[0]?.args as { id?: unknown } | undefined)?.id ===
        "messages|server-query-id",
      "watch scope did not translate its query id",
    );
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      {
        fn: "messages:get",
        args: { id: "messages|server-query-id" },
        resultCacheKey: expect.any(String),
      },
    ]);
    off();
  });

  test("onUpdate publishes an offline pagination boundary for pre-subscription resolution", async () => {
    const remoteScopes: RemoteScope[] = [];
    const remote: RemoteSurface = {
      close: async () => undefined,
      start: async () => undefined,
      scope: {
        write: async (scope) => {
          remoteScopes.push(scope);
        },
      },
    };
    const store = new FakeStorage(remote);
    const r = createRunner({ messages }, store, storeSchema);
    await r.runMutation("messages:send", { body: "a", channel: "pages" });
    await r.runMutation("messages:send", { body: "b", channel: "pages" });
    const first = (await r.runQuery("messages:page", {
      channel: "pages",
      paginationOpts: { cursor: null, numItems: 1 },
    })) as { continueCursor: string; page: Array<{ _id: string }> };
    const boundary = first.page[0]!._id;
    await store.id.write({
      table: "messages",
      localId: boundary,
      convexId: "hosted-boundary",
      mapping: "mapped",
      createdTime: 1,
      updatedTime: 1,
    });
    const off = r.onUpdate(
      "messages:page",
      {
        channel: "pages",
        paginationOpts: { cursor: first.continueCursor, numItems: 1 },
      },
      () => undefined,
    );
    await waitFor(
      () => remoteScopes.at(-1)?.subscriptions[0]?.cursor !== undefined,
      "pagination watch did not publish its offline boundary",
    );
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      {
        fn: "messages:page",
        args: { channel: "pages", paginationOpts: { cursor: null, numItems: 1 } },
        resultCacheKey: expect.any(String),
        cursor: {
          path: "/paginationOpts/cursor",
          boundary: {
            rowId: "hosted-boundary",
            values: expect.arrayContaining([
              { field: "_id", value: "hosted-boundary" },
              { field: "channel", value: "pages" },
            ]),
          },
        },
      },
    ]);
    expect(remoteScopes.at(-1)?.subscriptions[0]?.cursor?.boundary.values).not.toContainEqual(
      expect.objectContaining({ field: "_creationTime" }),
    );
    off();
  });

  test("remote invalidation discovers newly matching rows without changing the subscription", async () => {
    const remoteScopes: RemoteScope[] = [];
    const remote: RemoteSurface = {
      close: async () => undefined,
      start: async () => undefined,
      scope: {
        write: async (scope) => {
          remoteScopes.push(scope);
        },
      },
    };
    const store = new FakeStorage(remote);
    const r = createRunner({ messages }, store, storeSchema);
    await r.runMutation("messages:send", {
      body: "local",
      channel: "live",
    });
    const updates: { body: string }[][] = [];

    const off = r.onUpdate("messages:list", { channel: "live" }, (value) => {
      updates.push(value as { body: string }[]);
    });

    expect((await nextUpdate(updates, 0)).map((row) => row.body)).toEqual(["local"]);
    await waitFor(
      () => remoteScopes.at(-1)?.subscriptions.length === 1,
      "watch did not publish its query subscription",
    );

    const remoteId = "messages|remote-live";
    const hiddenRemoteId = "messages|remote-hidden";
    const serverRemoteId = "messages|server-live";
    const hiddenServerRemoteId = "messages|server-hidden";
    await store.commit(
      {
        deletes: [],
        idMappings: [
          {
            table: "messages",
            localId: remoteId,
            convexId: serverRemoteId,
            mapping: "mapped",
            createdTime: 100,
            updatedTime: 100,
          },
          {
            table: "messages",
            localId: hiddenRemoteId,
            convexId: hiddenServerRemoteId,
            mapping: "mapped",
            createdTime: 101,
            updatedTime: 101,
          },
        ],
        docWrites: [
          {
            cols: { channel: "live" },
            creationTime: 100,
            data: { body: "remote", channel: "live" },
            id: remoteId,
            table: "messages",
          },
          {
            cols: { channel: "other" },
            creationTime: 101,
            data: { body: "hidden", channel: "other" },
            id: hiddenRemoteId,
            table: "messages",
          },
        ],
      },
      { changes: "include", source: "remote" },
    );
    r.invalidate(["messages"], "remote");

    expect((await nextUpdate(updates, 1)).map((row) => row.body)).toEqual(["local", "remote"]);
    await waitFor(
      () => remoteScopes.at(-1)?.subscriptions.length === 1,
      "watch subscription changed after remote invalidation",
    );
    expect(remoteScopes.at(-1)?.subscriptions).toEqual([
      { fn: "messages:list", args: { channel: "live" }, resultCacheKey: expect.any(String) },
    ]);

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
