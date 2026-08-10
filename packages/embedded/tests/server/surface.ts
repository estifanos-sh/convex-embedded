import type { ComponentApi } from "../../src/component/_generated/component";
import {
  defineTable,
  getFunctionName,
  makeFunctionReference,
  type RegisteredQuery,
} from "convex/server";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, test } from "vitest";

import { defineEmbedded } from "../../src/server";
import { restore as revisionRestore } from "../../src/component/rev";
import { hashDocument, hashValue } from "../../src/hash";
import { pull as componentPull } from "../../src/component/protocol";
import { retire as componentRetire } from "../../src/component/remote/client";
import { completeQueryRows } from "../../src/server/query";
import { EMBEDDED_PROTOCOL_MISMATCH, CURRENT_WIRE_CONTRACT_ID } from "../../src/protocol";
import { WIRE_SURFACE } from "../../src/contract/generated";
import { seedEntropy } from "../../src/entropy";
import {
  assertIntentField,
  validateCountAdd,
  validateSetField,
  validateTextSplice,
} from "../../src/crdt/intent";
import { e } from "../../src/values";
import { defineEmbeddedSchema, replicatedTable } from "../../src/schema";

const schema = defineEmbeddedSchema({
  documents: replicatedTable({
    owner: v.string(),
    secret: e.remote(v.optional(v.string())),
    title: v.string(),
    body: e.text(),
  })
    .index("by_owner", ["owner"])
    .index("by_secret", ["secret"]),
  counters: replicatedTable({
    owner: v.string(),
    value: e.count(),
    members: e.set(v.string()),
  }),
  receipts: defineTable({ token: v.string() }),
});

const componentPullReference = {
  [Symbol.for("toReferencePath")]: "components/embedded/protocol:pull",
};
const component = {
  protocol: { installation: {}, pull: componentPullReference },
} as unknown as ComponentApi<"embedded">;

function canonicalWireValidatorJson(value: unknown): string {
  if (value === CURRENT_WIRE_CONTRACT_ID) return JSON.stringify("$CURRENT_WIRE_CONTRACT_ID");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalWireValidatorJson).join(",")}]`;
  const fields = value as Record<string, unknown>;
  return `{${Object.keys(fields)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonicalWireValidatorJson(fields[field])}`)
    .join(",")}}`;
}

describe("v5 server surface", () => {
  test("requires only the component and app schema", () => {
    const embedded = defineEmbedded({ component, schema });
    expect(Object.keys(embedded).sort()).toEqual([
      "pull",
      "push",
      "remote",
      "replicated",
      "upload",
    ]);
  });

  test("selects the sole public wire from an explicit offer", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.pull as unknown as {
        _handler: (
          ctx: unknown,
          args: { request: { kind: "identity"; contractIds?: string[] } },
        ) => Promise<unknown>;
      }
    )._handler;

    const ctx = {
      auth: {
        getUserIdentity: async () => null,
      },
    };

    await expect(
      handler(ctx, {
        request: {
          kind: "identity",
          contractIds: [CURRENT_WIRE_CONTRACT_ID],
        },
      }),
    ).resolves.toMatchObject({
      identity: null,
      contractId: CURRENT_WIRE_CONTRACT_ID,
    });
  });

  test("rejects an identity offer with no shared wire before reading identity", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.pull as unknown as {
        _handler: (
          ctx: unknown,
          args: { request: { kind: "identity"; contractIds: string[] } },
        ) => Promise<unknown>;
      }
    )._handler;
    let reads = 0;

    await expect(
      handler(
        {
          auth: {
            getUserIdentity: async () => {
              reads += 1;
              return null;
            },
          },
        },
        { request: { kind: "identity", contractIds: ["sha256:unknown-a", "sha256:unknown-b"] } },
      ),
    ).rejects.toMatchObject({ data: { code: EMBEDDED_PROTOCOL_MISMATCH } });
    expect(reads).toBe(0);
  });

  test("mints an upload URL only for an authenticated exact-current request", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.upload as unknown as {
        _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    )._handler;
    let urls = 0;
    await expect(
      handler(
        {
          auth: { getUserIdentity: async () => ({ tokenIdentifier: "user" }) },
          storage: {
            generateUploadUrl: async () => {
              urls += 1;
              return "https://upload.example";
            },
          },
        },
        {
          localStorageId: "local:1",
          sha256: "a".repeat(64),
          size: 0,
          runtime: {
            schemaHash: "schema",
            moduleGraphHash: "modules",
            contractId: CURRENT_WIRE_CONTRACT_ID,
          },
        },
      ),
    ).resolves.toEqual({ uploadUrl: "https://upload.example" });
    expect(urls).toBe(1);
  });

  test("rejects a non-current upload request before authentication or URL allocation", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.upload as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler;
    let auth = 0;
    let urls = 0;
    await expect(
      handler(
        {
          auth: {
            getUserIdentity: async () => {
              auth += 1;
              return null;
            },
          },
          storage: {
            generateUploadUrl: async () => {
              urls += 1;
              return "https://upload.example";
            },
          },
        },
        {
          localStorageId: "local:1",
          sha256: "a".repeat(64),
          size: 0,
          runtime: { schemaHash: "schema", moduleGraphHash: "modules", contractId: "sha256:wrong" },
        },
      ),
    ).rejects.toMatchObject({ data: { code: EMBEDDED_PROTOCOL_MISMATCH } });
    expect(auth).toBe(0);
    expect(urls).toBe(0);
  });

  test("does not allocate an upload URL for unauthenticated or malformed requests", async () => {
    const embedded = defineEmbedded({ component, schema });
    const handler = (
      embedded.upload as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler;
    let urls = 0;
    const ctx = {
      auth: { getUserIdentity: async () => null },
      storage: {
        generateUploadUrl: async () => {
          urls += 1;
          return "https://upload.example";
        },
      },
    };
    const valid = {
      localStorageId: "local:1",
      sha256: "a".repeat(64),
      size: 0,
      runtime: {
        schemaHash: "schema",
        moduleGraphHash: "modules",
        contractId: CURRENT_WIRE_CONTRACT_ID,
      },
    };
    await expect(handler(ctx, valid)).rejects.toThrow("UNAUTHENTICATED");
    expect(urls).toBe(0);

    const authenticated = {
      ...ctx,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "user" }) },
    };
    for (const request of [
      { ...valid, localStorageId: "" },
      { ...valid, sha256: "A".repeat(64) },
      { ...valid, size: -1 },
      { ...valid, size: 0.5 },
    ]) {
      await expect(handler(authenticated, request)).rejects.toMatchObject({
        data: { code: "EMBEDDED_UPLOAD_INVALID" },
      });
    }
    expect(urls).toBe(0);
  });

  test("keeps query transport out of the authored TypeScript surface", () => {
    const embedded = defineEmbedded({ component, schema });
    const query = embedded.replicated.query({
      args: { owner: v.string() },
      returns: v.array(v.string()),
      handler: async (_ctx, args) => [args.owner],
    });
    const mutation = embedded.replicated.mutation({
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

  test("publishes explicit placement metadata for queries and mutations", () => {
    const embedded = defineEmbedded({ component, schema });
    const localQueryHandler = async () => "local-query";
    const hostedQueryHandler = async () => "hosted-query";
    const localMutationHandler = async () => "local-mutation";
    const hostedMutationHandler = async () => "hosted-mutation";
    const functions = [
      [
        embedded.replicated.query({ args: {}, handler: localQueryHandler }),
        localQueryHandler,
        "replicated",
      ],
      [
        embedded.remote.query({ args: {}, handler: hostedQueryHandler }),
        hostedQueryHandler,
        "remote",
      ],
      [
        embedded.replicated.mutation({ args: {}, handler: localMutationHandler }),
        localMutationHandler,
        "replicated",
      ],
      [
        embedded.remote.mutation({ args: {}, handler: hostedMutationHandler }),
        hostedMutationHandler,
        "remote",
      ],
    ] as const;

    for (const [registered, handler, placement] of functions) {
      const metadata = registered as unknown as {
        __embeddedHandler?: unknown;
        __embeddedPlacement?: string;
      };
      expect(metadata.__embeddedHandler).toBe(handler);
      expect(metadata.__embeddedPlacement).toBe(placement);
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
    const query = embedded.replicated.query({
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
            name: "documents:read",
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
    const query = embedded.replicated.query({
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
            name: "documents:read",
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
            contractId: CURRENT_WIRE_CONTRACT_ID,
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
    const query = embedded.replicated.query({
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
            name: "documents:read",
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
          contractId: CURRENT_WIRE_CONTRACT_ID,
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
          contractId: CURRENT_WIRE_CONTRACT_ID,
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
      contractId: CURRENT_WIRE_CONTRACT_ID,
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
    contractId: CURRENT_WIRE_CONTRACT_ID,
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
      replayId: "replay-1",
      fingerprint: "fingerprint",
      logicalFingerprint: "logical-fingerprint",
      runtime: {
        moduleGraphHash: "modules",
        contractId: CURRENT_WIRE_CONTRACT_ID,
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
    const bump = embedded.replicated.mutation({ args: {}, handler: handler as never });
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

  test("rejects internal, foreign, and cyclic query targets", async () => {
    const embedded = defineEmbedded({ component, schema });
    const internal = embedded.replicated.internalQuery({ args: {}, handler: async () => null });
    const local = embedded.replicated.query({ args: {}, handler: async () => null });
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
    const embedded = defineEmbedded({
      component,
      manifest: {
        documents: {
          child: { kind: "query", placement: "replicated", visibility: "internal" },
          parent: { kind: "query", placement: "replicated", visibility: "public" },
        },
      },
      schema,
    });
    const document = {
      _id: "documents:child",
      _creationTime: 1,
      owner: "owner-1",
      title: "Child",
      body: "body",
    };
    const child = embedded.replicated.internalQuery({
      args: {},
      returns: v.any(),
      handler: async (ctx) => await ctx.db.get("documents", document._id as never),
    });
    const childReference = makeFunctionReference<"query">("documents:child");
    const parent = embedded.replicated.query({
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

  test("rejects unqualified reads of remote tables from replicated queries", async () => {
    const embedded = defineEmbedded({ component, schema });
    const read = embedded.replicated.query({
      args: { id: v.string() },
      handler: async (ctx, args) => await ctx.db.get(args.id as never),
    });
    const remoteId = "receipts:remote";
    const invoke = (ctx: unknown, args: unknown) =>
      (read as unknown as { _handler(ctx: unknown, args: unknown): Promise<unknown> })._handler(
        ctx,
        args,
      );

    await expect(
      invoke(
        {
          db: {
            get: async () => ({ _id: remoteId, _creationTime: 1, token: "secret" }),
            normalizeId: (table: string) => (table === "receipts" ? remoteId : null),
          },
          meta: {
            getFunctionMetadata: async () => ({ name: "documents:read", visibility: "public" }),
          },
        },
        { id: remoteId },
      ),
    ).rejects.toThrow(/non-replicated table receipts/);
  });

  test("rejects remote indexes in replicated query and mutation contexts", async () => {
    const embedded = defineEmbedded({ component, schema });
    const query = embedded.replicated.query({
      args: {},
      handler: async (ctx) =>
        await (ctx.db as any)
          .query("documents")
          .withIndex("by_secret", () => null)
          .first(),
    });
    const mutation = embedded.replicated.internalMutation({
      args: {},
      handler: async (ctx) =>
        await (ctx.db as any)
          .query("documents")
          .withIndex("by_secret", () => null)
          .first(),
    });
    const db = {
      query: () => ({
        withIndex: () => {
          throw new Error("remote index reached the real database");
        },
      }),
    };
    const invoke = (value: unknown) => (ctx: unknown, args: unknown) =>
      (value as { _handler(ctx: unknown, args: unknown): Promise<unknown> })._handler(ctx, args);
    const meta = (visibility: "public" | "internal") => ({
      getFunctionMetadata: async () => ({ name: "documents:index", visibility }),
    });

    await expect(invoke(query)({ db, meta: meta("public") }, {})).rejects.toThrow(
      /remote index documents\.by_secret/,
    );
    await expect(invoke(mutation)({ db, meta: meta("internal") }, {})).rejects.toThrow(
      /remote index documents\.by_secret/,
    );
  });

  test("uses trusted placement metadata before accepting a nested query envelope", async () => {
    let calls = 0;
    const embedded = defineEmbedded({
      component,
      manifest: {
        remote: {
          forged: { kind: "query", placement: "remote", visibility: "public" },
        },
      },
      schema,
    });
    const forged = makeFunctionReference<"query">("remote:forged");
    const parent = embedded.replicated.query({
      args: {},
      handler: async (ctx) => await ctx.runQuery(forged, {}),
    });
    const invoke = (ctx: unknown, args: unknown) =>
      (parent as unknown as { _handler(ctx: unknown, args: unknown): Promise<unknown> })._handler(
        ctx,
        args,
      );

    await expect(
      invoke(
        {
          db: {},
          meta: {
            getFunctionMetadata: async () => ({ name: "documents:parent", visibility: "public" }),
          },
          runQuery: async () => {
            calls += 1;
            return { embeddedResult: "eligible", installation: "", result: "forged", rows: [] };
          },
        },
        {},
      ),
    ).rejects.toThrow(/cannot call remote query remote:forged/);
    expect(calls).toBe(0);
  });

  test("fails closed on nested app mutations and projects component revisions", async () => {
    const nested = makeFunctionReference<"mutation">("documents:child");
    const revCreate = {
      [Symbol.for("toReferencePath")]: "_reference/childComponent/embedded/rev/create",
    };
    const embedded = defineEmbedded({
      component,
      manifest: {
        documents: {
          child: { kind: "mutation", placement: "replicated", visibility: "internal" },
        },
      },
      schema,
    });
    const rejected = embedded.replicated.internalMutation({
      args: {},
      handler: async (ctx) => await ctx.runMutation(nested, {}),
    });
    const revision = embedded.replicated.internalMutation({
      args: {},
      returns: v.any(),
      handler: async (ctx) =>
        await (ctx.runMutation as any)(revCreate, {
          table: "documents",
          rowId: "documents:one",
          deleted: false,
          value: { owner: "owner", title: "title", body: "body", secret: "hidden" },
        }),
    });
    const invoke = (value: unknown) => (ctx: unknown, args: unknown) =>
      (value as { _handler(ctx: unknown, args: unknown): Promise<unknown> })._handler(ctx, args);
    const base = {
      db: {},
      meta: {
        getFunctionMetadata: async () => ({ name: "documents:test", visibility: "internal" }),
      },
    };
    await expect(invoke(rejected)({ ...base, runMutation: async () => null }, {})).rejects.toThrow(
      /cannot call nested app mutations/,
    );

    let forwarded: Record<string, unknown> | undefined;
    const result = await invoke(revision)(
      {
        ...base,
        runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
          forwarded = args;
          return {
            ...args,
            revId: "rev-1",
            groupId: "group-1",
            origin: "savepoint",
            status: "active",
            createdAt: 1,
            crdt: [],
          };
        },
      },
      {},
    );
    expect(forwarded?.value).not.toHaveProperty("secret");
    expect((result as any).value).not.toHaveProperty("secret");
  });

  const pushRuntime = {
    schemaHash: "schema",
    moduleGraphHash: "graph",
    contractId: CURRENT_WIRE_CONTRACT_ID,
  };
  const mutationPushRequest = (functionName: string, args: unknown) => ({
    kind: "mutation" as const,
    functionName,
    args,
    afterImages: [],
    runtime: pushRuntime,
    clientId: "client-1",
    mutationId: "mutation-1",
    replayId: "replay-1",
    logicalFingerprint: "client-supplied-forged",
    resultHash: "result-hash",
    mutationTime: 1,
    randomSeed: "seed",
    argRefs: [],
    inserts: [],
    reads: [],
    schedules: [],
    uploads: [],
    crdt: [],
    revisionCheckpoints: [],
  });
  const invokePush = (embedded: { push: unknown }, ctx: unknown, request: unknown) =>
    (
      embedded.push as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    )._handler(ctx, { request });

  test("recomputes the dedup logical fingerprint server-side and ignores the client value", async () => {
    const replayWrite = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:replayWrite",
    };
    const pushComponent = {
      protocol: { installation: {}, pull: componentPullReference, replayWrite },
    } as unknown as ComponentApi<"embedded">;
    const embedded = defineEmbedded({ component: pushComponent, schema });
    const captured: Array<Record<string, unknown>> = [];
    const ctx = {
      auth: { getUserIdentity: async () => null },
      meta: { getRequestMetadata: async () => ({ requestId: "request-1" }) },
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        if (reference === replayWrite) {
          captured.push(args);
          return null;
        }
        return {
          kind: "embeddedReplay",
          settlement: { outcome: "applied", mutationId: "mutation-1" },
        };
      },
    };

    await invokePush(embedded, ctx, mutationPushRequest("documents:write", { title: "A" }));
    await invokePush(embedded, ctx, mutationPushRequest("documents:write", { title: "B" }));

    const serverA = await hashValue({
      functionName: "documents:write",
      args: { title: "A" },
      argRefs: [],
    });
    const serverB = await hashValue({
      functionName: "documents:write",
      args: { title: "B" },
      argRefs: [],
    });
    expect(captured.map((entry) => entry.logicalFingerprint)).toEqual([serverA, serverB]);
    expect(captured[0]!.logicalFingerprint).not.toBe("client-supplied-forged");
    expect(serverA).not.toBe(serverB);
  });

  test("settles a push to a target that became remote without invoking it", async () => {
    const replayWrite = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:replayWrite",
    };
    const commit = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:commit",
    };
    const pushComponent = {
      protocol: { commit, installation: {}, pull: componentPullReference, replayWrite },
    } as unknown as ComponentApi<"embedded">;
    const embedded = defineEmbedded({
      component: pushComponent,
      manifest: {
        admin: { wipe: { kind: "mutation", placement: "remote", visibility: "public" } },
      },
      schema,
    });
    let replayWrites = 0;
    let targetInvocations = 0;
    const ctx = {
      auth: { getUserIdentity: async () => null },
      meta: { getRequestMetadata: async () => ({ requestId: "request-1" }) },
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        if (reference === replayWrite) {
          replayWrites += 1;
          return null;
        }
        if (reference === commit) return (args.request as { settlement: unknown }).settlement;
        targetInvocations += 1;
        return {
          kind: "embeddedReplay",
          settlement: { outcome: "applied", mutationId: "mutation-1" },
        };
      },
    };

    await expect(
      invokePush(embedded, ctx, mutationPushRequest("admin:wipe", {})),
    ).resolves.toMatchObject({
      error: { code: "EMBEDDED_REJECTED" },
      outcome: "rejected",
    });
    expect(replayWrites).toBe(1);
    expect(targetInvocations).toBe(0);

    await expect(
      invokePush(embedded, ctx, mutationPushRequest("replay:insertNull", {})),
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(targetInvocations).toBe(1);
  });

  test("settles a push whose after-image includes a narrowed field", async () => {
    const replayWrite = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:replayWrite",
    };
    const commit = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:commit",
    };
    const embedded = defineEmbedded({
      component: {
        protocol: { commit, installation: {}, pull: componentPullReference, replayWrite },
      } as unknown as ComponentApi<"embedded">,
      schema,
    });
    let targetInvocations = 0;
    const ctx = {
      auth: { getUserIdentity: async () => null },
      meta: { getRequestMetadata: async () => ({ requestId: "request-1" }) },
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        if (reference === replayWrite) return null;
        if (reference === commit) return (args.request as { settlement: unknown }).settlement;
        targetInvocations += 1;
        throw new Error("after-image validation must precede target invocation");
      },
    };
    const request = {
      ...mutationPushRequest("documents:write", {}),
      afterImages: [
        {
          content: "value",
          rowId: "document-1",
          table: "documents",
          value: { owner: "owner", secret: "narrowed", title: "title" },
        },
      ],
    };

    await expect(invokePush(embedded, ctx, request)).resolves.toMatchObject({
      error: { code: "EMBEDDED_REJECTED" },
      outcome: "rejected",
    });
    expect(targetInvocations).toBe(0);
  });

  test("settles a push whose deployed target no longer exists", async () => {
    const replayWrite = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:replayWrite",
    };
    const commit = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:commit",
    };
    const pushComponent = {
      protocol: { commit, installation: {}, pull: componentPullReference, replayWrite },
    } as unknown as ComponentApi<"embedded">;
    const embedded = defineEmbedded({ component: pushComponent, schema });
    let committed: Record<string, unknown> | undefined;
    const ctx = {
      auth: { getUserIdentity: async () => null },
      meta: { getRequestMetadata: async () => ({ requestId: "request-1" }) },
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        if (reference === replayWrite) return null;
        if (reference === commit) {
          committed = args;
          return (args.request as { settlement: unknown }).settlement;
        }
        throw new Error("Could not find public function documents:renamed");
      },
    };

    await expect(
      invokePush(embedded, ctx, mutationPushRequest("documents:renamed", {})),
    ).resolves.toMatchObject({
      mutationId: "mutation-1",
      outcome: "rejected",
      error: {
        code: "EMBEDDED_REJECTED",
      },
    });
    expect(committed).toMatchObject({
      request: {
        kind: "failure",
        settlement: { mutationId: "mutation-1", outcome: "rejected" },
      },
    });
  });

  test("normalizes cached failure payloads before returning a canonical push settlement", async () => {
    const replayWrite = {
      [Symbol.for("toReferencePath")]: "components/embedded/protocol:replayWrite",
    };
    const pushComponent = {
      protocol: { installation: {}, pull: componentPullReference, replayWrite },
    } as unknown as ComponentApi<"embedded">;
    const embedded = defineEmbedded({ component: pushComponent, schema });
    const base = {
      mutationId: "mutation-1",
      inserts: [],
      schedules: [],
      uploads: [],
      revisions: [],
      crdt: [],
      authoritative: [],
    };
    const cases = [
      {
        settlement: { ...base, outcome: "conflict", error: { code: "CUT4_SEED", reason: "raw" } },
        expected: "EMBEDDED_CONFLICT",
      },
      {
        settlement: { ...base, outcome: "rebase", error: { code: "anything", reason: "raw" } },
        expected: "EMBEDDED_REBASE",
      },
      {
        settlement: {
          ...base,
          outcome: "rejected",
          error: { code: "EMBEDDED_DIVERGENCE", reason: "raw" },
        },
        expected: "EMBEDDED_DIVERGENCE",
      },
      {
        settlement: { ...base, outcome: "rejected", error: { code: "CUT4_SEED", reason: "raw" } },
        expected: "EMBEDDED_REJECTED",
      },
    ];

    for (const { settlement, expected } of cases) {
      const ctx = {
        auth: { getUserIdentity: async () => null },
        meta: { getRequestMetadata: async () => ({ requestId: "request-1" }) },
        runMutation: async (reference: unknown) => {
          if (reference === replayWrite) return settlement;
          throw new Error("unexpected mutation after cached settlement");
        },
      };
      const response = await invokePush(embedded, ctx, mutationPushRequest("documents:write", {}));
      expect(response).toMatchObject({ outcome: settlement.outcome, error: { code: expected } });
      expect((response as { error: Record<string, unknown> }).error).toEqual({ code: expected });
    }
  });

  test("gates a pull by manifest placement, rejecting a non-replicated target before invoking it", async () => {
    const embedded = defineEmbedded({
      component,
      manifest: {
        admin: { peek: { kind: "query", placement: "remote", visibility: "public" } },
      },
      schema,
    });
    let queries = 0;
    const ctx = {
      runQuery: async () => {
        queries += 1;
        return null;
      },
    };

    await expect(
      (
        embedded.pull as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> }
      )._handler(ctx, {
        request: { kind: "live", functionName: "admin:peek", args: {}, runtime: pushRuntime },
      }),
    ).rejects.toThrow(/cannot invoke remote query admin:peek/);
    expect(queries).toBe(0);
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
    const upload = JSON.parse(
      (embedded.upload as unknown as { exportArgs(): string }).exportArgs(),
    ) as { type: string; value: Record<string, { optional: boolean }> };
    const pushRequest = push.value.request.fieldType;
    const pullRequest = pull.value.request.fieldType;

    expect(push.type).toBe("object");
    expect(push.value.request.optional).toBe(false);
    expect(pushRequest.type).toBe("union");
    const pushKinds = WIRE_SURFACE.discriminators.push;
    for (const [index, kind] of pushKinds.entries()) {
      const shape = WIRE_SURFACE.push[kind] as {
        fields: readonly string[];
        optional?: readonly string[];
      };
      expect(Object.keys(pushRequest.value[index]!.value).sort()).toEqual([...shape.fields].sort());
      for (const field of shape.optional ?? []) {
        expect(pushRequest.value[index]!.value[field]?.optional).toBe(true);
      }
    }
    expect(pull.type).toBe("object");
    expect(pull.value.request.optional).toBe(false);
    expect(pullRequest.type).toBe("union");
    const pullKinds = WIRE_SURFACE.discriminators.pull;
    for (const [index, kind] of pullKinds.entries()) {
      const shape = WIRE_SURFACE.pull[kind] as {
        fields: readonly string[];
        optional?: readonly string[];
      };
      expect(Object.keys(pullRequest.value[index]!.value).sort()).toEqual([...shape.fields].sort());
      for (const field of shape.optional ?? []) {
        expect(pullRequest.value[index]!.value[field]?.optional).toBe(true);
      }
    }
    expect(pullRequest.value[2]!.value.runtime?.optional).toBe(false);
    expect(pullRequest.value[2]!.value.functionName?.optional).toBe(false);
    expect(pullRequest.value[2]!.value).not.toHaveProperty("clientId");
    expect(pullRequest.value[2]!.value).not.toHaveProperty("crdt");
    expect(upload.type).toBe("object");
    expect(Object.keys(upload.value).sort()).toEqual([...WIRE_SURFACE.upload.fields].sort());
    for (const field of WIRE_SURFACE.upload.optional ?? []) {
      expect(upload.value[field]?.optional).toBe(true);
    }
    const digest = (value: unknown) =>
      `sha256:${createHash("sha256").update(canonicalWireValidatorJson(value)).digest("hex")}`;
    // These are digests of the full, recursively canonicalized Convex ValidatorJSON exports—not
    // a field-name approximation. Changing any nested type, optionality, literal, union member,
    // or return shape therefore changes the descriptor and its computed wire contract hash.
    expect({
      pullArgs: digest(
        JSON.parse((embedded.pull as unknown as { exportArgs(): string }).exportArgs()),
      ),
      pushArgs: digest(
        JSON.parse((embedded.push as unknown as { exportArgs(): string }).exportArgs()),
      ),
      uploadArgs: digest(
        JSON.parse((embedded.upload as unknown as { exportArgs(): string }).exportArgs()),
      ),
      pullReturns: digest(
        JSON.parse((embedded.pull as unknown as { exportReturns(): string }).exportReturns()),
      ),
      pushReturns: digest(
        JSON.parse((embedded.push as unknown as { exportReturns(): string }).exportReturns()),
      ),
      uploadReturns: digest(
        JSON.parse((embedded.upload as unknown as { exportReturns(): string }).exportReturns()),
      ),
    }).toEqual(WIRE_SURFACE.validators);
  });

  test("does not add engine tables to the app schema", () => {
    const exported = JSON.parse((schema as unknown as { export(): string }).export()) as {
      tables: Array<{ tableName: string }>;
    };
    expect(exported.tables.map((table) => table.tableName)).toEqual([
      "documents",
      "counters",
      "receipts",
    ]);
  });

  const hostedIntentError = async (
    invoke: (ctx: { db: { text: any; count: any; set: any } }) => Promise<unknown>,
  ) => {
    const embedded = defineEmbedded({ component, schema });
    const registered = embedded.remote.mutation({ args: {}, handler: invoke as never });
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

  test("does not expose replicated CRDT intent methods to remote mutations", async () => {
    const spliced = await hostedIntentError(async (ctx) => {
      await ctx.db.text.splice("documents", "documents:1", "body", {
        index: 0,
        delete: 0,
        insert: "x",
      });
    });
    expect(spliced).toBeInstanceOf(TypeError);

    const counted = await hostedIntentError(async (ctx) => {
      await ctx.db.count.add("counters", "counters:1", "value", 1);
    });
    expect(counted).toBeInstanceOf(TypeError);

    const added = await hostedIntentError(async (ctx) => {
      await ctx.db.set.add("counters", "counters:1", "members", "a");
    });
    expect(added).toBeInstanceOf(TypeError);
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
