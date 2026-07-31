import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionArgs, type FunctionReturnType } from "convex/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { api } from "../fixture/convex/_generated/api";
import * as documents from "../../../../convex/documents";
import schema from "../../../../convex/schema";
import { hashDocument, hashValue } from "../../src/hash";
import { ConvexEmbeddedClient } from "../../src/node/client";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import { getTimerTime } from "../../src/time";
import { fixtureRemoteUrl } from "../testkit/remote";
import { read as readTime } from "../testkit/time";

const remoteUrl = fixtureRemoteUrl();
const testRuntime = {
  schemaHash: "v5-test",
  moduleGraphHash: "v5-test",
  protocolVersion: EMBEDDED_PROTOCOL_VERSION,
};
type PushArgs = {
  kind: "mutation";
  clientId: string;
  mutationId: string;
  replayId: string;
  logicalFingerprint: string;
  acknowledgeReplayId?: string;
  runtime: typeof testRuntime;
  functionName: string;
  args: unknown;
  resultHash: string;
  argRefs: Array<
    | { path: string; insert: { mutationId: string; ordinal: number; table: string } }
    | { path: string; schedule: { mutationId: string; ordinal: number } }
  >;
  inserts: Array<{ mutationId: string; ordinal: number; table: string }>;
  reads: Array<Record<string, unknown>>;
  mutationTime: number;
  randomSeed: string;
  schedules: Array<{ mutationId: string; ordinal: number }>;
  uploads: Array<{ mutationId: string; ordinal: number }>;
  afterImages: Array<Record<string, unknown>>;
  crdt: Array<Record<string, unknown>>;
  revisionCheckpoints: Array<Record<string, unknown>>;
};
type PushResult = {
  mutationId: string;
  outcome: "applied" | "conflict" | "rejected" | "rebase";
  inserts: Array<{ ordinal: number; table: string; id: string }>;
  schedules: Array<{ ordinal: number; id: string }>;
  uploads: Array<{ ordinal: number; url: string }>;
  revisions: Array<{ table: string; rowId: string; revId: string }>;
  crdt: unknown[];
  authoritative: unknown[];
};
type PullArgs = Extract<FunctionArgs<typeof api.embedded.pull>["request"], { kind: "live" }>;
type PullResult = Extract<FunctionReturnType<typeof api.embedded.pull>, { members: unknown }>;
const readSettlement = makeFunctionReference<"query">("mutation:settlement");

interface RemoteClientMetadata {
  clientId: string;
  identity?: string;
  lastPushAt?: number;
  lastSeenAt: number;
  moduleGraphHash: string;
  protocolVersion: number;
  retired: boolean;
  schemaHash: string;
  acknowledgedThrough?: number;
}

async function runPush(client: ConvexHttpClient, args: PushArgs): Promise<PushResult> {
  return (await client.mutation(api.embedded.push, { request: args as never })) as PushResult;
}

async function runPull(
  client: ConvexHttpClient,
  args: Omit<PullArgs, "kind">,
): Promise<PullResult> {
  const result = await client.query(api.embedded.pull, {
    request: {
      kind: "live",
      ...args,
    },
  });
  if (!("members" in result)) throw new Error("Pull did not return a live result.");
  return result;
}

async function pushArgs(input: {
  clientId?: string;
  mutationId: string;
  replayId?: string;
  logicalFingerprint?: string;
  acknowledgeReplayId?: string;
  functionName: string;
  args: unknown;
  result?: unknown;
  argRefs?: PushArgs["argRefs"];
  inserts?: PushArgs["inserts"];
  reads?: PushArgs["reads"];
  schedules?: PushArgs["schedules"];
  uploads?: PushArgs["uploads"];
  afterImages?: PushArgs["afterImages"];
  crdt?: PushArgs["crdt"];
  revisionCheckpoints?: PushArgs["revisionCheckpoints"];
  mutationTime?: number;
}): Promise<PushArgs> {
  return {
    kind: "mutation",
    clientId: input.clientId ?? crypto.randomUUID(),
    mutationId: input.mutationId,
    replayId: input.replayId ?? input.mutationId,
    logicalFingerprint: input.logicalFingerprint ?? input.mutationId,
    acknowledgeReplayId: input.acknowledgeReplayId,
    runtime: testRuntime,
    functionName: input.functionName,
    args: input.args,
    resultHash: await hashValue(input.result ?? null),
    argRefs: input.argRefs ?? [],
    inserts: input.inserts ?? [],
    reads: input.reads ?? [],
    mutationTime: input.mutationTime ?? readTime(),
    randomSeed: input.mutationId,
    schedules: input.schedules ?? [],
    uploads: input.uploads ?? [],
    afterImages: input.afterImages ?? [],
    crdt: input.crdt ?? [],
    revisionCheckpoints: input.revisionCheckpoints ?? [],
  };
}

async function crdtSettlement(
  client: ConvexHttpClient,
  table: string,
  rowId: string,
  field: string,
): Promise<{
  authoritative: unknown[];
  crdt: Array<{ field: string; rowId: string; table: string }>;
}> {
  const summaries = await client.query(api.mutation.list, {});
  for (const summary of summaries.page) {
    const record = (await client.query(readSettlement, {
      clientId: summary.clientId,
      mutationId: summary.mutationId,
    })) as {
      settlement: {
        authoritative: unknown[];
        crdt: Array<{ field: string; rowId: string; table: string }>;
      };
    } | null;
    if (
      record?.settlement.crdt.some(
        (effect) => effect.table === table && effect.rowId === rowId && effect.field === field,
      )
    ) {
      return record.settlement;
    }
  }
  throw new Error(`Missing CRDT settlement for ${table}/${rowId}/${field}.`);
}

describe("v5 real Convex vertical slice", () => {
  test("rejects a stale wire revision before reading or replaying app data", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    await expect(
      runPull(hosted, {
        functionName: "documents:read",
        args: { limit: 1 },
        runtime: {
          ...testRuntime,
          protocolVersion: EMBEDDED_PROTOCOL_VERSION - 1,
        },
      }),
    ).rejects.toThrow(`Embedded protocol ${EMBEDDED_PROTOCOL_VERSION - 1} is not supported`);
  });

  test("routes actions and hosted-only functions through Convex", async () => {
    const offlineDirectory = await mkdtemp(join(tmpdir(), "embedded-v5-offline-"));
    const offline = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(offlineDirectory, "embedded.sqlite3"),
      schema,
    });
    try {
      await expect(offline.action(api.hosted.echo, { value: "offline" })).rejects.toMatchObject({
        name: "ConvexEmbeddedOfflineError",
      });
    } finally {
      await offline.close();
      await rm(offlineDirectory, { recursive: true, force: true });
    }

    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-hosted-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    try {
      expect(await client.action(api.hosted.echo, { value: "hosted" })).toBe("hosted");
      const validationError = await client.action(api.hosted.echo, { value: 42 as never }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(validationError).toBeInstanceOf(Error);
      expect(validationError).not.toMatchObject({
        name: "ConvexEmbeddedHostedWriteIndeterminateError",
      });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("dispatches a single documents:write intent and rejects ambiguous combinations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-write-intent-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
    });
    try {
      const created = await client.mutation(api.documents.write, {});
      const id = created._id;

      const slugged = await client.mutation(api.documents.write, { id, slug: "intent-slug" });
      expect(slugged.slug).toBe("intent-slug");
      const patched = await client.mutation(api.documents.write, {
        id,
        title: "Patched",
        updatedAt: 123,
      });
      expect(patched).toMatchObject({ title: "Patched", updatedAt: 123 });
      const flushed = await client.mutation(api.documents.write, {
        id,
        splices: [],
        title: "Flushed",
      });
      expect(flushed.title).toBe("Flushed");

      await expect(
        client.mutation(api.documents.write, { id, slug: "conflict", title: "conflict" }),
      ).rejects.toThrow(/slug change must be the only edit/);
      await expect(
        client.mutation(api.documents.write, {
          id,
          splices: [{ index: 0, delete: 0, insert: "x" }],
          slug: "conflict",
        }),
      ).rejects.toThrow(/slug change must be the only edit/);
      await expect(
        client.mutation(api.documents.write, {
          id,
          splices: [{ index: 0, delete: 0, insert: "x" }],
          updatedAt: 5,
        }),
      ).rejects.toThrow(/separate edits/);
      await expect(client.mutation(api.documents.write, { id })).rejects.toThrow(
        /An update requires splices, slug, title, or updatedAt/,
      );
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("exposes code-controlled retention with retirement and deletion fences", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const clientId = `zzzz-v5-retention-${crypto.randomUUID()}`;
    const prefix = `v5-retention-${crypto.randomUUID()}`;
    await runPull(client, {
      functionName: "documents:read",
      args: { prefix },
      runtime: testRuntime,
    });

    const mutationId = crypto.randomUUID();
    const settlement = await runPush(
      client,
      await pushArgs({
        clientId,
        mutationId,
        functionName: "replay:insertNull",
        args: { slug: prefix, title: prefix, updatedAt: readTime() },
        inserts: [{ mutationId, ordinal: 0, table: "documents" }],
      }),
    );
    const inserted = settlement.inserts[0]?.id;
    expect(inserted).toBeTypeOf("string");

    const clientLookup = await remoteClientMetadata(client, clientId);
    const metadata = clientLookup.metadata;
    if (!metadata) throw new Error("Expected remote client retention metadata.");
    expect(clientLookup.pagesRead).toBeGreaterThanOrEqual(1);
    expect(metadata).toMatchObject({
      moduleGraphHash: testRuntime.moduleGraphHash,
      protocolVersion: EMBEDDED_PROTOCOL_VERSION,
      retired: false,
      schemaHash: testRuntime.schemaHash,
    });
    expect(metadata.acknowledgedThrough).toBeUndefined();
    expect(metadata.lastPushAt).toBeTypeOf("number");

    await expect(
      client.mutation(api.mutation.remove, {
        clientId,
        identityKey: metadata.identity,
        settledBefore: readTime() + 1_000,
        numItems: 100,
      }),
    ).rejects.toThrow(/has not acknowledged/i);

    const laterMutationId = crypto.randomUUID();
    await runPush(
      client,
      await pushArgs({
        clientId,
        mutationId: laterMutationId,
        acknowledgeReplayId: mutationId,
        functionName: "replay:insertNull",
        args: {
          slug: `${prefix}-later`,
          title: `${prefix}-later`,
          updatedAt: readTime(),
        },
        inserts: [{ mutationId: laterMutationId, ordinal: 0, table: "documents" }],
      }),
    );
    const piggybacked = await client.query(api.mutation.list, {
      identityKey: metadata.identity,
    });
    expect(
      piggybacked.page.find((row: { mutationId: string }) => row.mutationId === mutationId),
    ).toMatchObject({ acknowledged: true });
    expect(
      piggybacked.page.find((row: { mutationId: string }) => row.mutationId === laterMutationId),
    ).toMatchObject({ acknowledged: false });

    await client.mutation(api.embedded.push, {
      request: {
        kind: "acknowledge",
        clientId,
        replayId: laterMutationId,
      },
    });
    const acknowledged = await client.query(api.mutation.list, {
      identityKey: metadata.identity,
    });
    for (const expectedMutationId of [mutationId, laterMutationId]) {
      expect(
        acknowledged.page.find(
          (row: { mutationId: string }) => row.mutationId === expectedMutationId,
        ),
      ).toMatchObject({ acknowledged: true });
    }
    const acknowledgedMetadata = (await remoteClientMetadata(client, clientId)).metadata;
    expect(acknowledgedMetadata?.acknowledgedThrough).toBeTypeOf("number");
    if (!acknowledgedMetadata) throw new Error("Expected acknowledged remote client metadata.");
    expect(
      await client.mutation(api.mutation.remove, {
        clientId,
        identityKey: metadata.identity,
        settledBefore: readTime() + 1_000,
        numItems: 100,
      }),
    ).toMatchObject({ deleted: expect.any(Number), isDone: true });

    await expect(
      client.mutation(api.client.retire, {
        clientId,
        expectedIdentity: metadata.identity,
        expectedLastSeenAt: acknowledgedMetadata.lastSeenAt - 1,
      }),
    ).rejects.toThrow(/changed after it was selected/i);

    expect(
      await client.mutation(api.client.retire, {
        clientId,
        expectedIdentity: metadata.identity,
        expectedLastSeenAt: acknowledgedMetadata.lastSeenAt,
      }),
    ).toEqual({ retirement: "retired" });
    expect(
      await client.mutation(api.client.retire, {
        clientId,
        expectedIdentity: metadata.identity,
        expectedLastSeenAt: acknowledgedMetadata.lastSeenAt,
      }),
    ).toEqual({ retirement: "retired" });
    expect(
      await client.mutation(api.client.retire, {
        clientId: crypto.randomUUID(),
        expectedIdentity: metadata.identity,
        expectedLastSeenAt: acknowledgedMetadata.lastSeenAt,
      }),
    ).toEqual({ retirement: "missing" });
    expect((await remoteClientMetadata(client, clientId)).metadata).toMatchObject({
      retired: true,
    });
    const retiredMutationId = crypto.randomUUID();
    await expect(
      runPush(
        client,
        await pushArgs({
          clientId,
          mutationId: retiredMutationId,
          functionName: "replay:insertNull",
          args: { slug: `${prefix}-retired`, title: prefix, updatedAt: readTime() },
          inserts: [{ mutationId: retiredMutationId, ordinal: 0, table: "documents" }],
        }),
      ),
    ).rejects.toThrow(/retired/i);

    if (inserted) await client.mutation(api.documents.del, { id: inserted as never });
  }, 20_000);

  test("bounds filtered operational scans and revision history pages", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `cut4-${crypto.randomUUID()}`;
    const identityKey = `identity-${prefix}`;
    const table = `table-${prefix}`;
    const storageIds = ["a", "b", "c"].map((suffix) => `\u0001${prefix}-${suffix}`);
    const clientIds = ["a", "b", "c"].map((suffix) => `${prefix}-${suffix}`);
    const unacknowledgedClientId = `${prefix}-unacked`;
    const revisionIds: Array<{ revId: string; rowId: string; table: string }> = [];
    let documentId: string | undefined;

    const commit = async (
      outcome: "applied" | "conflict" | "rejected",
      files: Array<{ storageId: string; delta: number }> = [],
      revisions: Array<
        | { content: "value"; table: string; rowId: string; value: unknown }
        | { content: "deleted"; table: string; rowId: string }
      > = [],
      clientId = "hosted",
    ) => {
      const mutationId = crypto.randomUUID();
      const result = await client.mutation(api.seed.commit, {
        identityKey,
        clientId,
        mutationId,
        outcome,
        files,
        revisions,
      });
      return { mutationId, result };
    };

    try {
      const retained = await commit(
        "conflict",
        storageIds.map((storageId) => ({ storageId, delta: 1 })),
        Array.from({ length: 3 }, (_, index) => ({
          content: "value" as const,
          table,
          rowId: `row-${index}`,
          value: { index },
        })),
      );
      for (const [index, revision] of retained.result.revisions.entries()) {
        expect(revision).toMatchObject({ rowId: `row-${index}`, table });
        revisionIds.push(revision);
      }
      await commit("applied", [{ storageId: storageIds[2]!, delta: -1 }]);

      const firstFilePage = await client.query(api.file.read, {
        state: "unreferenced",
        updatedBefore: readTime() + 60_000,
        paginationOpts: { cursor: null, numItems: 1 },
      });
      expect(firstFilePage).toMatchObject({ page: [], isDone: false });
      const secondFilePage = await client.query(api.file.read, {
        state: "unreferenced",
        updatedBefore: readTime() + 60_000,
        paginationOpts: { cursor: firstFilePage.continueCursor, numItems: 1 },
      });
      expect(secondFilePage.page).toEqual([
        expect.objectContaining({ references: 0, storageId: storageIds[2] }),
      ]);

      await commit("applied", [], [], unacknowledgedClientId);
      await commit("applied", [], [], unacknowledgedClientId);
      const firstMutationPage = await client.query(api.mutation.list, {
        identityKey,
        acknowledged: true,
        paginationOpts: { cursor: null, numItems: 1 },
      });
      expect(firstMutationPage).toMatchObject({ page: [], isDone: false });
      const secondMutationPage = await client.query(api.mutation.list, {
        identityKey,
        acknowledged: true,
        paginationOpts: { cursor: firstMutationPage.continueCursor, numItems: 1 },
      });
      expect(secondMutationPage.page).toHaveLength(1);
      expect(secondMutationPage.page[0]).toMatchObject({ acknowledged: true });

      for (const clientId of clientIds) {
        await client.mutation(api.seed.client, {
          identityKey,
          clientId,
          ...testRuntime,
        });
      }
      const clients = await client.query(api.client.list, {
        identityKey,
        paginationOpts: { cursor: null, numItems: 10 },
      });
      for (const metadata of clients.page.filter((row) =>
        clientIds.slice(0, 2).includes(row.clientId),
      )) {
        await client.mutation(api.client.retire, {
          expectedIdentity: identityKey,
          clientId: metadata.clientId,
          expectedLastSeenAt: metadata.lastSeenAt,
        });
      }
      const firstClientPage = await client.query(api.client.list, {
        identityKey,
        schemaHash: testRuntime.schemaHash,
        retired: false,
        paginationOpts: { cursor: null, numItems: 1 },
      });
      expect(firstClientPage).toMatchObject({ page: [], isDone: false });
      let activeClientPage = firstClientPage;
      while (activeClientPage.page.length === 0 && !activeClientPage.isDone) {
        activeClientPage = await client.query(api.client.list, {
          identityKey,
          schemaHash: testRuntime.schemaHash,
          retired: false,
          paginationOpts: { cursor: activeClientPage.continueCursor, numItems: 1 },
        });
      }
      expect(activeClientPage.page).toEqual([
        expect.objectContaining({ clientId: clientIds[2], retired: false }),
      ]);

      const firstRevisionPage = await client.query(api.revision.scan, {
        table,
        origin: "conflict",
        status: "retained",
        createdBefore: readTime() + 60_000,
        paginationOpts: { cursor: null, numItems: 2 },
      });
      expect(firstRevisionPage).toMatchObject({ isDone: false, page: expect.any(Array) });
      expect(firstRevisionPage.page).toHaveLength(2);
      const secondRevisionPage = await client.query(api.revision.scan, {
        table,
        origin: "conflict",
        status: "retained",
        createdBefore: readTime() + 60_000,
        paginationOpts: { cursor: firstRevisionPage.continueCursor, numItems: 2 },
      });
      expect(secondRevisionPage).toMatchObject({ isDone: true, page: [expect.any(Object)] });
      expect([...firstRevisionPage.page, ...secondRevisionPage.page]).toHaveLength(3);

      const document = await client.mutation(api.documents.write, {
        slug: prefix,
        title: prefix,
      });
      documentId = document._id;
      const savepoints: Array<{ revId: string }> = [];
      for (let count = 1; count <= 3; count += 1) {
        const savepoint = await client.mutation(api.rev.savepoint, { id: document._id });
        savepoints.push(savepoint);
        revisionIds.push({ revId: savepoint.revId, rowId: document._id, table: "documents" });
        const page = await client.query(api.remote.history, {
          id: document._id,
          cursor: null,
          numItems: 2,
        });
        expect(page.page).toHaveLength(Math.min(count, 2));
        expect(page.isDone).toBe(count <= 2);
        if (count === 3) {
          const tail = await client.query(api.remote.history, {
            id: document._id,
            cursor: page.continueCursor,
            numItems: 2,
          });
          expect(tail).toMatchObject({ isDone: true, page: [expect.any(Object)] });
        }
      }
    } finally {
      const finalClientPage = await client.query(api.client.list, {
        identityKey,
        paginationOpts: { cursor: null, numItems: 10 },
      });
      for (const metadata of finalClientPage.page.filter(
        (row) =>
          (clientIds.includes(row.clientId) || row.clientId === unacknowledgedClientId) &&
          !row.retired,
      )) {
        await client.mutation(api.client.retire, {
          expectedIdentity: identityKey,
          clientId: metadata.clientId,
          expectedLastSeenAt: metadata.lastSeenAt,
        });
      }
      for (const revision of revisionIds) {
        await client.mutation(api.revision.remove, { ...revision, numItems: 2 });
      }
      if (documentId !== undefined) {
        await client.mutation(api.documents.del, { id: documentId as never });
      }
      await commit(
        "applied",
        storageIds.slice(0, 2).map((storageId) => ({ storageId, delta: -1 })),
      );
      for (const storageId of storageIds) {
        await client.mutation(api.file.remove, { storageId, expectedVersion: 2 });
      }
      let deletion = { deleted: 0, isDone: false };
      while (!deletion.isDone) {
        deletion = await client.mutation(api.mutation.remove, {
          identityKey,
          settledBefore: readTime() + 60_000,
          numItems: 100,
        });
      }
    }
  }, 30_000);

  test("composes first-party migrations through the Embedded internal mutation", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-migration-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, {
      slug: prefix,
      title: prefix,
      updatedAt: -123,
    });
    await client.mutation(api.migrations.run, {});

    expect((await client.query(api.documents.read, { id: document._id }))[0]).toMatchObject({
      title: `migrated:${prefix}`,
      updatedAt: 123,
    });
    const pulled = await runPull(client, {
      functionName: "documents:read",
      args: { id: document._id },
      runtime: testRuntime,
    });
    expect(pulled.changes).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ title: `migrated:${prefix}`, updatedAt: 123 }),
        op: "put",
        rowId: document._id,
      }),
    );
    await client.mutation(api.documents.del, { id: document._id });
  }, 20_000);

  test("replays one local Node mutation through the V5 native remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-native-"));
    const slug = `v5-native-${crypto.randomUUID()}`;
    const hosted = new ConvexHttpClient(remoteUrl);
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const events: unknown[] = [];
    const stopEvents = client.subscribeInternalEvents((event) => {
      if (event.type !== "remote" && event.type !== "runtime") return;
      events.push(event);
      if (events.length > 40) events.shift();
    });
    const watch = client.watchQuery(api.documents.read, { prefix: slug });
    const stop = watch.onUpdate(() => undefined);
    let hostedId: string | undefined;
    try {
      const local = await client.mutation(api.documents.write, {
        body: "abc",
        slug,
        title: slug,
        updatedAt: readTime(),
      });
      let deadline = getTimerTime() + 15_000;
      let remote = (await hosted.query(api.documents.read, { slug }))[0];
      while (!remote && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { slug }))[0];
      }
      expect(remote).not.toBeNull();
      if (!remote) throw new Error("Native V5 replay did not reach hosted Convex.");
      hostedId = remote._id;
      expect(remote.title).toBe(slug);
      expect(remote._id).not.toBe(local._id);
      const locallySpliced = await client.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 1, delete: 0, insert: "X" }],
      });
      expect(locallySpliced.body).toBe("aXbc");
      deadline = getTimerTime() + 15_000;
      while (remote.body !== "aXbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { slug }))[0];
        if (!remote) throw new Error("Native V5 CRDT target disappeared from hosted Convex.");
      }
      expect(remote.body, JSON.stringify(events)).toBe("aXbc");
    } finally {
      stopEvents();
      stop();
      await client.close();
      if (hostedId !== undefined) {
        await hosted.mutation(api.documents.del, { id: hostedId as never });
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("watches a server-only query through the hosted Convex subscription", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-hosted-watch-"));
    const slug = `v5-hosted-watch-${crypto.randomUUID()}`;
    const hosted = new ConvexHttpClient(remoteUrl);
    const created = await hosted.mutation(api.documents.write, {
      body: "hosted watch",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const listWatch = client.watchQuery(api.documents.read, { prefix: slug });
    const stopList = listWatch.onUpdate(() => undefined);
    let stopHistory: (() => void) | undefined;
    try {
      const pullDeadline = getTimerTime() + 15_000;
      let local = (await client.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < pullDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await client.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("Hosted-watch client did not pull the document.");

      const history = client.watchQuery(api.remote.history, {
        id: local._id,
        cursor: null,
        numItems: 10,
      });
      let latest: { page: Array<{ revId: string }> } | undefined;
      stopHistory = history.onUpdate(() => {
        latest = history.localQueryResult();
      });

      const revision = await hosted.mutation(api.rev.savepoint, { id: created._id });
      const updateDeadline = getTimerTime() + 15_000;
      while (
        !latest?.page.some((row) => row.revId === revision.revId) &&
        getTimerTime() < updateDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(latest?.page).toContainEqual(expect.objectContaining({ revId: revision.revId }));
    } finally {
      stopHistory?.();
      stopList();
      await client.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  test("rebases concurrent CRDT edits by pulling opaque payloads and retrying", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-crdt-rebase-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directories = await Promise.all([
      mkdtemp(join(tmpdir(), "embedded-v5-crdt-a-")),
      mkdtemp(join(tmpdir(), "embedded-v5-crdt-b-")),
    ]);
    const clients = directories.map(
      (directory) =>
        new ConvexEmbeddedClient({
          modules: { documents },
          path: join(directory, "embedded.sqlite3"),
          schema,
          url: remoteUrl,
        }),
    );
    const events: unknown[][] = clients.map(() => []);
    const stopEvents = clients.map((client, index) =>
      client.subscribeInternalEvents((event) => {
        if (event.type !== "remote" && event.type !== "runtime") return;
        events[index]!.push(event);
        if (events[index]!.length > 20) events[index]!.shift();
      }),
    );
    const watches = clients.map((client) => {
      const watch = client.watchQuery(api.documents.read, { prefix: slug });
      return watch.onUpdate(() => undefined);
    });
    try {
      const local = await Promise.all(
        clients.map(async (client) => {
          const deadline = getTimerTime() + 15_000;
          let row = (await client.query(api.documents.read, { slug }))[0];
          while (!row && getTimerTime() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            row = (await client.query(api.documents.read, { slug }))[0];
          }
          if (!row) {
            throw new Error(
              `CRDT test client did not pull the hosted document: ${JSON.stringify(events)}`,
            );
          }
          return row;
        }),
      );
      await Promise.all([
        clients[0]!.mutation(api.documents.write, {
          id: local[0]!._id,
          splices: [{ index: 1, delete: 0, insert: "A" }],
        }),
        clients[1]!.mutation(api.documents.write, {
          id: local[1]!._id,
          splices: [{ index: 1, delete: 0, insert: "B" }],
        }),
      ]);
      const deadline = getTimerTime() + 15_000;
      let remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      while (
        remote &&
        (!remote.body.includes("A") || !remote.body.includes("B")) &&
        getTimerTime() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toHaveLength(5);
      expect(remote?.body).toContain("A");
      expect(remote?.body).toContain("B");
      const hostedBody = remote?.body;
      const convergenceDeadline = getTimerTime() + 15_000;
      let converged = await Promise.all(
        clients.map((client) => client.query(api.documents.read, { slug }).then((rows) => rows[0])),
      );
      while (
        converged.some((row) => row?.body !== hostedBody) &&
        getTimerTime() < convergenceDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        converged = await Promise.all(
          clients.map((client) =>
            client.query(api.documents.read, { slug }).then((rows) => rows[0]),
          ),
        );
      }
      expect(
        converged.map((row) => row?.body),
        JSON.stringify(events),
      ).toEqual([hostedBody, hostedBody]);
    } finally {
      stopEvents.forEach((stop) => stop());
      watches.forEach((stop) => stop());
      await Promise.all(clients.map((client) => client.close()));
      await hosted.mutation(api.documents.del, { id: created._id });
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  }, 25_000);

  test("carries opaque CRDT checkpoints through app-authorized savepoint replay", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-crdt-revision-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "seed",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-crdt-revision-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const watch = client.watchQuery(api.documents.read, { prefix: slug });
    const stop = watch.onUpdate(() => undefined);
    let acceptedPushes = 0;
    let received = 0;
    const remoteErrors: string[] = [];
    const remoteTicks: unknown[] = [];
    const stopEvents = client.subscribeInternalEvents((event) => {
      if (event.type !== "remote") return;
      acceptedPushes += event.tick?.pushAccepted ?? 0;
      received += event.tick?.received ?? 0;
      if (event.tick) {
        remoteTicks.push({
          pullAttempted: event.tick.pullAttempted,
          pushAccepted: event.tick.pushAccepted,
          pushAttempted: event.tick.pushAttempted,
          pushRebases: event.tick.pushRebases,
          received: event.tick.received,
          sent: event.tick.sent,
        });
      }
      if (event.error) remoteErrors.push(event.error);
    });
    try {
      const pullDeadline = getTimerTime() + 15_000;
      let local = (await client.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < pullDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await client.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("CRDT revision client did not pull the document.");
      const receivedAfterInitialPull = received;

      await client.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 4, delete: 0, insert: " saved" }],
      });
      const editDeadline = getTimerTime() + 15_000;
      while (
        (acceptedPushes < 1 || received <= receivedAfterInitialPull) &&
        getTimerTime() < editDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(acceptedPushes).toBeGreaterThanOrEqual(1);
      expect(received).toBeGreaterThan(receivedAfterInitialPull);
      expect(remoteErrors).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await (client as unknown as { __pullRemoteOnce(): Promise<unknown> }).__pullRemoteOnce();

      const revision = await client.mutation(api.rev.savepoint, { id: local._id });
      const savepointDeadline = getTimerTime() + 15_000;
      while (acceptedPushes < 2 && getTimerTime() < savepointDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(acceptedPushes, JSON.stringify(remoteTicks.slice(-20))).toBeGreaterThanOrEqual(2);
      expect(remoteErrors).toEqual([]);
      expect(
        await hosted.query(api.revision.get, { rowId: created._id, revId: revision.revId }),
      ).toMatchObject({
        crdt: [{ field: "body", kind: "text" }],
        rowId: created._id,
        value: { body: "seed saved" },
      });

      await client.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 10, delete: 0, insert: " later" }],
      });
      const laterDeadline = getTimerTime() + 15_000;
      while (acceptedPushes < 3 && getTimerTime() < laterDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(acceptedPushes, JSON.stringify(remoteTicks.slice(-20))).toBeGreaterThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await (client as unknown as { __pullRemoteOnce(): Promise<unknown> }).__pullRemoteOnce();
      await client.mutation(api.remote.restore, { id: local._id, revId: revision.revId });
      const restoreDeadline = getTimerTime() + 15_000;
      while (acceptedPushes < 4 && getTimerTime() < restoreDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(acceptedPushes, JSON.stringify(remoteTicks.slice(-20))).toBeGreaterThanOrEqual(4);
      expect(remoteErrors).toEqual([]);
      expect((await hosted.query(api.documents.read, { id: created._id }))[0]).toMatchObject({
        body: "seed saved",
      });
    } finally {
      stop();
      stopEvents();
      await client.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  test("answers a checkpoint request and pulls after covered payload deletion", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-crdt-checkpoint-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directories = await Promise.all([
      mkdtemp(join(tmpdir(), "embedded-v5-checkpoint-a-")),
      mkdtemp(join(tmpdir(), "embedded-v5-checkpoint-b-")),
    ]);
    const first = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directories[0]!, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const firstWatch = first.watchQuery(api.documents.read, { prefix: slug });
    const stopFirst = firstWatch.onUpdate(() => undefined);
    const remoteEvents: Array<{
      error?: string;
      status: string;
      tick?: {
        pullAttempted?: number;
        pushAccepted?: number;
        pushAttempted?: number;
        pushConflicts?: number;
        pushFailed?: number;
        pushed?: number;
        received?: number;
      };
    }> = [];
    const stopEvents = first.subscribeInternalEvents((event) => {
      if (event.type !== "remote") return;
      remoteEvents.push({
        ...(event.error === undefined ? {} : { error: event.error }),
        status: event.status,
        ...(event.tick === undefined
          ? {}
          : {
              tick: {
                pullAttempted: event.tick.pullAttempted,
                pushAccepted: event.tick.pushAccepted,
                pushAttempted: event.tick.pushAttempted,
                pushConflicts: event.tick.pushConflicts,
                pushFailed: event.tick.pushFailed,
                pushed: event.tick.pushed,
                received: event.tick.received,
              },
            }),
      });
    });
    let second: ConvexEmbeddedClient | undefined;
    let stopSecond: (() => void) | undefined;
    let removed = false;
    try {
      let deadline = getTimerTime() + 15_000;
      let local = (await first.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await first.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("Checkpoint client did not pull the hosted document.");

      await first.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 1, delete: 0, insert: "X" }],
      });
      deadline = getTimerTime() + 15_000;
      let remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      while (remote?.body !== "aXbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toBe("aXbc");

      await first.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 2, delete: 0, insert: "Y" }],
      });
      deadline = getTimerTime() + 15_000;
      while (remote?.body !== "aXYbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toBe("aXYbc");

      await first.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 3, delete: 0, insert: "Z" }],
      });
      deadline = getTimerTime() + 15_000;
      while (remote?.body !== "aXYZbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toBe("aXYZbc");

      const checkpointField = await hosted.query(api.crdt.field, {
        rowId: created._id,
        field: "body",
      });
      if (!checkpointField?.checkpoint) throw new Error("CRDT field has no checkpoint.");
      const firstCheckpointPage = (await hosted.query(api.embedded.pull, {
        request: {
          kind: "checkpoint",
          functionName: "documents:read",
          args: { slug },
          runtime: testRuntime,
          table: "documents",
          rowId: created._id,
          field: "body",
          checkpointId: checkpointField.checkpoint.id,
          epoch: checkpointField.epoch,
          headSeq: checkpointField.headSeq,
          cursor: null,
        },
      })) as {
        chunks: Array<{ ordinal: number }>;
        continueCursor: string | null;
        isDone: boolean;
        payloads: Array<{ seq: number }>;
      };
      expect(firstCheckpointPage.chunks.map((chunk) => chunk.ordinal)).toEqual([0]);
      expect(firstCheckpointPage.payloads).toEqual([]);
      expect(firstCheckpointPage.continueCursor).toBe(
        `payload:${checkpointField.checkpoint.throughSeq}`,
      );
      expect(firstCheckpointPage.isDone).toBe(false);

      const requested = await hosted.mutation(api.crdt.checkpoint, {
        rowId: created._id,
        field: "body",
      });
      expect(requested.state).toBe("requested");
      await expect(
        hosted.mutation(api.crdt.payloadDelete, {
          checkpointId: requested.checkpointId,
          numItems: 100,
        }),
      ).rejects.toThrow(/ready checkpoint/i);
      await (first as unknown as { __pullRemoteOnce(): Promise<unknown> }).__pullRemoteOnce();

      deadline = getTimerTime() + 15_000;
      let field = await hosted.query(api.crdt.field, {
        rowId: created._id,
        field: "body",
      });
      while (field?.checkpoint?.state !== "ready" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        field = await hosted.query(api.crdt.field, {
          rowId: created._id,
          field: "body",
        });
      }
      expect(
        field?.checkpoint,
        JSON.stringify(
          remoteEvents.filter((event) => event.error || (event.tick?.pushAttempted ?? 0) > 0),
        ),
      ).toMatchObject({
        id: requested.checkpointId,
        state: "ready",
        throughSeq: 3,
      });

      const deleted = await hosted.mutation(api.crdt.payloadDelete, {
        checkpointId: requested.checkpointId,
        numItems: 100,
      });
      expect(deleted).toEqual({ deleted: 1, isDone: true });
      const finalCheckpointPage = (await hosted.query(api.embedded.pull, {
        request: {
          kind: "checkpoint",
          functionName: "documents:read",
          args: { slug },
          runtime: testRuntime,
          table: "documents",
          rowId: created._id,
          field: "body",
          checkpointId: checkpointField.checkpoint.id,
          epoch: checkpointField.epoch,
          headSeq: checkpointField.headSeq,
          cursor: firstCheckpointPage.continueCursor,
        },
      })) as { isDone: boolean; payloads: Array<{ seq: number }> };
      expect(finalCheckpointPage.payloads.map((payload) => payload.seq)).toEqual([2, 3]);
      expect(finalCheckpointPage.isDone).toBe(true);

      await first.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 4, delete: 0, insert: "W" }],
      });
      deadline = getTimerTime() + 15_000;
      while (remote?.body !== "aXYZWbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toBe("aXYZWbc");
      field = await hosted.query(api.crdt.field, {
        rowId: created._id,
        field: "body",
      });
      if (!field) throw new Error("Hosted CRDT field disappeared after checkpointing.");
      await expect(
        hosted.mutation(api.crdt.clear, {
          fieldId: field.id,
          expectedEpoch: field.epoch,
          numItems: 100,
        }),
      ).rejects.toThrow(/detached CRDT epoch/i);
      second = new ConvexEmbeddedClient({
        modules: { documents },
        path: join(directories[1]!, "embedded.sqlite3"),
        schema,
        url: remoteUrl,
      });
      const secondWatch = second.watchQuery(api.documents.read, { prefix: slug });
      stopSecond = secondWatch.onUpdate(() => undefined);
      deadline = getTimerTime() + 15_000;
      let pulled = (await second.query(api.documents.read, { slug }))[0];
      while (pulled?.body !== "aXYZWbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        pulled = (await second.query(api.documents.read, { slug }))[0];
      }
      expect(pulled?.body).toBe("aXYZWbc");
      expect((await hosted.query(api.documents.read, { id: created._id }))[0]?.body).toBe(
        "aXYZWbc",
      );
      const revision = await first.mutation(api.rev.savepoint, { id: local._id });
      deadline = getTimerTime() + 15_000;
      let hostedRevision = await hosted.query(api.revision.get, {
        rowId: created._id,
        revId: revision.revId,
      });
      while (!hostedRevision && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        hostedRevision = await hosted.query(api.revision.get, {
          rowId: created._id,
          revId: revision.revId,
        });
      }
      expect(hostedRevision?.crdt).toEqual([
        expect.objectContaining({ field: "body", kind: "text" }),
      ]);
      await first.mutation(api.documents.del, { id: local._id });
      removed = true;
      deadline = getTimerTime() + 15_000;
      while ((await hosted.query(api.documents.read, { id: created._id })).length > 0) {
        if (getTimerTime() >= deadline) throw new Error("Embedded delete did not settle remotely.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await expect(
        hosted.mutation(api.crdt.clear, {
          fieldId: field.id,
          expectedEpoch: field.epoch,
          numItems: 100,
        }),
      ).rejects.toThrow(/retained revision/i);
      expect(
        await hosted.mutation(api.crdt.revisionDelete, {
          rowId: created._id,
          revId: revision.revId,
          numItems: 100,
        }),
      ).toMatchObject({ isDone: true });
      expect(
        await hosted.mutation(api.crdt.clear, {
          fieldId: field.id,
          expectedEpoch: field.epoch,
          numItems: 100,
        }),
      ).toMatchObject({ isDone: true });
    } finally {
      stopFirst();
      stopEvents();
      stopSecond?.();
      await Promise.all([first.close(), second?.close()]);
      if (!removed) await hosted.mutation(api.documents.del, { id: created._id });
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  }, 30_000);

  test("requests and answers a checkpoint before a CRDT tail grows unbounded", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-crdt-auto-checkpoint-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "a",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-auto-checkpoint-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const watch = client.watchQuery(api.documents.read, { prefix: slug });
    const stop = watch.onUpdate(() => undefined);
    try {
      let deadline = getTimerTime() + 15_000;
      let local = (await client.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await client.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("Automatic checkpoint client did not pull the document.");

      let body = "a";
      for (let edit = 0; edit < 17; edit += 1) {
        const insert = String.fromCharCode(98 + edit);
        await client.mutation(api.documents.write, {
          id: local._id,
          splices: [{ index: body.length, delete: 0, insert }],
        });
        body += insert;
        deadline = getTimerTime() + 15_000;
        let remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
        while (remote?.body !== body && getTimerTime() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
        }
        expect(remote?.body).toBe(body);
      }

      deadline = getTimerTime() + 15_000;
      let field = await hosted.query(api.crdt.field, {
        rowId: created._id,
        field: "body",
      });
      while (
        (field?.checkpoint?.state !== "ready" || field.checkpoint.throughSeq !== field.headSeq) &&
        getTimerTime() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        field = await hosted.query(api.crdt.field, {
          rowId: created._id,
          field: "body",
        });
      }
      expect(field?.headSeq).toBe(17);
      expect(field?.checkpoint).toMatchObject({ state: "ready", throughSeq: 17 });
    } finally {
      stop();
      await client.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("executes a scheduled mutation once on the authoritative server", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-schedule-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-schedule-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const watch = client.watchQuery(api.documents.read, { prefix: slug });
    const stop = watch.onUpdate(() => undefined);
    try {
      let deadline = getTimerTime() + 15_000;
      let local = (await client.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await client.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("Schedule client did not pull the hosted document.");

      await client.mutation(api.schedule.append, { id: local._id });
      expect((await client.query(api.documents.read, { slug }))[0]?.title).toBe(slug);

      let remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      while (remote?.title !== `${slug}!` && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.title).toBe(`${slug}!`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await hosted.query(api.documents.read, { id: created._id }))[0]?.title).toBe(
        `${slug}!`,
      );

      let converged = (await client.query(api.documents.read, { slug }))[0];
      while (converged?.title !== `${slug}!` && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        converged = (await client.query(api.documents.read, { slug }))[0];
      }
      expect(converged?.title).toBe(`${slug}!`);
    } finally {
      stop();
      await client.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  test("maps and cancels a hosted schedule through its local ID", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-schedule-cancel-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-schedule-cancel-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const watch = client.watchQuery(api.documents.read, { prefix: slug });
    const stop = watch.onUpdate(() => undefined);
    let acceptedPushes = 0;
    let failedPushes = 0;
    let conflictPushes = 0;
    const remoteErrors: string[] = [];
    const stopEvents = client.subscribeInternalEvents((event) => {
      if (event.type !== "remote") return;
      acceptedPushes += event.tick?.pushAccepted ?? 0;
      failedPushes += event.tick?.pushFailed ?? 0;
      conflictPushes += event.tick?.pushConflicts ?? 0;
      if (event.error) remoteErrors.push(event.error);
    });
    try {
      const deadline = getTimerTime() + 15_000;
      let local = (await client.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await client.query(api.documents.read, { slug }))[0];
      }
      if (!local) throw new Error("Schedule cancellation client did not pull the document.");

      const scheduleId = await client.mutation(api.schedule.appendAfter, {
        id: local._id,
        delayMs: 15_000,
      });
      await client.mutation(api.schedule.cancel, { scheduleId });
      const settlementDeadline = getTimerTime() + 15_000;
      while (
        acceptedPushes + failedPushes + conflictPushes < 2 &&
        getTimerTime() < settlementDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        { acceptedPushes, conflictPushes, failedPushes, remoteErrors },
        "the schedule and cancellation pushes must both apply",
      ).toMatchObject({ acceptedPushes: 2, conflictPushes: 0, failedPushes: 0 });
      await new Promise((resolve) => setTimeout(resolve, 16_000));

      expect((await hosted.query(api.documents.read, { id: created._id }))[0]?.title).toBe(slug);
    } finally {
      stop();
      stopEvents();
      await client.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  test("replays generated upload URLs by ordinal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-upload-url-"));
    const client = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const watch = client.watchQuery(api.documents.read, { prefix: crypto.randomUUID() });
    const stop = watch.onUpdate(() => undefined);
    let acceptedPushes = 0;
    let attemptedPushes = 0;
    let failedPushes = 0;
    const remoteErrors: string[] = [];
    const stopEvents = client.subscribeInternalEvents((event) => {
      if (event.type !== "remote") return;
      acceptedPushes += event.tick?.pushAccepted ?? 0;
      attemptedPushes += event.tick?.pushAttempted ?? 0;
      failedPushes += event.tick?.pushFailed ?? 0;
      if (event.error) remoteErrors.push(event.error);
    });
    try {
      const url = await client.mutation(api.upload.url, {});
      expect(url).toContain("upload");
      const deadline = getTimerTime() + 15_000;
      while (acceptedPushes < 1 && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        { acceptedPushes, attemptedPushes, failedPushes, remoteErrors },
        "the generated upload URL mutation must reach an accepted settlement",
      ).toMatchObject({ acceptedPushes: 1, attemptedPushes: 1, failedPushes: 0, remoteErrors: [] });
    } finally {
      stop();
      stopEvents();
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("journals a direct hosted mutation and pulls its query membership", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-direct-${crypto.randomUUID()}`;
    const created = await client.mutation(api.documents.write, {
      title: prefix,
      slug: prefix,
      updatedAt: readTime(),
    });
    const pull = await runPull(client, {
      functionName: "documents:read",
      args: { prefix },
      runtime: testRuntime,
    });
    expect(pull.changes).toContainEqual(
      expect.objectContaining({ op: "put", rowId: created._id, table: "documents" }),
    );
    await client.mutation(api.documents.del, { id: created._id });
  });

  test("returns only CRDT payloads after the durable client frontier", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const slug = `v5-crdt-delta-${crypto.randomUUID()}`;
    const created = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug,
      title: slug,
      updatedAt: readTime(),
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-v5-crdt-delta-"));
    const embedded = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const events: unknown[] = [];
    const stopEvents = embedded.subscribeInternalEvents((event) => {
      if (event.type === "remote") events.push(event);
    });
    const stop = embedded
      .watchQuery(api.documents.read, { prefix: slug })
      .onUpdate(() => undefined);
    const request = {
      functionName: "documents:read",
      args: { prefix: slug },
      runtime: testRuntime,
    };
    try {
      let deadline = getTimerTime() + 15_000;
      let local = (await embedded.query(api.documents.read, { slug }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await embedded.query(api.documents.read, { slug }))[0];
      }
      if (!local) {
        throw new Error(
          `CRDT delta client did not pull the hosted document: ${JSON.stringify(events)}`,
        );
      }

      await embedded.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 1, delete: 0, insert: "X" }],
      });
      deadline = getTimerTime() + 15_000;
      let remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      while (remote?.body !== "aXbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body).toBe("aXbc");

      expect(await crdtSettlement(hosted, "documents", created._id, "body")).toMatchObject({
        authoritative: [],
        crdt: [{ field: "body", rowId: created._id, table: "documents" }],
      });

      const first = await runPull(hosted, request);
      expect(first.members).toContainEqual({ rowId: created._id, table: "documents" });
      const firstBody = first.crdt.find(
        (field) => field.rowId === created._id && field.field === "body",
      );
      expect(firstBody?.payload).toBeUndefined();
      expect(firstBody?.checkpoint).toBeDefined();
      if (!firstBody) throw new Error("Initial pull did not carry the CRDT body field.");

      await embedded.mutation(api.documents.write, {
        id: local._id,
        splices: [{ index: 2, delete: 0, insert: "Y" }],
      });
      deadline = getTimerTime() + 15_000;
      remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      while (remote?.body !== "aXYbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: created._id }))[0];
      }
      expect(remote?.body, JSON.stringify(events)).toBe("aXYbc");

      const second = await runPull(hosted, request);
      expect(second.members).toEqual(first.members);
      const secondBody = second.crdt.find(
        (field) => field.rowId === created._id && field.field === "body",
      );
      expect(secondBody?.payload?.seq).toBe(firstBody.headSeq + 1);
      expect(secondBody?.checkpoint).toBeDefined();
    } finally {
      stop();
      stopEvents();
      await embedded.close();
      await hosted.mutation(api.documents.del, { id: created._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  test("replays one real mutation and returns the exact idempotent settlement", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const mutationId = crypto.randomUUID();
    const request = await pushArgs({
      mutationId,
      functionName: "replay:insertNull",
      args: { title: mutationId, slug: mutationId, updatedAt: readTime() },
      inserts: [{ mutationId, ordinal: 0, table: "documents" }],
    });
    const first = await runPush(client, request);
    const retry = await runPush(client, request);
    const freshAttempt = await runPush(client, {
      ...request,
      replayId: crypto.randomUUID(),
      mutationTime: request.mutationTime + 1,
    });
    const requestArgs = request.args as Record<string, unknown>;
    expect(first.outcome).toBe("applied");
    expect(retry).toEqual(first);
    expect(freshAttempt).toEqual(first);
    await expect(
      runPush(client, {
        ...request,
        replayId: crypto.randomUUID(),
        logicalFingerprint: crypto.randomUUID(),
        args: { ...requestArgs, updatedAt: Number(requestArgs.updatedAt) + 1 },
      }),
    ).rejects.toThrow(/different logical mutation or replay attempt/i);
    for (const insert of first.inserts) {
      if (insert.table === "documents") {
        await client.mutation(api.documents.del, { id: insert.id as never });
      }
    }
  });

  test("refreshes a cached applied settlement after its document was deleted", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const mutationId = crypto.randomUUID();
    const request = await pushArgs({
      mutationId,
      functionName: "replay:insertNull",
      args: { title: mutationId, slug: mutationId, updatedAt: readTime() },
      inserts: [{ mutationId, ordinal: 0, table: "documents" }],
    });
    const first = await runPush(client, request);
    const document = first.inserts.find((insert) => insert.table === "documents");
    if (!document) throw new Error("Applied insert did not return a document ID.");
    await client.mutation(api.documents.del, { id: document.id as never });

    const replayed = await runPush(client, request);

    expect(replayed.outcome).toBe("applied");
    expect(replayed.authoritative).toContainEqual({
      op: "del",
      table: "documents",
      rowId: document.id,
      plainHash: await hashValue(null),
    });
  });

  test("deduplicates a durable mutation after the worker client id changes", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const mutationId = crypto.randomUUID();
    const firstClientId = `before-reload-${crypto.randomUUID()}`;
    const nextClientId = `after-reload-${crypto.randomUUID()}`;
    const firstRequest = await pushArgs({
      clientId: firstClientId,
      mutationId,
      functionName: "replay:insertNull",
      args: { title: mutationId, slug: mutationId, updatedAt: readTime() },
      inserts: [{ mutationId, ordinal: 0, table: "documents" }],
    });
    const first = await runPush(client, firstRequest);
    const replayed = await runPush(client, {
      ...firstRequest,
      clientId: nextClientId,
    });

    expect(replayed).toEqual(first);
    expect(replayed.inserts).toEqual(first.inserts);
    expect((await remoteClientMetadata(client, firstClientId)).metadata?.acknowledgedThrough).toBe(
      undefined,
    );
    await client.mutation(api.embedded.push, {
      request: { kind: "acknowledge", clientId: nextClientId, replayId: mutationId },
    });
    expect(
      (await remoteClientMetadata(client, firstClientId)).metadata?.acknowledgedThrough,
    ).toBeTypeOf("number");
    for (const insert of first.inserts) {
      if (insert.table === "documents") {
        await client.mutation(api.documents.del, { id: insert.id as never });
      }
    }
  });

  test("rolls back an arbitrary mutation target that cannot write a settlement", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const slug = `v5-rollback-${crypto.randomUUID()}`;
    const mutationId = crypto.randomUUID();
    await expect(
      runPush(
        client,
        await pushArgs({
          mutationId,
          functionName: "invalid:rawMutationTarget",
          args: { slug },
        }),
      ),
    ).rejects.toThrow(/Only mutations created by defineEmbedded can be replayed/i);
    expect(await client.query(api.documents.read, { prefix: slug })).toEqual([]);
  });

  test("preserves normal denial and does not disclose authorization-only reads", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const slug = `v5-denied-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, { slug, title: slug });

    const pulled = await runPull(client, {
      functionName: "documents:read",
      args: { prefix: slug },
      runtime: testRuntime,
    });
    const base = pulled.changes.find(
      (change) => change.op === "put" && change.rowId === document._id,
    );
    if (!base) throw new Error("Expected the denied document in pull.");
    const rejectedTitle = `rejected-${slug}`;
    const rejectedAt = readTime();
    const mutationId = crypto.randomUUID();
    const rejected = await runPush(
      client,
      await pushArgs({
        mutationId,
        functionName: "auth:deniedUpdate",
        args: { id: document._id, title: rejectedTitle, updatedAt: rejectedAt },
        reads: [
          {
            kind: "point",
            table: "documents",
            rowId: document._id,
            plainHash: await hashDocument(document, ["body"]),
            crdt: [],
          },
        ],
        afterImages: [
          {
            content: "value",
            table: "documents",
            rowId: document._id,
            value: {
              body: document.body,
              slug: document.slug,
              title: rejectedTitle,
              updatedAt: rejectedAt,
            },
          },
        ],
      }),
    );
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.revisions).toEqual([]);

    await expect(client.mutation(api.auth.deniedMutation, { slug })).rejects.toThrow();
    await expect(
      runPull(client, {
        functionName: "auth:deniedQuery",
        args: { id: document._id },
        runtime: testRuntime,
      }),
    ).rejects.toThrow();
    expect(await client.query(api.documents.read, { prefix: slug })).toHaveLength(1);
    await client.mutation(api.documents.del, { id: document._id });
  });

  test("removes a row from the complete snapshot after it exits query membership", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-membership-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, { title: prefix, slug: prefix });
    expect(document.updatedAt).toBeGreaterThan(0);
    const request = {
      functionName: "documents:read",
      args: { prefix },
      runtime: testRuntime,
    };
    const first = await runPull(client, request);
    expect(first.members).toContainEqual({ rowId: document._id, table: "documents" });
    await client.mutation(api.documents.write, {
      id: document._id,
      title: `moved-${prefix}`,
      updatedAt: readTime(),
    });
    const second = await runPull(client, request);
    expect(second.members).not.toContainEqual({ rowId: document._id, table: "documents" });
    expect(second.changes).not.toContainEqual(
      expect.objectContaining({ rowId: document._id, table: "documents" }),
    );
    await client.mutation(api.documents.del, { id: document._id });
  });

  test("includes an unchanged row when it enters a limited query window", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-window-${crypto.randomUUID()}`;
    const older = await client.mutation(api.documents.write, {
      title: `${prefix}-b-older`,
      slug: `${prefix}-older`,
    });
    const newer = await client.mutation(api.documents.write, {
      title: `${prefix}-a-newer`,
      slug: `${prefix}-newer`,
    });
    const request = {
      functionName: "documents:read",
      args: { limit: 1, prefix },
      runtime: testRuntime,
    };
    const first = await runPull(client, request);
    expect(first.members).toEqual([{ rowId: newer._id, table: "documents" }]);

    await client.mutation(api.documents.del, { id: newer._id });
    const second = await runPull(client, request);
    expect(second.members).toEqual([{ rowId: older._id, table: "documents" }]);
    expect(second.changes).toContainEqual(
      expect.objectContaining({ op: "put", rowId: older._id, table: "documents" }),
    );
    await client.mutation(api.documents.del, { id: older._id });
  });

  test("makes retained-query membership transitions self-contained", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-window-reentry-${crypto.randomUUID()}`;
    const first = await client.mutation(api.documents.write, {
      title: `${prefix}-b-first`,
      slug: `${prefix}-first`,
    });
    const second = await client.mutation(api.documents.write, {
      title: `${prefix}-a-second`,
      slug: `${prefix}-second`,
    });
    const request = {
      functionName: "documents:read",
      args: { limit: 1, prefix },
      runtime: testRuntime,
    };
    const baseline = await runPull(client, request);
    expect(baseline.members).toEqual([{ rowId: second._id, table: "documents" }]);

    const replacement = await client.mutation(api.documents.write, {
      title: `${prefix}-0-replacement`,
      slug: `${prefix}-replacement`,
    });
    const entered = await runPull(client, request);
    expect(entered.members).toEqual([{ rowId: replacement._id, table: "documents" }]);
    expect(entered.changes).toContainEqual(
      expect.objectContaining({ op: "put", rowId: replacement._id, table: "documents" }),
    );

    await client.mutation(api.documents.del, { id: replacement._id });
    const reentered = await runPull(client, request);
    expect(reentered.members).toEqual([{ rowId: second._id, table: "documents" }]);
    expect(reentered.changes).toContainEqual(
      expect.objectContaining({ op: "put", rowId: second._id, table: "documents" }),
    );

    await Promise.all(
      [first._id, second._id].map((id) => client.mutation(api.documents.del, { id })),
    );
  });

  test("rolls back a replay when a plain point witness moved", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-conflict-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, { title: prefix, slug: prefix });
    const pulled = await runPull(client, {
      functionName: "documents:read",
      args: { prefix },
      runtime: testRuntime,
    });
    const base = pulled.changes.find(
      (change) => change.op === "put" && change.rowId === document._id,
    );
    if (!base) throw new Error("Expected the created document in pull.");
    const hostedTitle = `hosted-${prefix}`;
    await client.mutation(api.documents.write, {
      id: document._id,
      title: hostedTitle,
      updatedAt: readTime(),
    });

    const mutationId = crypto.randomUUID();
    const localTitle = `local-${prefix}`;
    const localUpdatedAt = readTime();
    const request = await pushArgs({
      mutationId,
      functionName: "documents:write",
      args: { id: document._id, title: localTitle, updatedAt: localUpdatedAt },
      reads: [
        {
          kind: "point",
          table: "documents",
          rowId: document._id,
          plainHash: await hashDocument(document),
          crdt: [],
        },
      ],
      afterImages: [
        {
          content: "value",
          table: "documents",
          rowId: document._id,
          value: {
            body: document.body,
            slug: document.slug,
            title: localTitle,
            updatedAt: localUpdatedAt,
          },
        },
      ],
    });
    const settlement = await runPush(client, request);
    expect(settlement.outcome).toBe("conflict");
    expect(settlement.revisions).toHaveLength(1);
    expect(settlement.revisions[0]).toMatchObject({
      table: "documents",
      rowId: document._id,
    });
    const retry = await runPush(client, request);
    expect(retry.revisions).toEqual(settlement.revisions);
    expect(
      (await client.query(api.revision.list, { rowId: document._id, cursor: null })).page,
    ).toHaveLength(1);
    expect((await client.query(api.documents.read, { id: document._id }))[0]?.title).toBe(
      hostedTitle,
    );
    await client.mutation(api.documents.del, { id: document._id });
  });

  test("does not retain an equal after-image merely because its witness moved", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-equal-conflict-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, { title: prefix, slug: prefix });
    const title = `${prefix}-same`;
    const updatedAt = readTime();
    try {
      await client.mutation(api.documents.write, { id: document._id, title, updatedAt });
      const settlement = await runPush(
        client,
        await pushArgs({
          mutationId: crypto.randomUUID(),
          functionName: "documents:write",
          args: { id: document._id, title, updatedAt },
          reads: [
            {
              kind: "point",
              table: "documents",
              rowId: document._id,
              plainHash: await hashDocument(document),
              crdt: [],
            },
          ],
          afterImages: [
            {
              content: "value",
              table: "documents",
              rowId: document._id,
              value: { body: document.body, slug: document.slug, title, updatedAt },
            },
          ],
        }),
      );

      expect(settlement.outcome).toBe("conflict");
      expect(settlement.revisions).toEqual([]);
      expect(
        (await client.query(api.revision.list, { rowId: document._id, cursor: null })).page,
      ).toEqual([]);
    } finally {
      await client.mutation(api.documents.del, { id: document._id });
    }
  });

  test("shares only verified conflicting after-images from a failed grouped write", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-group-${crypto.randomUUID()}`;
    const first = await client.mutation(api.documents.write, {
      body: "one",
      slug: `${prefix}-one`,
      title: `${prefix}-one`,
      updatedAt: 1,
    });
    const second = await client.mutation(api.documents.write, {
      body: "two",
      slug: `${prefix}-two`,
      title: `${prefix}-two`,
      updatedAt: 1,
    });
    try {
      const hostedTitle = `${prefix}-hosted`;
      await client.mutation(api.documents.write, {
        id: first._id,
        title: hostedTitle,
        updatedAt: 2,
      });
      const firstTitle = `${prefix}-local-one`;
      const secondTitle = `${prefix}-local-two`;
      const updatedAt = 3;
      const mutationId = crypto.randomUUID();
      const settlement = await runPush(
        client,
        await pushArgs({
          mutationId,
          functionName: "replay:updatePair",
          args: {
            first: first._id,
            second: second._id,
            firstTitle,
            secondTitle,
            updatedAt,
          },
          reads: [
            {
              kind: "point",
              table: "documents",
              rowId: first._id,
              plainHash: await hashDocument(first, ["body"]),
              crdt: [],
            },
            {
              kind: "point",
              table: "documents",
              rowId: second._id,
              plainHash: await hashDocument(second, ["body"]),
              crdt: [],
            },
          ],
          afterImages: [
            {
              content: "value",
              table: "documents",
              rowId: first._id,
              value: {
                body: first.body,
                slug: first.slug,
                title: firstTitle,
                updatedAt,
              },
            },
            {
              content: "value",
              table: "documents",
              rowId: second._id,
              value: {
                body: second.body,
                slug: second.slug,
                title: secondTitle,
                updatedAt,
              },
            },
          ],
        }),
      );
      expect(settlement.outcome).toBe("conflict");
      expect(settlement.revisions).toHaveLength(2);
      expect(settlement.revisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "documents", rowId: first._id }),
          expect.objectContaining({ table: "documents", rowId: second._id }),
        ]),
      );
      expect((await client.query(api.documents.read, { id: first._id }))[0]?.title).toBe(
        hostedTitle,
      );
      expect((await client.query(api.documents.read, { id: second._id }))[0]?.title).toBe(
        second.title,
      );
    } finally {
      await Promise.all([
        client.mutation(api.documents.del, { id: first._id }),
        client.mutation(api.documents.del, { id: second._id }),
      ]);
    }
  });

  test("never lets an unrelated wire witness choose correction or revision rows", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-witness-boundary-${crypto.randomUUID()}`;
    const changed = await client.mutation(api.documents.write, {
      body: "changed",
      slug: `${prefix}-changed`,
      title: `${prefix}-changed`,
      updatedAt: 1,
    });
    const unrelated = await client.mutation(api.documents.write, {
      body: "private",
      slug: `${prefix}-unrelated`,
      title: `${prefix}-unrelated`,
      updatedAt: 1,
    });
    try {
      await client.mutation(api.documents.write, {
        id: unrelated._id,
        title: `${prefix}-hosted`,
        updatedAt: 2,
      });
      const localTitle = `${prefix}-local`;
      const settlement = await runPush(
        client,
        await pushArgs({
          mutationId: crypto.randomUUID(),
          functionName: "documents:write",
          args: { id: changed._id, title: localTitle, updatedAt: 3 },
          reads: [
            {
              kind: "point",
              table: "documents",
              rowId: unrelated._id,
              plainHash: await hashDocument(unrelated, ["body"]),
              crdt: [],
            },
          ],
          afterImages: [
            {
              content: "value",
              table: "documents",
              rowId: changed._id,
              value: {
                body: changed.body,
                slug: changed.slug,
                title: localTitle,
                updatedAt: 3,
              },
            },
            {
              content: "value",
              table: "documents",
              rowId: unrelated._id,
              value: {
                body: unrelated.body,
                slug: unrelated.slug,
                title: unrelated.title,
                updatedAt: unrelated.updatedAt,
              },
            },
          ],
        }),
      );

      expect(settlement.outcome).toBe("conflict");
      expect(settlement.authoritative).toEqual([
        expect.objectContaining({ rowId: changed._id, table: "documents" }),
      ]);
      expect(settlement.revisions).toEqual([
        expect.objectContaining({ rowId: changed._id, table: "documents" }),
      ]);
      expect(
        (await client.query(api.revision.list, { rowId: unrelated._id, cursor: null })).page,
      ).toEqual([]);
    } finally {
      await Promise.all([
        client.mutation(api.documents.del, { id: changed._id }),
        client.mutation(api.documents.del, { id: unrelated._id }),
      ]);
    }
  });

  test("exposes app-authorized savepoint, paging, restore, and bounded deletion", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const title = `v5-rev-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, {
      body: "one",
      slug: title,
      title,
    });
    try {
      const first = await client.mutation(api.rev.savepoint, { id: document._id });
      await client.mutation(api.documents.write, {
        id: document._id,
        title: `${title}-two`,
        updatedAt: readTime(),
      });
      const second = await client.mutation(api.rev.savepoint, { id: document._id });

      const firstPage = await client.query(api.remote.history, {
        id: document._id,
        cursor: null,
        numItems: 1,
      });
      expect(firstPage).toMatchObject({ isDone: false, page: [{ revId: second.revId }] });
      const secondPage = await client.query(api.remote.history, {
        id: document._id,
        cursor: firstPage.continueCursor,
        numItems: 1,
      });
      expect(secondPage).toMatchObject({ isDone: true, page: [{ revId: first.revId }] });

      expect(
        await client.mutation(api.remote.restore, { id: document._id, revId: first.revId }),
      ).toMatchObject({ document: { title } });
      await expect(
        client.mutation(api.revision.remove, {
          table: "documents",
          rowId: document._id,
          revId: first.revId,
          numItems: 1,
        }),
      ).rejects.toThrow(/active revision/i);

      expect(
        await client.mutation(api.remote.restore, { id: document._id, revId: second.revId }),
      ).toMatchObject({ document: { title: `${title}-two` } });
      expect(
        await client.mutation(api.revision.remove, {
          table: "documents",
          rowId: document._id,
          revId: first.revId,
          numItems: 1,
        }),
      ).toEqual({ deleted: 1, isDone: true });
      expect(
        (
          await client.query(api.remote.history, {
            id: document._id,
            cursor: null,
            numItems: 10,
          })
        ).page.map((revision) => revision.revId),
      ).toEqual([second.revId]);
    } finally {
      await client.mutation(api.documents.del, { id: document._id });
    }
  });

  test("reproduces a bounded index range and conflicts when its contents move", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `v5-range-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, {
      title: prefix,
      slug: prefix,
      updatedAt: readTime(),
    });
    const rows = await client.query(api.documents.read, { limit: 40 });
    const membersHash = await hashValue(
      await Promise.all(
        rows.map(async (row: Record<string, unknown> & { _id: string }) => ({
          id: row._id,
          hash: await hashDocument(row),
        })),
      ),
    );
    const hostedTitle = `hosted-${prefix}`;
    await client.mutation(api.documents.write, {
      id: document._id,
      title: hostedTitle,
      updatedAt: document.updatedAt,
    });

    const mutationId = crypto.randomUUID();
    const settlement = await runPush(
      client,
      await pushArgs({
        mutationId,
        functionName: "documents:write",
        args: { id: document._id, title: `local-${prefix}`, updatedAt: document.updatedAt },
        reads: [
          {
            kind: "range",
            table: "documents",
            index: "by_updatedAt",
            equality: [],
            limit: 40,
            order: "desc",
            membersHash,
          },
        ],
      }),
    );
    expect(settlement.outcome).toBe("conflict");
    expect((await client.query(api.documents.read, { id: document._id }))[0]?.title).toBe(
      hostedTitle,
    );
    await client.mutation(api.documents.del, { id: document._id });
  });
});

async function remoteClientMetadata(
  client: ConvexHttpClient,
  clientId: string,
): Promise<{ metadata: RemoteClientMetadata | undefined; pagesRead: number }> {
  let cursor: string | null = null;
  let pagesRead = 0;
  for (;;) {
    const clients: {
      continueCursor: string;
      isDone: boolean;
      page: RemoteClientMetadata[];
    } = await client.query(api.client.list, {
      paginationOpts: { cursor, numItems: 100 },
    });
    pagesRead += 1;
    const metadata = clients.page.find((row) => row.clientId === clientId);
    if (metadata !== undefined) return { metadata, pagesRead };
    if (clients.isDone) return { metadata: undefined, pagesRead };
    if (clients.continueCursor === cursor) {
      throw new Error("Remote client pagination did not advance.");
    }
    cursor = clients.continueCursor;
  }
}
