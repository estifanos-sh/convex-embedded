import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { createConvexEmbeddedClientForTest } from "../../src/node/client";
import { defineFunctions } from "../../src/runtime/functions";
import type { StoreBinding } from "../../src/storage/binding";
import { defineEmbeddedSchema, embeddedTable, toRuntimeStoreSchema } from "../../src/schema";
import { hashValue } from "../../src/hash";
import { nativeModule } from "../testkit/native";

const schema = defineEmbeddedSchema({
  messages: embeddedTable({
    channel: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const { query, mutation } = defineFunctions<DataModel>().replicated;

const modules = {
  send: mutation({
    args: { channel: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", args),
  }),
  edit: mutation({
    args: { id: v.id("messages"), body: v.string() },
    handler: (ctx, args) => ctx.db.patch("messages", args.id, { body: args.body }),
  }),
  list: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel))
        .collect(),
  }),
  identity: query({
    args: {},
    handler: async (ctx) => (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null,
  }),
};

const send = makeFunctionReference<"mutation", { channel: string; body: string }, string>(
  "messages:send",
);
const edit = makeFunctionReference<"mutation", { id: string; body: string }, null>("messages:edit");
const list = makeFunctionReference<"query", { channel: string }, Array<{ body: string }>>(
  "messages:list",
);
const identityRead = makeFunctionReference<"query", Record<string, never>, string | null>(
  "messages:identity",
);

describe("v5 embedded client", () => {
  test("uses ordinary typed query and mutation methods", async () => {
    const client = createClient("ordinary");
    try {
      const id = await client.mutation(send, { channel: "general", body: "one" });
      await client.mutation(edit, { id, body: "two" });
      const rows = await client.query(list, { channel: "general" });
      expect(rows.map((row) => row.body)).toEqual(["two"]);
    } finally {
      await client.close();
    }
  });

  test("reacts through watchQuery", async () => {
    const client = createClient("watch");
    try {
      const watch = client.watchQuery(list, { channel: "general" });
      let observed: string | undefined;
      const update = new Promise<void>((resolve) => {
        const stop = watch.onUpdate(() => {
          if (watch.localQueryResult()?.length === 1) {
            observed = watch.localQueryResult()?.[0]?.body;
            stop();
            resolve();
          }
        });
      });
      await client.mutation(send, { channel: "general", body: "ready" });
      await update;
      expect(observed).toBe("ready");
    } finally {
      await client.close();
    }
  });

  test("does not expose document or revision side channels", async () => {
    const client = createClient("surface");
    try {
      expect("doc" in client).toBe(false);
      expect("rev" in client).toBe(false);
      expect("sync" in client).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("reopens the cached accepted identity and clears it offline", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-auth-${crypto.randomUUID()}.sqlite3`);
    const native = nativeModule();
    const anonymousKey = await hashValue("anonymous");
    const accepted = {
      issuer: "https://issuer.example",
      subject: "cached",
      tokenIdentifier: "issuer|cached",
    };
    const binding = (await native.Store.open(path, path, anonymousKey)) as StoreBinding;
    await binding.setup(toRuntimeStoreSchema(schema));
    if (!binding.identityWrite) throw new Error("Native binding is missing identityWrite.");
    await binding.identityWrite("accepted-key", JSON.stringify(accepted));
    await binding.close();

    const client = createConvexEmbeddedClientForTest(
      { schema, modules: { messages: modules }, path },
      native,
    );
    try {
      await expect(client.query(identityRead, {})).resolves.toBe("issuer|cached");
      client.clearAuth();
      await expect(client.query(identityRead, {})).resolves.toBeNull();
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });
});

function createClient(name: string) {
  const path = join(tmpdir(), `convex-embedded-v5-${name}-${crypto.randomUUID()}.sqlite3`);
  const options = { schema, modules: { messages: modules }, path };
  const client = createConvexEmbeddedClientForTest(options, nativeModule());
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    rmSync(path, { force: true });
  };
  return client;
}
