import type { ComponentApi } from "../../src/component/_generated/component";
import {
  defineSchema,
  defineTable,
  getFunctionName,
  makeFunctionReference,
  type RegisteredQuery,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vitest";

import { defineEmbedded } from "../../src/server";
import { restore as revisionRestore } from "../../src/component/rev";
import { hashDocument, hashValue } from "../../src/hash";
import { pull as componentPull } from "../../src/component/protocol";
import { retire as componentRetire } from "../../src/component/remote/client";
import { completeQueryRows } from "../../src/server/query";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import { seedEntropy } from "../../src/entropy";
import {
  assertIntentField,
  validateCountAdd,
  validateSetField,
  validateTextSplice,
} from "../../src/crdt/intent";
import { count, set, text } from "../../src/values";

const schema = defineSchema({
  documents: defineTable({
    owner: v.string(),
    title: v.string(),
    body: text(),
  }).index("by_owner", ["owner"]),
  counters: defineTable({
    owner: v.string(),
    value: count(),
    members: set(v.string()),
  }),
});

const componentPullReference = {
  [Symbol.for("toReferencePath")]: "components/embedded/protocol:pull",
};
const component = {
  protocol: { installation: {}, pull: componentPullReference },
} as unknown as ComponentApi<"embedded">;

describe("v5 server surface", () => {
  test("requires only the component and app schema", () => {
    const embedded = defineEmbedded({ component, schema });
    expect(Object.keys(embedded).sort()).toEqual([
      "internalMutation",
      "internalQuery",
      "mutation",
      "pull",
      "push",
      "query",
      "upload",
    ]);
  });

  test("mints a hosted upload URL for the remote byte drain", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.upload as unknown as {
        _handler: (
          ctx: unknown,
          args: { localStorageId: string; sha256: string; size: number },
        ) => Promise<unknown>;
      }
    )._handler;
    await expect(
      handler(
        { storage: { generateUploadUrl: async () => "https://upload.example/once" } },
        { localStorageId: "_storage|local", sha256: "a".repeat(64), size: 5 },
      ),
    ).resolves.toEqual({ uploadUrl: "https://upload.example/once" });
  });

  test("reports the deployment protocol during identity negotiation", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.pull as unknown as {
        _handler: (ctx: unknown, args: { request: { kind: "identity" } }) => Promise<unknown>;
      }
    )._handler;

    await expect(
      handler(
        {
          auth: {
            getUserIdentity: async () => null,
          },
        },
        { request: { kind: "identity" } },
      ),
    ).resolves.toMatchObject({
      identity: null,
      protocolVersion: EMBEDDED_PROTOCOL_VERSION,
    });
  });

  test("keeps query transport out of the authored TypeScript surface", () => {
    const embedded = defineEmbedded({ component, schema });
    const query = embedded.query({
      args: { owner: v.string() },
      returns: v.array(v.string()),
      handler: async (_ctx, args) => [args.owner],
    });
    const mutation = embedded.mutation({
      args: { title: v.string() },
      returns: v.string(),
      handler: async (_ctx, args) => args.title,
    });

    const queryArgs = (query as unknown as { exportArgs(): string }).exportArgs();
    const mutationArgs = (mutation as unknown as { exportArgs(): string }).exportArgs();
    expect(queryArgs).toContain("owner");
    expect(queryArgs).toContain("embeddedTransport");
    expect(mutationArgs).toContain("title");
    expect(mutationArgs).not.toContain("embeddedTransport");
    expectTypeOf(query).toMatchTypeOf<RegisteredQuery<"public", { owner: string }, string[]>>();
  });

  test("publishes identical local routing metadata for queries and mutations", () => {
    const embedded = defineEmbedded({ component, schema });
    const localQueryHandler = async () => "local-query";
    const hostedQueryHandler = async () => "hosted-query";
    const localMutationHandler = async () => "local-mutation";
    const hostedMutationHandler = async () => "hosted-mutation";
    const functions = [
      [embedded.query({ args: {}, handler: localQueryHandler }), localQueryHandler, true],
      [
        embedded.query({ local: false, args: {}, handler: hostedQueryHandler }),
        hostedQueryHandler,
        false,
      ],
      [embedded.mutation({ args: {}, handler: localMutationHandler }), localMutationHandler, true],
      [
        embedded.mutation({ local: false, args: {}, handler: hostedMutationHandler }),
        hostedMutationHandler,
        false,
      ],
    ] as const;

    for (const [registered, handler, local] of functions) {
      const metadata = registered as unknown as {
        __embeddedHandler?: unknown;
        __embeddedLocal?: boolean;
      };
      expect(metadata.__embeddedHandler).toBe(handler);
      expect(metadata.__embeddedLocal).toBe(local);
    }
  });

  test("discloses only complete returned documents that the handler read", async () => {
    const embedded = defineEmbedded({ component, schema });
    const document = {
      _id: "documents:1",
      _creationTime: 1,
      owner: "owner-1",
      title: "Visible",
      body: "body",
    };
    const authorization = {
      _id: "documents:2",
      _creationTime: 2,
      owner: "owner-1",
      title: "Private",
      body: "secret",
    };
    const query = embedded.query({
      args: {},
      returns: v.any(),
      handler: async (ctx) => {
        const returned = await ctx.db.get("documents", document._id as never);
        await ctx.db.get("documents", authorization._id as never);
        return {
          copied: { ...returned },
          partial: { _id: authorization._id, _creationTime: authorization._creationTime },
        };
      },
    });
    const rows = new Map([
      [document._id, document],
      [authorization._id, authorization],
    ]);
    const result = await (
      query as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(
      {
        db: {
          get: async (_table: string, id: string) => rows.get(id) ?? null,
          normalizeId: () => null,
        },
        meta: {
          getFunctionMetadata: async () => ({
            name: "documents:list",
            componentPath: "",
            type: "query" as const,
            visibility: "public" as const,
          }),
        },
        runQuery: async () => "components/embedded",
      } as never,
      {
        embeddedTransport: {
          kind: "capture",
          installation: "components/embedded",
          stack: [],
          topLevel: true,
        },
      },
    );

    expect(result).toMatchObject({
      embeddedResult: "eligible",
      rows: [{ table: "documents", rowId: document._id, fields: document, crdtFields: ["body"] }],
    });
  });

  test("completes results without returned documents outside the component", async () => {
    const embedded = defineEmbedded({ component, schema });
    const query = embedded.query({
      args: {},
      returns: v.string(),
      handler: async () => "ready",
    });
    let componentCalls = 0;
    const result = await (
      query as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(
      {
        db: {
          get: async () => null,
          normalizeId: (table: string, id: string) => (table === "documents" ? id : null),
        },
        meta: {
          getFunctionMetadata: async () => ({
            name: "documents:list",
            componentPath: "",
            type: "query" as const,
            visibility: "public" as const,
          }),
        },
        runQuery: async () => {
          componentCalls += 1;
          throw new Error("Plain query results must not enter the component.");
        },
      } as never,
      {
        embeddedTransport: {
          kind: "live",
          component: "components/embedded/protocol:pull",
          runtime: {
            moduleGraphHash: "modules",
            protocolVersion: EMBEDDED_PROTOCOL_VERSION,
            schemaHash: "schema",
          },
          stack: [],
          topLevel: true,
        },
      },
    );

    expect(componentCalls).toBe(0);
    expect(result).toMatchObject({
      members: [],
      changes: [],
      crdt: [],
    });
  });

  test("does not disclose fabricated projections", async () => {
    const embedded = defineEmbedded({ component, schema });
    const document = {
      _id: "documents:1",
      _creationTime: 1,
      owner: "owner-1",
      title: "Private",
      body: "body",
    };
    const query = embedded.query({
      args: {},
      returns: v.any(),
      handler: async (ctx) => {
        const value = await ctx.db.get("documents", document._id as never);
        return { _id: value!._id, _creationTime: value!._creationTime, title: "Fabricated" };
      },
    });
    const result = await (
      query as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(
      {
        db: {
          get: async () => document,
          normalizeId: () => null,
        },
        meta: {
          getFunctionMetadata: async () => ({
            name: "documents:list",
            componentPath: "",
            type: "query" as const,
            visibility: "public" as const,
          }),
        },
        runQuery: async () => "components/embedded",
      } as never,
      {
        embeddedTransport: {
          kind: "capture",
          installation: "components/embedded",
          stack: [],
          topLevel: true,
        },
      },
    );

    expect(result).toMatchObject({ embeddedResult: "eligible", rows: [] });
  });

  test("reads CRDT metadata through one exact field index lookup", async () => {
    const equality: Array<[string, unknown]> = [];
    const queries: string[] = [];
    const result = await (
      componentPull as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(
      {
        db: {
          query: (table: string) => {
            queries.push(table);
            return {
              withIndex: (index: string, range: (q: unknown) => unknown) => {
                expect(index).toBe("by_table_and_rowid_and_field");
                const builder = {
                  eq(field: string, value: unknown) {
                    equality.push([field, value]);
                    return builder;
                  },
                };
                range(builder);
                return { unique: async () => null };
              },
            };
          },
        },
      },
      {
        runtime: {
          moduleGraphHash: "modules",
          protocolVersion: EMBEDDED_PROTOCOL_VERSION,
          schemaHash: "schema",
        },
        rows: [
          {
            table: "documents",
            rowId: "documents:1",
            fields: { _id: "documents:1", body: "Body" },
            crdtFields: ["body"],
          },
        ],
      },
    );

    expect(queries).toEqual(["crdtFields"]);
    expect(equality).toEqual([
      ["table", "documents"],
      ["rowId", "documents:1"],
      ["field", "body"],
    ]);
    expect(result).toMatchObject({ crdt: [] });
  });

  const runComponentPull = async (
    rows: Array<{ table: string; rowId: string; fields: unknown; crdtFields: string[] }>,
  ) =>
    (
      componentPull as unknown as {
        _handler: (
          ctx: unknown,
          args: unknown,
        ) => Promise<{ changes: Array<{ plainHash: string; fields: unknown }> }>;
      }
    )._handler(
      {
        db: {
          query: () => ({
            withIndex: () => ({ unique: async () => null }),
          }),
        },
      },
      {
        runtime: {
          moduleGraphHash: "modules",
          protocolVersion: EMBEDDED_PROTOCOL_VERSION,
          schemaHash: "schema",
        },
        rows,
      },
    );

  test("excludes declared CRDT materializations from the plain pull hash", async () => {
    const base = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T", body: "v1" };
    const [{ plainHash }] = (
      await runComponentPull([
        { table: "documents", rowId: "documents:1", fields: base, crdtFields: ["body"] },
      ])
    ).changes;
    expect(plainHash).toBe(await hashDocument(base, ["body"]));
  });

  test("keeps the plain pull hash stable across a CRDT-only edit", async () => {
    const before = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T", body: "v1" };
    const after = { ...before, body: "v2-collaborative-edit" };
    const [{ plainHash: hashBefore }] = (
      await runComponentPull([
        { table: "documents", rowId: "documents:1", fields: before, crdtFields: ["body"] },
      ])
    ).changes;
    const [{ plainHash: hashAfter }] = (
      await runComponentPull([
        { table: "documents", rowId: "documents:1", fields: after, crdtFields: ["body"] },
      ])
    ).changes;
    expect(hashAfter).toBe(hashBefore);
  });

  test("hashes the plain fast path with the CRDT-excluding document hash", async () => {
    const runtime = {
      moduleGraphHash: "modules",
      protocolVersion: EMBEDDED_PROTOCOL_VERSION,
      schemaHash: "schema",
    };
    const fields = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T" };
    let componentCalls = 0;
    const ctx = {
      runQuery: async () => {
        componentCalls += 1;
        return null;
      },
    } as never;
    const result = (await completeQueryRows(
      ctx,
      component as never,
      runtime,
      [{ table: "documents", rowId: "documents:1", fields, crdtFields: [] }],
      fields,
    )) as { changes: Array<{ plainHash: string }> };
    expect(componentCalls).toBe(0);
    expect(result.changes[0]!.plainHash).toBe(await hashDocument(fields, []));
  });

  test("moves the plain pull hash for a plain or mixed edit", async () => {
    const before = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T", body: "v1" };
    const plainEdit = { ...before, title: "T2" };
    const mixedEdit = { ...before, title: "T2", body: "v2" };
    const hashOf = async (fields: unknown) =>
      (
        await runComponentPull([
          { table: "documents", rowId: "documents:1", fields, crdtFields: ["body"] },
        ])
      ).changes[0]!.plainHash;
    const hashBefore = await hashOf(before);
    expect(await hashOf(plainEdit)).not.toBe(hashBefore);
    expect(await hashOf(mixedEdit)).not.toBe(hashBefore);
    expect(await hashOf(mixedEdit)).toBe(await hashOf(plainEdit));
  });

  const cacheRuntime = {
    moduleGraphHash: "modules",
    protocolVersion: EMBEDDED_PROTOCOL_VERSION,
    schemaHash: "schema",
  };
  const cacheCtx = {
    runQuery: async () => {
      throw new Error("Retained-result matcher must not enter the component.");
    },
  } as never;
  const skeletonOf = async (
    authored: unknown,
    rows: Array<{ table: string; rowId: string; fields: unknown }>,
  ) =>
    (await completeQueryRows(
      cacheCtx,
      component as never,
      cacheRuntime,
      rows.map((row) => ({ ...row, crdtFields: [] })),
      authored,
    )) as { result: unknown; resultRows: Array<{ path: string; table: string; rowId: string }> };

  test("encodes a matched complete document and emits its RFC 6901 pointer", async () => {
    const doc = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T" };
    const { result, resultRows } = await skeletonOf({ data: { items: [doc] }, total: 42 }, [
      { table: "documents", rowId: "documents:1", fields: doc },
    ]);
    expect(result).toEqual({ data: { items: [null] }, total: 42 });
    expect(resultRows).toEqual([
      { path: "/data/items/0", table: "documents", rowId: "documents:1" },
    ]);
  });

  test("matches structurally equal documents by _id, not by shape", async () => {
    const first = { _id: "documents:1", _creationTime: 5, title: "same" };
    const second = { _id: "documents:2", _creationTime: 5, title: "same" };
    const { result, resultRows } = await skeletonOf(
      [first, second],
      [
        { table: "documents", rowId: "documents:1", fields: first },
        { table: "documents", rowId: "documents:2", fields: second },
      ],
    );
    expect(result).toEqual([null, null]);
    expect(resultRows).toEqual([
      { path: "/0", table: "documents", rowId: "documents:1" },
      { path: "/1", table: "documents", rowId: "documents:2" },
    ]);
  });

  test("ships a transformed scalar result verbatim with no matched rows", async () => {
    const { result, resultRows } = await skeletonOf({ count: 42 }, []);
    expect(result).toEqual({ count: 42 });
    expect(resultRows).toEqual([]);
  });

  test("does not match a partial projection as a complete document", async () => {
    const doc = { _id: "documents:1", _creationTime: 1, owner: "o", title: "T", extra: "full" };
    const projection = { _id: "documents:1", _creationTime: 1, title: "T" };
    const { result, resultRows } = await skeletonOf({ items: [projection] }, [
      { table: "documents", rowId: "documents:1", fields: doc },
    ]);
    expect(result).toEqual({ items: [projection] });
    expect(resultRows).toEqual([]);
  });

  test("escapes RFC 6901 reserved characters in emitted pointers", async () => {
    const slash = { _id: "documents:1", _creationTime: 1, title: "A" };
    const tilde = { _id: "documents:2", _creationTime: 1, title: "B" };
    const { resultRows } = await skeletonOf({ "a/b": slash, "c~d": tilde }, [
      { table: "documents", rowId: "documents:1", fields: slash },
      { table: "documents", rowId: "documents:2", fields: tilde },
    ]);
    expect(resultRows).toEqual([
      { path: "/a~1b", table: "documents", rowId: "documents:1" },
      { path: "/c~0d", table: "documents", rowId: "documents:2" },
    ]);
  });

  test("emits page-index pointers for a paginated result", async () => {
    const first = { _id: "documents:1", _creationTime: 1, title: "one" };
    const second = { _id: "documents:2", _creationTime: 2, title: "two" };
    const { result, resultRows } = await skeletonOf(
      { page: [first, second], isDone: true, continueCursor: "" },
      [
        { table: "documents", rowId: "documents:1", fields: first },
        { table: "documents", rowId: "documents:2", fields: second },
      ],
    );
    expect(result).toEqual({ page: [null, null], isDone: true, continueCursor: "" });
    expect(resultRows).toEqual([
      { path: "/page/0", table: "documents", rowId: "documents:1" },
      { path: "/page/1", table: "documents", rowId: "documents:2" },
    ]);
  });

  test("fails an oversized encoded result with the member-page bound", async () => {
    const doc = { _id: "documents:1", _creationTime: 1, title: "T" };
    const items = Array.from({ length: 1_025 }, () => doc);
    await expect(
      skeletonOf({ items }, [{ table: "documents", rowId: "documents:1", fields: doc }]),
    ).rejects.toThrow("returned more than 1024 documents");
  });

  test("keeps a hosted id in a transformed position without translation", async () => {
    const doc = { _id: "documents:1", _creationTime: 1, title: "T" };
    const { result, resultRows } = await skeletonOf({ latest: doc, pointer: "documents:zzz" }, [
      { table: "documents", rowId: "documents:1", fields: doc },
    ]);
    expect(result).toEqual({ latest: null, pointer: "documents:zzz" });
    expect(resultRows).toEqual([{ path: "/latest", table: "documents", rowId: "documents:1" }]);
  });

  const replayHarness = async (
    effects: Array<Record<string, unknown>>,
    handler: (ctx: { db: any }) => Promise<unknown>,
    identity: { tokenIdentifier: string } | null = null,
    seedRows?: Array<Record<string, unknown>>,
    reads: unknown[] = [],
  ) => {
    const replayConsume = { [Symbol.for("toReferencePath")]: "components/embedded/protocol:rc" };
    const commit = { [Symbol.for("toReferencePath")]: "components/embedded/protocol:commit" };
    const replayComponent = {
      protocol: { installation: {}, pull: componentPullReference, replayConsume, commit },
      rev: {
        create: { [Symbol.for("toReferencePath")]: "components/embedded/rev/create" },
        get: {},
      },
    } as unknown as ComponentApi<"embedded">;
    const rowId = "counters:1";
    const rows = new Map<string, Record<string, unknown>>(
      (seedRows ?? [{ _id: rowId, _creationTime: 1, owner: "o", value: 0 }]).map((seedRow) => [
        String(seedRow._id),
        { ...seedRow },
      ]),
    );
    const patches: Array<Record<string, unknown>> = [];
    const commits: Array<Record<string, unknown>> = [];
    const envelope = {
      clientId: "client-1",
      mutationId: "mutation-1",
      fingerprint: "fingerprint",
      runtime: {
        moduleGraphHash: "modules",
        protocolVersion: EMBEDDED_PROTOCOL_VERSION,
        schemaHash: "schema",
      },
      resultHash: await hashValue(null),
      mutationTime: 1,
      randomSeed: "seed",
      reads,
      inserts: [],
      schedules: [],
      uploads: [],
      crdt: effects,
      revisionCheckpoints: [],
    };
    const settlementStub = {
      mutationId: "mutation-1",
      outcome: "applied",
      result: null,
      inserts: [],
      schedules: [],
      uploads: [],
      revisions: [],
      crdt: [],
      authoritative: [],
    };
    const ctx = {
      auth: { getUserIdentity: async () => identity },
      db: {
        get: async (_table: string, id: string) => {
          const found = rows.get(id);
          return found ? { ...found } : null;
        },
        patch: async (table: string, id: string, partial: Record<string, unknown>) => {
          patches.push({ table, id, ...partial });
          Object.assign(rows.get(id) ?? {}, partial);
        },
        normalizeId: (table: string, id: string) => (id.startsWith(`${table}:`) ? id : null),
      },
      meta: {
        getFunctionMetadata: async () => ({
          name: "counters:bump",
          componentPath: "",
          type: "mutation" as const,
          visibility: "public" as const,
        }),
        getRequestMetadata: async () => ({ requestId: "request-1" }),
      },
      scheduler: {},
      storage: {},
      runQuery: async () => null,
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        if (reference === replayConsume) return envelope;
        if (reference === commit) {
          commits.push(args);
          return settlementStub;
        }
        throw new Error("Unexpected component mutation during replay.");
      },
    };
    const embedded = defineEmbedded({ component: replayComponent, schema });
    const bump = embedded.mutation({ args: {}, handler: handler as never });
    const result = await (
      bump as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(ctx, {});
    return { result, patches, commits, rowId };
  };

  const countEffect = (rowId: string, projection: number) => ({
    table: "counters",
    rowId,
    field: "value",
    kind: "count" as const,
    baseSeq: 0,
    projection,
    projectionHash: "projection-hash",
    payload: new ArrayBuffer(0),
  });

  const rangeWitness = () => ({
    kind: "range" as const,
    table: "counters",
    index: "by_owner",
    equality: [],
    order: "asc" as const,
    membersHash: "members-hash",
  });

  test("accepts range witnesses up to the per-mutation cap", async () => {
    const reads = Array.from({ length: 1_024 }, rangeWitness);
    const { result } = await replayHarness([], async () => null, null, undefined, reads);
    expect(result).toMatchObject({ kind: "embeddedReplay", result: null });
  });

  test("rejects range witnesses past the per-mutation cap", async () => {
    const reads = Array.from({ length: 1_025 }, rangeWitness);
    await expect(replayHarness([], async () => null, null, undefined, reads)).rejects.toThrow(
      /at most 1024 range witnesses/,
    );
  });

  test("replays a zero-delta count.add without consuming an effect ordinal", async () => {
    const rowId = "counters:1";
    const { result, patches, commits } = await replayHarness(
      [countEffect(rowId, 5), countEffect(rowId, 7)],
      async (ctx) => {
        await ctx.db.count.add("counters", rowId, "value", 1);
        await ctx.db.count.add("counters", rowId, "value", 0);
        await ctx.db.count.add("counters", rowId, "value", 1);
        return null;
      },
    );
    expect(result).toMatchObject({ kind: "embeddedReplay", result: null });
    expect(patches).toEqual([
      { table: "counters", id: rowId, value: 5 },
      { table: "counters", id: rowId, value: 7 },
    ]);
    expect(commits).toHaveLength(1);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(2);
    expect(request.changes).toEqual([]);
    expect((request.settlement as { outcome: string }).outcome).toBe("applied");
  });

  test("keeps only plain-write rows in applied authoritative for a mixed mutation", async () => {
    const crdtRow = "counters:1";
    const plainRow = "counters:2";
    const { commits } = await replayHarness(
      [countEffect(crdtRow, 5)],
      async (ctx) => {
        await ctx.db.count.add("counters", crdtRow, "value", 1);
        await ctx.db.patch("counters", plainRow, { owner: "z" });
        return null;
      },
      null,
      [
        { _id: crdtRow, _creationTime: 1, owner: "o", value: 0 },
        { _id: plainRow, _creationTime: 2, owner: "o", value: 0 },
      ],
    );
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(1);
    expect(request.changes).toEqual([
      expect.objectContaining({ op: "put", table: "counters", rowId: plainRow }),
    ]);
  });

  test("throws the client's finite-delta error for count.add and stays caught-symmetric", async () => {
    const rowId = "counters:1";
    let caught: unknown;
    const { result, patches, commits } = await replayHarness([], async (ctx) => {
      try {
        await ctx.db.count.add("counters", rowId, "value", Number.NaN);
      } catch (error) {
        caught = error;
      }
      return null;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "count.add: counters.value delta must be a finite number",
    );
    expect((caught as { data?: unknown }).data).toBeUndefined();
    expect(result).toMatchObject({ kind: "embeddedReplay", result: null });
    expect(patches).toEqual([]);
    expect(commits).toHaveLength(1);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(0);
    expect((request.settlement as { outcome: string }).outcome).toBe("applied");
  });

  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("replays deterministic entropy from the recorded seed", async () => {
    const draws: unknown[] = [];
    const rejections: string[] = [];
    await replayHarness([], async () => {
      draws.push(Math.random());
      draws.push(crypto.randomUUID());
      draws.push([...crypto.getRandomValues(new Uint8Array(10))]);
      try {
        crypto.getRandomValues(new Float64Array(2) as never);
      } catch (error) {
        rejections.push((error as Error).name);
      }
      try {
        crypto.getRandomValues(new Uint8Array(65_537));
      } catch (error) {
        rejections.push((error as Error).name);
      }
      draws.push(Math.random());
      draws.push([...crypto.getRandomValues(new Uint8Array(3))]);
      draws.push(crypto.randomUUID());
      return null;
    });
    expect(rejections).toEqual(["TypeMismatchError", "QuotaExceededError"]);
    const stream = seedEntropy("seed");
    expect(draws).toEqual([
      stream.random(),
      stream.uuid(),
      [...stream.fill(new Uint8Array(10))],
      stream.random(),
      [...stream.fill(new Uint8Array(3))],
      stream.uuid(),
    ]);
    expect(draws[1]).toMatch(uuidV4);
  });

  const documentRow = (body: unknown) => ({
    _id: "documents:1",
    _creationTime: 1,
    owner: "o",
    title: "T",
    body,
  });

  test("mirrors a caught text.splice range error and consumes no effect", async () => {
    const docId = "documents:1";
    let caught: unknown;
    const { result, patches, commits } = await replayHarness(
      [],
      async (ctx) => {
        try {
          await ctx.db.text.splice("documents", docId, "body", {
            delete: 0,
            index: 99,
            insert: "x",
          });
        } catch (error) {
          caught = error;
        }
        return null;
      },
      null,
      [documentRow("hi")],
    );
    expect((caught as Error).message).toBe(
      "text.splice: change range is outside the current value",
    );
    expect(result).toMatchObject({ kind: "embeddedReplay", result: null });
    expect(patches).toEqual([]);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(0);
    expect((request.settlement as { outcome: string }).outcome).toBe("applied");
  });

  test("mirrors a caught count non-finite result and consumes no effect", async () => {
    const rowId = "counters:1";
    let caught: unknown;
    const { patches, commits } = await replayHarness(
      [],
      async (ctx) => {
        try {
          await ctx.db.count.add("counters", rowId, "value", Number.MAX_VALUE);
        } catch (error) {
          caught = error;
        }
        return null;
      },
      null,
      [{ _id: rowId, _creationTime: 1, owner: "o", value: Number.MAX_VALUE }],
    );
    expect((caught as Error).message).toBe(
      "count.add: counters.value result must be a finite number",
    );
    expect(patches).toEqual([]);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(0);
  });

  test("throws the client's exact message for every pre-effect intent validation", async () => {
    const rowId = "counters:1";
    const docId = "documents:1";
    const captured = async (
      seedRow: Record<string, unknown>,
      call: (ctx: { db: any }) => Promise<unknown>,
    ): Promise<string> => {
      let message = "no throw";
      await replayHarness(
        [],
        async (ctx) => {
          try {
            await call(ctx);
          } catch (error) {
            message = (error as Error).message;
          }
          return null;
        },
        null,
        [seedRow],
      );
      return message;
    };
    const clientMessage = (run: () => void): string => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return "no throw";
    };

    const counterRow = { _id: rowId, _creationTime: 1, owner: "o", value: 3 };
    expect(
      await captured(counterRow, (ctx) => ctx.db.count.add("counters", rowId, "title", 1)),
    ).toBe(clientMessage(() => assertIntentField("counters", "title", "count", undefined)));
    expect(
      await captured(counterRow, (ctx) =>
        ctx.db.text.splice("counters", rowId, "value", {
          delete: 0,
          index: 0,
          insert: "x",
        }),
      ),
    ).toBe(clientMessage(() => assertIntentField("counters", "value", "text", "count")));
    expect(
      await captured({ _id: rowId, _creationTime: 1, owner: "o", value: "not-a-number" }, (ctx) =>
        ctx.db.count.add("counters", rowId, "value", 1),
      ),
    ).toBe(
      clientMessage(() =>
        validateCountAdd("counters", rowId, "value", { value: "not-a-number" }, 1),
      ),
    );
    expect(
      await captured({ _id: rowId, _creationTime: 1, owner: "o", members: "nope" }, (ctx) =>
        ctx.db.set.add("counters", rowId, "members", "a"),
      ),
    ).toBe(
      clientMessage(() =>
        validateSetField("set.add", "counters", rowId, "members", { members: "nope" }),
      ),
    );
    expect(
      await captured(documentRow(42), (ctx) =>
        ctx.db.text.splice("documents", docId, "body", { delete: 0, index: 0, insert: "x" }),
      ),
    ).toBe(
      clientMessage(() =>
        validateTextSplice(
          "documents",
          docId,
          "body",
          { body: 42 },
          {
            delete: 0,
            index: 0,
            insert: "x",
          },
        ),
      ),
    );
    expect(
      await captured(documentRow("hi"), (ctx) =>
        ctx.db.text.splice("documents", docId, "body", {
          delete: 0,
          index: 0,
          insert: "\ud800",
        }),
      ),
    ).toBe(
      clientMessage(() =>
        validateTextSplice(
          "documents",
          docId,
          "body",
          { body: "hi" },
          {
            delete: 0,
            index: 0,
            insert: "\ud800",
          },
        ),
      ),
    );
  });

  test("keeps effect ordinals aligned across caught and succeeding intents", async () => {
    const rowId = "counters:1";
    const docId = "documents:1";
    const { patches, commits } = await replayHarness(
      [countEffect(rowId, 5), countEffect(rowId, 12)],
      async (ctx) => {
        await ctx.db.count.add("counters", rowId, "value", 5);
        try {
          await ctx.db.text.splice("documents", docId, "body", {
            delete: 0,
            index: 99,
            insert: "x",
          });
        } catch {
          void 0;
        }
        try {
          await ctx.db.count.add("counters", rowId, "value", 0);
        } catch {
          void 0;
        }
        try {
          await ctx.db.count.add("counters", rowId, "value", Number.NaN);
        } catch {
          void 0;
        }
        await ctx.db.count.add("counters", rowId, "value", 7);
        return null;
      },
      null,
      [{ _id: rowId, _creationTime: 1, owner: "o", value: 0 }, documentRow("hi")],
    );
    expect(patches).toEqual([
      { table: "counters", id: rowId, value: 5 },
      { table: "counters", id: rowId, value: 12 },
    ]);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.crdt).toHaveLength(2);
    expect((request.settlement as { outcome: string }).outcome).toBe("applied");
  });

  const retireHarness = async (args: {
    clientId: string;
    expectedLastSeenAt: number;
    expectedIdentity?: string;
  }) => {
    const client = {
      _id: "clients:1",
      clientId: "client-1",
      lastSeenAt: 5,
      identity: "identity-a",
      retired: false,
    };
    const patches: Array<Record<string, unknown>> = [];
    const ctx = {
      db: {
        query: () => ({
          withIndex: (index: string, range: (q: unknown) => unknown) => {
            expect(index).toBe("by_clientid");
            range({ eq: () => ({}) });
            return { unique: async () => client };
          },
        }),
        patch: async (table: string, id: string, partial: Record<string, unknown>) => {
          patches.push({ table, id, ...partial });
        },
      },
    };
    const result = await (
      componentRetire as unknown as {
        _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    )._handler(ctx as never, args);
    return { result, patches };
  };

  test("retire fences a device and fails closed on a wrong expectedIdentity", async () => {
    const fenced = await retireHarness({ clientId: "client-1", expectedLastSeenAt: 5 });
    expect(fenced.result).toEqual({ retirement: "retired" });
    expect(fenced.patches).toEqual([{ table: "clients", id: "clients:1", retired: true }]);

    const matched = await retireHarness({
      clientId: "client-1",
      expectedLastSeenAt: 5,
      expectedIdentity: "identity-a",
    });
    expect(matched.result).toEqual({ retirement: "retired" });

    await expect(
      retireHarness({
        clientId: "client-1",
        expectedLastSeenAt: 5,
        expectedIdentity: "identity-b",
      }),
    ).rejects.toThrow(/identity changed/);

    await expect(retireHarness({ clientId: "client-1", expectedLastSeenAt: 4 })).rejects.toThrow(
      /changed after it was selected/,
    );
  });

  test("commits by clientId alone and never carries an identity key", async () => {
    const { commits } = await replayHarness([], async () => null);
    const request = (commits[0] as { request: Record<string, unknown> }).request;
    expect(request.clientId).toBe("client-1");
    expect(request).not.toHaveProperty("identityKey");
  });

  test("records the identity attribute only for an authenticated settlement", async () => {
    const unauthenticated = await replayHarness([], async () => null);
    const unauthedRequest = (unauthenticated.commits[0] as { request: Record<string, unknown> })
      .request;
    expect(unauthedRequest).not.toHaveProperty("identity");

    const authenticated = await replayHarness([], async () => null, {
      tokenIdentifier: "issuer|subject",
    });
    const authedRequest = (authenticated.commits[0] as { request: Record<string, unknown> })
      .request;
    expect(authedRequest.identity).toBe(await hashValue("issuer|subject"));
    expect(authedRequest).not.toHaveProperty("identityKey");
  });

  test("rejects hosted, internal, foreign, and cyclic query targets", async () => {
    const embedded = defineEmbedded({ component, schema });
    const hosted = embedded.query({ local: false, args: {}, handler: async () => null });
    const internal = embedded.internalQuery({ args: {}, handler: async () => null });
    const local = embedded.query({ args: {}, handler: async () => null });
    const context = (name: string, visibility: "public" | "internal") =>
      ({
        db: {},
        meta: {
          getFunctionMetadata: async () => ({
            name,
            componentPath: "",
            type: "query" as const,
            visibility,
          }),
        },
        runQuery: async () => "components/embedded",
      }) as never;
    const transport = (installation: string, stack: string[] = []) => ({
      embeddedTransport: { kind: "capture", installation, stack, topLevel: true },
    });

    const handler = (registered: unknown) =>
      (registered as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler;

    await expect(
      handler(hosted)(context("documents:hosted", "public"), transport("components/embedded")),
    ).resolves.toMatchObject({ embeddedResult: "ineligible", reason: "hosted" });
    await expect(
      handler(internal)(
        context("documents:internal", "internal"),
        transport("components/embedded"),
      ),
    ).resolves.toMatchObject({ embeddedResult: "ineligible", reason: "internal" });
    await expect(
      handler(local)(context("documents:local", "public"), transport("components/other")),
    ).resolves.toMatchObject({ embeddedResult: "ineligible", reason: "foreign" });
    await expect(
      handler(local)(
        context("documents:local", "public"),
        transport("components/embedded", ["documents:local"]),
      ),
    ).resolves.toMatchObject({ embeddedResult: "ineligible", reason: "cycle" });
  });

  test("closes membership capture over nested local-capable queries", async () => {
    const embedded = defineEmbedded({ component, schema });
    const document = {
      _id: "documents:child",
      _creationTime: 1,
      owner: "owner-1",
      title: "Child",
      body: "body",
    };
    const child = embedded.internalQuery({
      args: {},
      returns: v.any(),
      handler: async (ctx) => await ctx.db.get("documents", document._id as never),
    });
    const childReference = makeFunctionReference<"query">("documents:child");
    const parent = embedded.query({
      args: {},
      returns: v.any(),
      handler: async (ctx) => ({ child: await ctx.runQuery(childReference, {}) }),
    });
    const registered = (value: unknown) =>
      (value as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler;
    const context = (name: string, visibility: "public" | "internal"): unknown => ({
      db: {
        get: async () => document,
        normalizeId: () => null,
      },
      meta: {
        getFunctionMetadata: async () => ({
          name,
          componentPath: "",
          type: "query" as const,
          visibility,
        }),
      },
      runQuery: async (reference: unknown, args: unknown) => {
        if (reference === component.protocol.installation) return "components/embedded";
        if (getFunctionName(reference as never) === "documents:child") {
          return await registered(child)(context("documents:child", "internal"), args);
        }
        throw new Error("Unexpected nested query reference.");
      },
    });

    await expect(
      registered(parent)(context("documents:parent", "public"), {
        embeddedTransport: {
          kind: "capture",
          installation: "components/embedded",
          stack: [],
          topLevel: true,
        },
      }),
    ).resolves.toMatchObject({
      embeddedResult: "eligible",
      rows: [{ table: "documents", rowId: document._id, fields: document }],
    });
  });

  test("exports exact transport request variants", () => {
    const embedded = defineEmbedded({ component, schema });
    type ExportedUnion = {
      type: string;
      value: Array<{ value: Record<string, { optional: boolean }> }>;
    };
    type ExportedArgs = {
      type: string;
      value: { request: { fieldType: ExportedUnion; optional: boolean } };
    };
    const push = JSON.parse(
      (embedded.push as unknown as { exportArgs(): string }).exportArgs(),
    ) as ExportedArgs;
    const pull = JSON.parse(
      (embedded.pull as unknown as { exportArgs(): string }).exportArgs(),
    ) as ExportedArgs;
    const pushRequest = push.value.request.fieldType;
    const pullRequest = pull.value.request.fieldType;

    expect(push.type).toBe("object");
    expect(push.value.request.optional).toBe(false);
    expect(pushRequest.type).toBe("union");
    expect(Object.keys(pushRequest.value[0]!.value).sort()).toEqual([
      "acknowledgeMutationId",
      "afterImages",
      "argRefs",
      "args",
      "clientId",
      "crdt",
      "functionName",
      "inserts",
      "kind",
      "mutationId",
      "mutationTime",
      "randomSeed",
      "reads",
      "resultHash",
      "revisionCheckpoints",
      "runtime",
      "schedules",
      "uploads",
    ]);
    expect(Object.keys(pushRequest.value[1]!.value).sort()).toEqual([
      "clientId",
      "kind",
      "mutationId",
    ]);
    expect(Object.keys(pushRequest.value[2]!.value).sort()).toEqual([
      "bytes",
      "chunk",
      "chunkHash",
      "chunks",
      "clientId",
      "hash",
      "kind",
      "ordinal",
      "runtime",
    ]);
    expect(Object.keys(pushRequest.value[3]!.value).sort()).toEqual([
      "checkpointId",
      "clientId",
      "content",
      "kind",
      "projectionHash",
      "responseToken",
      "runtime",
      "throughSeq",
    ]);
    expect(pull.type).toBe("object");
    expect(pull.value.request.optional).toBe(false);
    expect(pullRequest.type).toBe("union");
    expect(Object.keys(pullRequest.value[0]!.value)).toEqual(["kind"]);
    expect(pullRequest.value[1]!.value.runtime?.optional).toBe(false);
    expect(pullRequest.value[1]!.value.functionName?.optional).toBe(false);
    expect(pullRequest.value[1]!.value).not.toHaveProperty("clientId");
    expect(pullRequest.value[1]!.value).not.toHaveProperty("crdt");
    expect(Object.keys(pullRequest.value[2]!.value).sort()).toEqual([
      "args",
      "checkpointId",
      "cursor",
      "epoch",
      "field",
      "functionName",
      "headSeq",
      "kind",
      "rowId",
      "runtime",
      "table",
    ]);
    expect(Object.keys(pullRequest.value[3]!.value).sort()).toEqual([
      "args",
      "boundary",
      "cursor",
      "functionName",
      "kind",
      "path",
      "runtime",
    ]);
  });

  test("does not add engine tables to the app schema", () => {
    const exported = JSON.parse((schema as unknown as { export(): string }).export()) as {
      tables: Array<{ tableName: string }>;
    };
    expect(exported.tables.map((table) => table.tableName)).toEqual(["documents", "counters"]);
  });

  const hostedIntentError = async (
    invoke: (ctx: { db: { text: any; count: any; set: any } }) => Promise<unknown>,
  ) => {
    const embedded = defineEmbedded({ component, schema });
    const registered = embedded.mutation({ local: false, args: {}, handler: invoke as never });
    const ctx = {
      db: { get: async () => null },
      meta: {
        getFunctionMetadata: async () => ({
          name: "documents:edit",
          componentPath: "",
          type: "mutation" as const,
          visibility: "public" as const,
        }),
      },
    };
    let caught: unknown;
    await (registered as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })
      ._handler(ctx, {})
      .catch((error: unknown) => {
        caught = error;
      });
    return caught;
  };

  test("fails a direct hosted CRDT intent with a typed EMBEDDED_UNSUPPORTED error", async () => {
    const spliced = await hostedIntentError(async (ctx) => {
      await ctx.db.text.splice("documents", "documents:1", "body", {
        index: 0,
        delete: 0,
        insert: "x",
      });
    });
    expect(spliced).toBeInstanceOf(ConvexError);
    expect((spliced as ConvexError<{ code: string }>).data.code).toBe("EMBEDDED_UNSUPPORTED");

    const counted = await hostedIntentError(async (ctx) => {
      await ctx.db.count.add("counters", "counters:1", "value", 1);
    });
    expect((counted as ConvexError<{ code: string }>).data.code).toBe("EMBEDDED_UNSUPPORTED");

    const added = await hostedIntentError(async (ctx) => {
      await ctx.db.set.add("counters", "counters:1", "members", "a");
    });
    expect((added as ConvexError<{ code: string }>).data.code).toBe("EMBEDDED_UNSUPPORTED");
  });

  test("populates parentRevId lineage across restores without cycles", async () => {
    const revisions: Array<Record<string, unknown>> = [
      {
        _id: "revisions:1",
        revId: "r1",
        groupId: "g1",
        table: "documents",
        rowId: "documents:1",
        origin: "savepoint",
        status: "retained",
        deleted: false,
        value: { owner: "o", title: "one", body: "" },
        createdAt: 1,
      },
      {
        _id: "revisions:2",
        revId: "r2",
        groupId: "g2",
        table: "documents",
        rowId: "documents:1",
        origin: "savepoint",
        status: "retained",
        deleted: false,
        value: { owner: "o", title: "two", body: "" },
        createdAt: 2,
      },
    ];
    const tables: Record<string, Array<Record<string, any>>> = {
      revisions,
      revisionCrdt: [],
      crdtFields: [],
    };
    const db = {
      query: (table: string) => ({
        withIndex: (_index: string, range?: (q: any) => any) => {
          const eqs: Array<[string, unknown]> = [];
          const q = {
            eq: (field: string, value: unknown) => {
              eqs.push([field, value]);
              return q;
            },
          };
          if (range) range(q);
          const matched = tables[table].filter((row) =>
            eqs.every(([field, value]) => row[field] === value),
          );
          return {
            unique: async () => (matched.length ? matched[0] : null),
            take: async () => matched,
          };
        },
      }),
      patch: async (table: string, id: string, partial: Record<string, unknown>) => {
        Object.assign(tables[table].find((row) => row._id === id)!, partial);
      },
    };
    const restore = (revId: string) =>
      (
        revisionRestore as unknown as {
          _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
        }
      )._handler({ db }, { table: "documents", rowId: "documents:1", revId });

    await restore("r1");
    expect(revisions[0].status).toBe("active");
    expect(revisions[0].parentRevId).toBeUndefined();

    await restore("r2");
    expect(revisions[1].status).toBe("active");
    expect(revisions[0].status).toBe("retained");
    expect(revisions[1].parentRevId).toBe("r1");
    expect(revisions[1].parentRevId).not.toBe(revisions[1].revId);

    await restore("r1");
    expect(revisions[0].status).toBe("active");
    expect(revisions[1].status).toBe("retained");
    expect(revisions[0].parentRevId).toBeUndefined();
    expect(revisions[1].parentRevId).toBe("r1");
  });
});
