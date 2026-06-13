import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { EmbeddedClient } from "../../src/client";
import { defineFunctions } from "../../src/runtime/functions";
import type { Runner } from "../../src/runtime/runner";
import {
  ConvexEmbeddedClient,
  createConvexEmbeddedClientForTest,
  type ConvexEmbeddedClientOptions,
} from "../../src/node/client";
import { nativeModule } from "./native";

const schema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
    profile: v.optional(v.object({ email: v.string() })),
  })
    .index("by_channel", ["channel"])
    .index("by_email", ["profile.email"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const { query, mutation } = defineFunctions<DataModel>();

const messages = {
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", args),
  }),
  sendSlow: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: async (ctx, args) => {
      await sleep(25);
      return ctx.db.insert("messages", args);
    },
  }),
  failSlow: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: async () => {
      await sleep(25);
      throw new Error("mutation failed");
    },
  }),
  sendProfile: mutation({
    args: { channel: v.string(), body: v.string(), email: v.string() },
    handler: (ctx, args) =>
      ctx.db.insert("messages", {
        channel: args.channel,
        body: args.body,
        profile: { email: args.email },
      }),
  }),
  list: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect(),
  }),
  byEmail: query({
    args: { email: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_email", (q) => q.eq("profile.email", args.email))
        .collect(),
  }),
  byCreationTime: query({
    args: {},
    handler: (ctx) => ctx.db.query("messages").withIndex("by_creation_time").collect(),
  }),
  byId: query({
    args: { id: v.id("messages") },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_id", (q) => q.eq("_id", args.id))
        .first(),
  }),
  byChannelAfterCreationTime: query({
    args: { channel: v.string(), after: v.number() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) =>
          q.eq("channel", args.channel).gt("_creationTime", args.after),
        )
        .take(1),
  }),
};

const list = makeFunctionReference<"query", { channel: string }, { body: string }[]>(
  "messages:list",
);
const send = makeFunctionReference<"mutation", { channel: string; body: string }, string>(
  "messages:send",
);
const sendSlow = makeFunctionReference<"mutation", { channel: string; body: string }, string>(
  "messages:sendSlow",
);
const failSlow = makeFunctionReference<"mutation", { channel: string; body: string }, string>(
  "messages:failSlow",
);
const sendProfile = makeFunctionReference<
  "mutation",
  { channel: string; body: string; email: string },
  string
>("messages:sendProfile");
const byEmail = makeFunctionReference<"query", { email: string }, { body: string }[]>(
  "messages:byEmail",
);
const byCreationTime = makeFunctionReference<"query", {}, { body: string }[]>(
  "messages:byCreationTime",
);
const byId = makeFunctionReference<
  "query",
  { id: string },
  { body: string; _creationTime: number } | null
>("messages:byId");
const byChannelAfterCreationTime = makeFunctionReference<
  "query",
  { channel: string; after: number },
  { body: string }[]
>("messages:byChannelAfterCreationTime");

describe("ConvexEmbeddedClient", () => {
  test("runs real Convex query and mutation modules through the native adapter shape", async () => {
    const convex = await nativeClient("client_roundtrip");
    await convex.mutation(send, { channel: "general", body: "hi" });
    const result = await convex.query(list, { channel: "general" });
    expect(result.map((doc) => doc.body)).toEqual(["hi"]);
    await convex.close();
  });

  test("shares query result cache across watch objects", async () => {
    const convex = await nativeClient("client_watch_cache");
    const first = convex.watchQuery(list, { channel: "general" });
    const second = convex.watchQuery(list, { channel: "general" });

    await nextWatch(first);
    expect(first.localQueryResult()).toEqual([]);
    expect(second.localQueryResult()).toEqual([]);

    const changed = waitForWatch(first, () =>
      first.localQueryResult()?.some((doc) => doc.body === "hi"),
    );
    await convex.mutation(send, { channel: "general", body: "hi" });
    await changed;
    expect(second.localQueryResult()?.map((doc) => doc.body)).toEqual(["hi"]);
    await convex.close();
  });

  test("applies optimistic updates to local query results while a mutation is pending", async () => {
    const convex = await nativeClient("client_optimistic_success");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);

    const optimistic = waitForWatch(watch, () =>
      watch.localQueryResult()?.some((doc) => doc.body === "optimistic:hi"),
    );
    const pending = convex.mutation(
      sendSlow,
      { channel: "general", body: "hi" },
      {
        optimisticUpdate: (localStore, args) => {
          const current = localStore.getQuery(list, { channel: args.channel }) ?? [];
          localStore.setQuery(list, { channel: args.channel }, [
            ...current,
            { body: `optimistic:${args.body}` },
          ]);
        },
      },
    );

    await optimistic;
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["optimistic:hi"]);
    await pending;
    await waitForWatch(watch, () => watch.localQueryResult()?.some((doc) => doc.body === "hi"));
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["hi"]);
    await convex.close();
  });

  test("replays remaining optimistic updates when an earlier mutation settles", async () => {
    const convex = await nativeClient("client_optimistic_replay");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);

    const first = convex.mutation(
      sendSlow,
      { channel: "general", body: "first" },
      {
        optimisticUpdate: (localStore, args) => {
          const current = localStore.getQuery(list, { channel: args.channel }) ?? [];
          localStore.setQuery(list, { channel: args.channel }, [
            ...current,
            { body: `optimistic:${args.body}` },
          ]);
        },
      },
    );
    const second = convex.mutation(
      sendSlow,
      { channel: "general", body: "second" },
      {
        optimisticUpdate: (localStore, args) => {
          const current = localStore.getQuery(list, { channel: args.channel }) ?? [];
          localStore.setQuery(list, { channel: args.channel }, [
            ...current,
            { body: `optimistic:${args.body}` },
          ]);
        },
      },
    );

    await waitForWatch(watch, () => watch.localQueryResult()?.length === 2);
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual([
      "optimistic:first",
      "optimistic:second",
    ]);

    await first;
    await waitForWatch(watch, () =>
      watch.localQueryResult()?.some((doc) => doc.body === "optimistic:second"),
    );
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual([
      "first",
      "optimistic:second",
    ]);

    await second;
    await waitForWatch(watch, () => watch.localQueryResult()?.some((doc) => doc.body === "second"));
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["first", "second"]);
    await convex.close();
  });

  test("rolls back optimistic query results when a mutation fails", async () => {
    const convex = await nativeClient("client_optimistic_failure");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);

    const optimistic = waitForWatch(watch, () =>
      watch.localQueryResult()?.some((doc) => doc.body === "optimistic:fail"),
    );
    const pending = convex.mutation(
      failSlow,
      { channel: "general", body: "fail" },
      {
        optimisticUpdate: (localStore, args) => {
          localStore.setQuery(list, { channel: args.channel }, [
            { body: `optimistic:${args.body}` },
          ]);
        },
      },
    );

    await optimistic;
    await expect(pending).rejects.toThrow("mutation failed");
    expect(watch.localQueryResult()).toEqual([]);
    await convex.close();
  });

  test("rolls back partial optimistic edits when the optimistic update throws", async () => {
    const convex = await nativeClient("client_optimistic_throw");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);

    await expect(
      convex.mutation(
        sendSlow,
        { channel: "general", body: "hi" },
        {
          optimisticUpdate: (localStore, args) => {
            localStore.setQuery(list, { channel: args.channel }, [{ body: "partial" }]);
            throw new Error("optimistic failed");
          },
        },
      ),
    ).rejects.toThrow("optimistic failed");
    expect(watch.localQueryResult()).toEqual([]);
    await convex.close();
  });

  test("rejects async optimistic updates and rolls back partial edits", async () => {
    const convex = await nativeClient("client_optimistic_async");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);

    await expect(
      convex.mutation(
        sendSlow,
        { channel: "general", body: "hi" },
        {
          optimisticUpdate: async (localStore, args) => {
            localStore.setQuery(list, { channel: args.channel }, [{ body: "partial" }]);
          },
        },
      ),
    ).rejects.toThrow("Optimistic update handlers must be synchronous.");
    expect(watch.localQueryResult()).toEqual([]);
    await convex.close();
  });

  test("rethrows an optimistic update that throws undefined", async () => {
    const convex = await nativeClient("client_throw_undefined");
    const watch = convex.watchQuery(list, { channel: "general" });
    await nextWatch(watch);
    await expect(
      convex.mutation(
        sendSlow,
        { channel: "general", body: "hi" },
        {
          optimisticUpdate: () => {
            throw undefined;
          },
        },
      ),
    ).rejects.toBeUndefined();
    expect(watch.localQueryResult()).toEqual([]);
    await convex.close();
  });

  test("double unsubscribe is a no-op and keeps co-subscribers live", async () => {
    const convex = await nativeClient("client_unsub_idempotent");
    const watch = convex.watchQuery(list, { channel: "general" });
    let bCount = 0;
    const offA = watch.onUpdate(() => undefined);
    watch.onUpdate(() => {
      bCount += 1;
    });
    await waitForWatch(watch, () => watch.localQueryResult() !== undefined);
    offA();
    offA();

    const seen = waitForWatch(watch, () =>
      watch.localQueryResult()?.some((doc) => doc.body === "hi"),
    );
    await convex.mutation(send, { channel: "general", body: "hi" });
    await seen;
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["hi"]);
    expect(bCount).toBeGreaterThan(0);
    await convex.close();
  });

  test("supports Convex system indexes and nested index fields", async () => {
    const convex = await nativeClient("client_index_parity");
    const first = await convex.mutation(sendProfile, {
      channel: "general",
      body: "first",
      email: "a@example.com",
    });
    await convex.mutation(sendProfile, {
      channel: "general",
      body: "second",
      email: "b@example.com",
    });
    const firstDoc = await convex.query(byId, { id: first });

    expect(
      (await convex.query(byEmail, { email: "b@example.com" })).map((doc) => doc.body),
    ).toEqual(["second"]);
    expect((await convex.query(byCreationTime, {})).map((doc) => doc.body)).toEqual([
      "first",
      "second",
    ]);
    expect(firstDoc?.body).toBe("first");
    expect(
      (
        await convex.query(byChannelAfterCreationTime, {
          channel: "general",
          after: firstDoc?._creationTime ?? 0,
        })
      ).map((doc) => doc.body),
    ).toEqual(["second"]);
    await convex.close();
  });

  test("evicts query state when the last listener unsubscribes", async () => {
    const convex = await nativeClient("client_eviction");
    const watch = convex.watchQuery(list, { channel: "general" });
    let updates = 0;
    const off = watch.onUpdate(() => {
      updates += 1;
    });
    await waitForWatch(watch, () => watch.localQueryResult() !== undefined);
    expect(watch.localQueryResult()).toEqual([]);

    off();
    expect(watch.localQueryResult()).toEqual([]);
    await convex.close();
    expect(watch.localQueryResult()).toBeUndefined();
    expect(updates).toBeGreaterThan(0);
  });

  test("evicts query state after the only subscriber unsubscribes", async () => {
    const convex = await nativeClient("client_single_evict");
    const watch = convex.watchQuery(list, { channel: "general" });
    await new Promise<void>((resolve) => {
      const off = watch.onUpdate(() => {
        if (watch.localQueryResult() !== undefined) {
          off();
          resolve();
        }
      });
    });
    // The sole subscriber removed itself, so the state is evicted by construction — no cached
    // result survives without a live listener.
    expect(watch.localQueryResult()).toBeUndefined();
    await convex.close();
  });

  test("drops indeterminate optimistic state when a fresh base value arrives", async () => {
    let pushBase: ((value: unknown) => void) | undefined;
    const runner = {
      runQuery: async () => [] as unknown,
      runMutation: async () => {
        const error = new Error("transport lost");
        error.name = "ConvexEmbeddedMutationIndeterminateError";
        throw error;
      },
      onUpdate: (
        _ref: unknown,
        _args: Record<string, unknown>,
        callback: (value: unknown) => void,
      ) => {
        pushBase = callback;
        callback([]);
        return () => undefined;
      },
    };
    const convex = createClientWithRunner(runner as never);
    const watch = convex.watchQuery(list, { channel: "general" });
    watch.onUpdate(() => undefined);
    await waitForWatch(watch, () => watch.localQueryResult() !== undefined);

    await expect(
      convex.mutation(
        send,
        { channel: "general", body: "hi" },
        {
          optimisticUpdate: (localStore, args) => {
            localStore.setQuery(list, { channel: args.channel }, [
              { body: `optimistic:${args.body}` },
            ]);
          },
        },
      ),
    ).rejects.toThrow("transport lost");
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["optimistic:hi"]);
    pushBase?.([{ body: "hi" }]);
    expect(watch.localQueryResult()?.map((doc) => doc.body)).toEqual(["hi"]);
    await convex.close();
  });

  test("close stops existing watches and rejects future work", async () => {
    const convex = await nativeClient("client_close");
    const watch = convex.watchQuery(list, { channel: "general" });
    const off = watch.onUpdate(() => undefined);
    await convex.close();
    off();

    await expect(convex.query(list, { channel: "general" })).rejects.toThrow(
      "ConvexEmbeddedClient has already been closed.",
    );
    expect(() => convex.watchQuery(list, { channel: "general" })).toThrow(
      "ConvexEmbeddedClient has already been closed.",
    );
  });

  test("loads the default native artifact through ConvexEmbeddedClient", async () => {
    const { ConvexEmbeddedClient: DistConvexEmbeddedClient } = (await import(
      new URL("../../dist/node.mjs", import.meta.url).href
    )) as typeof import("../../src/node/client");
    const convex = new DistConvexEmbeddedClient(options("client_native_default"));
    await convex.mutation(send, { channel: "general", body: "hi" });
    const result = await convex.query(list, { channel: "general" });
    expect(result.map((doc) => doc.body)).toEqual(["hi"]);
    await convex.close();
  });
});

async function nativeClient(name: string): Promise<ConvexEmbeddedClient> {
  return createConvexEmbeddedClientForTest(options(name), nativeModule());
}

function createClientWithRunner(runner: Runner): EmbeddedClient {
  return new EmbeddedClient({ runner });
}

function options(name: string): ConvexEmbeddedClientOptions {
  return { schema, modules: { messages }, path: tmp(`${name}.db`) };
}

/**
 * Stays subscribed for the test's duration: a query's local state lives exactly as long as it
 * has listeners, so unsubscribing inside the callback would evict the state under test.
 * `client.close()` tears the subscription down.
 */
function nextWatch(watch: { onUpdate(callback: () => void): () => void }): Promise<void> {
  return new Promise((resolve) => {
    watch.onUpdate(() => {
      resolve();
    });
  });
}

function waitForWatch(
  watch: { onUpdate(callback: () => void): () => void },
  done: () => boolean | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (done()) {
      resolve();
      return;
    }
    watch.onUpdate(() => {
      if (done()) {
        resolve();
      }
    });
  });
}

function tmp(name: string): string {
  const path = join(tmpdir(), name);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
