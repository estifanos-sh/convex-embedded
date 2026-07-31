import type { ComponentApi } from "../../src/component/_generated/component";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { defineLocal } from "../../src/local";
import { defineEmbeddedSchema, localTable, replicatedTable } from "../../src/schema";
import { defineEmbedded } from "../../src/server";
import { e } from "../../src/values";

const schema = defineEmbeddedSchema({
  documents: replicatedTable({
    title: v.string(),
    secret: e.remote(v.string()),
    expanded: e.local(v.boolean()),
  }),
  serverNotes: defineTable({ note: v.string() }),
  preferences: localTable({ compact: v.boolean() }),
});

const component = {
  protocol: { installation: {}, pull: { [Symbol.for("toReferencePath")]: "embedded" } },
} as unknown as ComponentApi<"embedded">;

describe("explicit function placement", () => {
  test("exposes placement namespaces without boolean routing", () => {
    const embedded = defineEmbedded({ component, schema });
    expect(Object.keys(embedded).sort()).toEqual([
      "pull",
      "push",
      "remote",
      "replicated",
      "upload",
    ]);

    const replicated = embedded.replicated.query({ args: {}, handler: async () => null });
    const remote = embedded.remote.query({ args: {}, handler: async () => null });
    const local = defineLocal(schema).query({ args: {}, handler: async () => null });
    expect((replicated as unknown as { __embeddedPlacement: string }).__embeddedPlacement).toBe(
      "replicated",
    );
    expect((remote as unknown as { __embeddedPlacement: string }).__embeddedPlacement).toBe(
      "remote",
    );
    expect((local as unknown as { __embeddedPlacement: string }).__embeddedPlacement).toBe("local");
  });

  test("types handlers with their placement-specific document shape", () => {
    const embedded = defineEmbedded({ component, schema });

    embedded.replicated.query({
      args: { id: v.id("documents") },
      handler: async (ctx, { id }) => {
        const document = await ctx.db.get("documents", id);
        void document?.title;
        // @ts-expect-error Remote-only fields do not exist in replicated handlers.
        void document?.secret;
        // @ts-expect-error Device-only fields do not exist in replicated handlers.
        void document?.expanded;
        // @ts-expect-error Remote tables do not exist in replicated handlers.
        await ctx.db.query("serverNotes").collect();
        return null;
      },
    });

    embedded.remote.query({
      args: { id: v.id("documents") },
      handler: async (ctx, { id }) => {
        const document = await ctx.db.get("documents", id);
        void document?.title;
        void document?.secret;
        // @ts-expect-error Device-only fields do not exist in remote handlers.
        void document?.expanded;
        await ctx.db.query("serverNotes").collect();
        // @ts-expect-error Device-only tables do not exist in remote handlers.
        await ctx.db.query("preferences").collect();
        return null;
      },
    });

    defineLocal(schema).query({
      args: { id: v.id("documents") },
      handler: async (ctx, { id }) => {
        const document = await ctx.db.get("documents", id);
        void document?.title;
        void document?.expanded;
        // @ts-expect-error Remote-only fields do not exist in local handlers.
        void document?.secret;
        await ctx.db.query("preferences").collect();
        // @ts-expect-error Remote tables do not exist in local handlers.
        await ctx.db.query("serverNotes").collect();
        return null;
      },
    });
  });

  test("projects omitted fields before replicated query control flow", async () => {
    const embedded = defineEmbedded({ component, schema });
    const query = embedded.replicated.query({
      args: {},
      handler: async (ctx) => await ctx.db.get("documents", "documents:1" as never),
    });
    const handler = (query as unknown as { _handler: Function })._handler;
    const result = await handler(
      {
        db: {
          get: async () => ({
            _id: "documents:1",
            _creationTime: 1,
            title: "visible",
            secret: "server-only",
          }),
          normalizeId: () => "documents:1",
        },
      },
      {},
    );
    expect(result).toEqual({
      _id: "documents:1",
      _creationTime: 1,
      title: "visible",
    });
  });

  test("replicated replace preserves omitted server fields", async () => {
    const embedded = defineEmbedded({ component, schema });
    let replaced: unknown;
    const mutation = embedded.replicated.mutation({
      args: {},
      handler: async (ctx) => {
        const current = await ctx.db.get("documents", "documents:1" as never);
        expect(current).not.toHaveProperty("secret");
        await ctx.db.replace("documents", "documents:1" as never, { title: "next" } as never);
      },
    });
    const handler = (mutation as unknown as { _handler: Function })._handler;
    await handler(
      {
        auth: { getUserIdentity: async () => null },
        db: {
          get: async () => ({
            _id: "documents:1",
            _creationTime: 1,
            title: "before",
            secret: "keep",
          }),
          normalizeId: () => "documents:1",
          replace: async (_table: string, _id: string, value: unknown) => {
            replaced = value;
          },
        },
        meta: {
          getFunctionMetadata: async () => ({ name: "documents:write", visibility: "public" }),
          getRequestMetadata: async () => ({ requestId: "request" }),
        },
        runMutation: async () => null,
      },
      {},
    );
    expect(replaced).toEqual({ title: "next", secret: "keep" });
  });
});
