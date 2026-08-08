import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionArgs, type FunctionReturnType } from "convex/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { api } from "../../../../convex/_generated/api";
import schema from "../../../../convex/schema";
import { ConvexEmbeddedClient } from "../../src/node/client";
import { readDevtoolsBridge } from "../../src/devtools/bridge";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";
import { getTimerTime } from "../../src/time";
import { read as readTime } from "../testkit/time";
import { fixtureAdminKey, fixtureRemoteUrl } from "../testkit/remote";
import * as documents from "../fixture/convex/documents";

const remoteUrl = fixtureRemoteUrl();
const requestCheckpoint = makeFunctionReference<
  "mutation",
  { rowId: string; field: string },
  { checkpointId: string; state: "requested" | "ready" }
>("crdt:checkpoint");
const readCrdtField = makeFunctionReference<"query", { rowId: string; field: string }, any>(
  "crdt:field",
);
const readAuthorizedDocument = makeFunctionReference<"query", { id: string }, Document | null>(
  "auth:read",
);
const pageDocuments = makeFunctionReference<
  "query",
  {
    paginationOpts: { cursor: string | null; numItems: number };
    prefix: string;
  },
  DocumentPage
>("documents:page");
const BLOB_CHUNK_BYTES = 196_608;
const runtime = {
  schemaHash: "production-contract",
  moduleGraphHash: "production-contract",
  protocolVersion: EMBEDDED_PROTOCOL_VERSION,
};

type PullArgs = Extract<FunctionArgs<typeof api.embedded.pull>["request"], { kind: "live" }>;
type PullResult = Extract<FunctionReturnType<typeof api.embedded.pull>, { members: unknown }>;

interface Document {
  _creationTime: number;
  _id: string;
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
}

interface DocumentPage {
  continueCursor: string;
  isDone: boolean;
  page: Document[];
}

async function pull(client: ConvexHttpClient, args: Omit<PullArgs, "kind">): Promise<PullResult> {
  const result = await client.query(api.embedded.pull, {
    request: { kind: "live", ...args },
  });
  if (!("members" in result)) throw new Error("Pull did not return a live result.");
  return result;
}

describe("v5 production pull contract", () => {
  test("rejects a stale protocol before reading app data", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    await expect(
      pull(client, {
        functionName: "documents:read",
        args: { limit: 1 },
        runtime: { ...runtime, protocolVersion: EMBEDDED_PROTOCOL_VERSION - 1 },
      }),
    ).rejects.toThrow();
  });

  test("derives complete membership from the app-authorized prefix query", async () => {
    const client = new ConvexHttpClient(remoteUrl);
    const prefix = `production-pull-${crypto.randomUUID()}`;
    const document = await client.mutation(api.documents.write, {
      slug: prefix,
      title: prefix,
    });
    try {
      const page = await pull(client, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      expect(page.members).toEqual([{ table: "documents", rowId: document._id }]);
      expect(page.changes).toContainEqual(
        expect.objectContaining({ op: "put", rowId: document._id, table: "documents" }),
      );
    } finally {
      await client.mutation(api.documents.del, { id: document._id });
    }
  });

  test("preserves normal authorization through the retained app query", async () => {
    const anonymous = new ConvexHttpClient(remoteUrl);
    const authenticated = new ConvexHttpClient(remoteUrl);
    (
      authenticated as unknown as {
        setAdminAuth(token: string, identity: { issuer: string; subject: string }): void;
      }
    ).setAdminAuth(fixtureAdminKey(), {
      issuer: "https://cut2.embedded.test",
      subject: `cut2-${crypto.randomUUID()}`,
    });
    const prefix = `production-auth-${crypto.randomUUID()}`;
    const document = await anonymous.mutation(api.documents.write, {
      slug: prefix,
      title: prefix,
    });
    try {
      await expect(
        pull(anonymous, {
          functionName: "auth:read",
          args: { id: document._id },
          runtime,
        }),
      ).rejects.toThrow();
      const page = await pull(authenticated, {
        functionName: "auth:read",
        args: { id: document._id },
        runtime,
      });
      expect(page.members).toEqual([{ table: "documents", rowId: document._id }]);
      expect(await authenticated.query(readAuthorizedDocument, { id: document._id })).toMatchObject(
        { _id: document._id },
      );
    } finally {
      await anonymous.mutation(api.documents.del, { id: document._id });
    }
  });

  test("applies a hosted retained-query transition without a local pull", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const prefix = `production-transition-${crypto.randomUUID()}`;
    const document = await hosted.mutation(api.documents.write, {
      slug: prefix,
      title: prefix,
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-production-transition-"));
    const embedded = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    let updates = 0;
    const stop = embedded.watchQuery(api.documents.read, { prefix }).onUpdate(() => {
      updates += 1;
    });
    let unrelated: string | undefined;
    try {
      const deadline = getTimerTime() + 15_000;
      let local = (await embedded.query(api.documents.read, { slug: prefix }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await embedded.query(api.documents.read, { slug: prefix }))[0];
      }
      expect(local?.slug).toBe(prefix);

      const updatesBeforeUnrelatedWrite = await stableCount(() => updates);
      const unrelatedDocument = await hosted.mutation(api.documents.write, {
        slug: `unrelated-${crypto.randomUUID()}`,
        title: `unrelated-${crypto.randomUUID()}`,
      });
      unrelated = unrelatedDocument._id;
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(updates).toBe(updatesBeforeUnrelatedWrite);

      const title = `${prefix}-hosted`;
      await hosted.mutation(api.documents.write, {
        id: document._id,
        title,
        updatedAt: readTime(),
      });

      while (local?.title !== title && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await embedded.query(api.documents.read, { slug: prefix }))[0];
      }
      expect(local?.title).toBe(title);
      expect(updates).toBeGreaterThan(updatesBeforeUnrelatedWrite);
    } finally {
      stop();
      await embedded.close();
      if (unrelated) await hosted.mutation(api.documents.del, { id: unrelated as never });
      await hosted.mutation(api.documents.del, { id: document._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("returns only the CRDT payload after the accepted durable head", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const prefix = `production-crdt-${crypto.randomUUID()}`;
    const document = await hosted.mutation(api.documents.write, {
      body: "abc",
      slug: prefix,
      title: prefix,
    });
    const directory = await mkdtemp(join(tmpdir(), "embedded-production-crdt-"));
    const embedded = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directory, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const stop = embedded.watchQuery(api.documents.read, { prefix }).onUpdate(() => undefined);
    const reactive = new ConvexClient(remoteUrl);
    let reactiveBody: PullResult["crdt"][number] | undefined;
    const stopReactive = reactive.onUpdate(
      api.embedded.pull,
      {
        request: {
          kind: "live",
          functionName: "documents:read",
          args: { prefix },
          runtime,
        },
      },
      (result) => {
        if (!("crdt" in result)) return;
        reactiveBody = result.crdt.find(
          (field) => field.field === "body" && field.rowId === document._id,
        );
      },
    );
    try {
      let deadline = getTimerTime() + 15_000;
      let local = (await embedded.query(api.documents.read, { slug: prefix }))[0];
      while (!local && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        local = (await embedded.query(api.documents.read, { slug: prefix }))[0];
      }
      if (!local) throw new Error("Embedded client did not pull the production document.");

      await embedded.mutation(api.documents.write, {
        id: local._id,
        splices: [{ delete: 0, index: 1, insert: "X" }],
      });
      deadline = getTimerTime() + 15_000;
      let remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      while (remote?.body !== "aXbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      }
      expect(remote?.body).toBe("aXbc");

      const first = await pull(hosted, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      const firstBody = first.crdt.find(
        (field) => field.field === "body" && field.rowId === document._id,
      );
      expect(firstBody?.payload).toBeUndefined();
      expect(firstBody?.checkpoint).toBeDefined();
      if (!firstBody) throw new Error("Initial pull did not contain the CRDT field.");

      await embedded.mutation(api.documents.write, {
        id: local._id,
        splices: [{ delete: 0, index: 2, insert: "Y" }],
      });
      deadline = getTimerTime() + 15_000;
      remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      while (remote?.body !== "aXYbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      }
      expect(remote?.body).toBe("aXYbc");

      const beforeRequest = await pull(hosted, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      const beforeRequestBody = beforeRequest.crdt.find(
        (field) => field.field === "body" && field.rowId === document._id,
      );
      expect(beforeRequestBody?.checkpoint.seq).toBe(firstBody.headSeq);
      expect(beforeRequestBody?.payload?.seq).toBe(firstBody.headSeq + 1);

      const requested = await hosted.mutation(requestCheckpoint, {
        rowId: document._id,
        field: "body",
      });
      expect(requested.state).toBe("requested");
      await waitUntil(
        async () => reactiveBody,
        (field) => field?.checkpointRequest?.checkpointId === requested.checkpointId,
        "official Convex component transition",
      );
      const requestedPage = await pull(hosted, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      const requestedBody = requestedPage.crdt.find(
        (field) => field.field === "body" && field.rowId === document._id,
      );
      expect(requestedBody?.checkpointRequest).toMatchObject({
        checkpointId: requested.checkpointId,
        throughSeq: beforeRequestBody?.headSeq,
      });

      deadline = getTimerTime() + 15_000;
      let checkpointField = await hosted.query(readCrdtField, {
        rowId: document._id,
        field: "body",
      });
      while (
        (checkpointField?.checkpoint?.id !== requested.checkpointId ||
          checkpointField.checkpoint.state !== "ready") &&
        getTimerTime() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        checkpointField = await hosted.query(readCrdtField, {
          rowId: document._id,
          field: "body",
        });
      }
      expect(checkpointField?.checkpoint).toMatchObject({
        id: requested.checkpointId,
        state: "ready",
        throughSeq: beforeRequestBody?.headSeq,
      });

      const checkpointed = await pull(hosted, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      const checkpointedBody = checkpointed.crdt.find(
        (field) => field.field === "body" && field.rowId === document._id,
      );
      expect(checkpointedBody?.checkpoint.seq).toBe(beforeRequestBody?.headSeq);
      expect(checkpointedBody?.payload).toBeUndefined();

      await embedded.mutation(api.documents.write, {
        id: local._id,
        splices: [{ delete: 0, index: 3, insert: "Z" }],
      });
      deadline = getTimerTime() + 15_000;
      remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      while (remote?.body !== "aXYZbc" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remote = (await hosted.query(api.documents.read, { id: document._id }))[0];
      }
      expect(remote?.body).toBe("aXYZbc");

      const afterCheckpoint = await pull(hosted, {
        functionName: "documents:read",
        args: { prefix },
        runtime,
      });
      const afterCheckpointBody = afterCheckpoint.crdt.find(
        (field) => field.field === "body" && field.rowId === document._id,
      );
      expect(afterCheckpointBody?.checkpoint.seq).toBe(beforeRequestBody?.headSeq);
      expect(afterCheckpointBody?.payload?.seq).toBe((beforeRequestBody?.headSeq ?? 0) + 1);
    } finally {
      stop();
      stopReactive();
      await reactive.close();
      await embedded.close();
      await hosted.mutation(api.documents.del, { id: document._id });
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  test("pulls a checkpoint larger than one Convex value into a fresh client", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const prefix = `production-large-${crypto.randomUUID()}`;
    const body = largeBody(350_000);
    const document = await hosted.mutation(api.documents.write, {
      body,
      slug: prefix,
      title: prefix,
    });
    const directories = await Promise.all([
      mkdtemp(join(tmpdir(), "embedded-production-large-a-")),
      mkdtemp(join(tmpdir(), "embedded-production-large-b-")),
    ]);
    const first = new ConvexEmbeddedClient({
      modules: { documents },
      path: join(directories[0]!, "embedded.sqlite3"),
      schema,
      url: remoteUrl,
    });
    const stopFirst = first.watchQuery(api.documents.read, { prefix }).onUpdate(() => undefined);
    let second: ConvexEmbeddedClient | undefined;
    let stopSecond: (() => void) | undefined;
    try {
      const [local] = await waitUntil(
        () => first.query(api.documents.read, { slug: prefix }),
        (value) => value.length > 0,
        "large checkpoint source pull",
      );
      if (!local) throw new Error("Large checkpoint source document disappeared.");
      const expectedBody = `${body.slice(0, 1)}X${body.slice(1)}`;
      await first.mutation(api.documents.write, {
        id: local._id,
        splices: [{ delete: 0, index: 1, insert: "X" }],
      });
      await waitUntil(
        () => hosted.query(api.documents.read, { id: document._id }),
        (value) => value[0]?.body === expectedBody,
        "large checkpoint hosted replay",
      );
      const field = await waitUntil(
        () => hosted.query(readCrdtField, { rowId: document._id, field: "body" }),
        (value) =>
          value?.checkpoint?.state === "ready" &&
          typeof value.checkpoint.bytes === "number" &&
          value.checkpoint.bytes > BLOB_CHUNK_BYTES,
        "multi-chunk checkpoint",
      );
      expect(field.checkpoint.bytes).toBeGreaterThan(BLOB_CHUNK_BYTES);

      second = new ConvexEmbeddedClient({
        modules: { documents },
        path: join(directories[1]!, "embedded.sqlite3"),
        schema,
        url: remoteUrl,
      });
      stopSecond = second.watchQuery(api.documents.read, { prefix }).onUpdate(() => undefined);
      const [fresh] = await waitUntil(
        () => second!.query(api.documents.read, { slug: prefix }),
        (value) => value[0]?.body === expectedBody,
        "multi-chunk checkpoint pull",
      );
      if (!fresh) throw new Error("Fresh client did not retain the large checkpoint document.");
      expect(fresh.body).toBe(expectedBody);
    } finally {
      stopSecond?.();
      await second?.close();
      stopFirst();
      await first.close();
      await hosted.mutation(api.documents.del, { id: document._id });
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  }, 45_000);

  test("resolves an offline pagination boundary before retaining the hosted page", async () => {
    const hosted = new ConvexHttpClient(remoteUrl);
    const prefix = `production-cursor-${crypto.randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "embedded-production-cursor-"));
    const path = join(directory, "embedded.sqlite3");
    let offline: ConvexEmbeddedClient | undefined;
    let live: ConvexEmbeddedClient | undefined;
    let stopLive: (() => void) | undefined;
    let stopEvents: (() => void) | undefined;
    const remoteEvents: unknown[] = [];
    let hostedDocuments: Array<FunctionReturnType<typeof api.documents.read>[number]> = [];
    try {
      offline = new ConvexEmbeddedClient({ modules: { documents }, path, schema });
      await Promise.all(
        ["1", "2", "3"].map((suffix) =>
          offline!.mutation(api.documents.write, {
            slug: `${prefix}-${suffix}`,
            title: `${prefix}-${suffix}`,
          }),
        ),
      );
      const first = await offline.query(pageDocuments, {
        paginationOpts: { cursor: null, numItems: 1 },
        prefix,
      });
      expect(first.page).toHaveLength(1);
      await offline.close();
      offline = undefined;

      live = new ConvexEmbeddedClient({ modules: { documents }, path, schema, url: remoteUrl });
      stopEvents = readDevtoolsBridge(live).subscribe((event) => {
        if (event.type === "remote") remoteEvents.push(event);
      });
      expect(await live.query(api.documents.read, { prefix })).toHaveLength(3);
      const args = {
        paginationOpts: { cursor: first.continueCursor, numItems: 1 },
        prefix,
      };
      stopLive = live.watchQuery(pageDocuments, args).onUpdate(() => undefined);
      try {
        hostedDocuments = await waitUntil(
          () => hosted.query(api.documents.read, { prefix }),
          (value) => value.length === 3,
          "offline document replay",
        );
      } catch (error) {
        throw new Error(
          `Offline replay did not settle: ${JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            connection: live.connectionState(),
            local: (await live.query(api.documents.read, { prefix })).length,
            remoteEvents,
          })}`,
        );
      }
      let second: DocumentPage;
      try {
        second = await waitUntil(
          () => live!.query(pageDocuments, args),
          (value) => value.page[0]?.title === `${prefix}-2`,
          "hosted cursor resolution",
        );
      } catch (error) {
        throw new Error(
          `Hosted cursor did not resolve locally: ${JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            current: await live.query(pageDocuments, args),
            remoteEvents,
          })}`,
        );
      }
      const updatedAt = readTime() + 1_000;
      await hosted.mutation(api.documents.write, {
        id: hostedDocuments[1]!._id,
        updatedAt,
      });
      let transitioned: DocumentPage;
      try {
        transitioned = await waitUntil(
          () => live!.query(pageDocuments, args),
          (value) => value.page[0]?.updatedAt === updatedAt,
          "retained cursor transition",
        );
      } catch (error) {
        throw new Error(
          `Retained cursor did not transition locally: ${JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            current: await live.query(pageDocuments, args),
            hosted: await hosted.query(api.documents.read, { prefix }),
            connection: live.connectionState(),
            remoteEvents,
          })}`,
        );
      }
      expect(second.page[0]?._id).toBe(transitioned.page[0]?._id);
    } finally {
      stopEvents?.();
      stopLive?.();
      await live?.close();
      await offline?.close();
      await Promise.all(
        hostedDocuments.map((document) => hosted.mutation(api.documents.del, { id: document._id })),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});

async function waitUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = getTimerTime() + timeoutMs;
  let value = await read();
  while (!accept(value) && getTimerTime() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  if (!accept(value)) throw new Error(`Timed out waiting for ${label}.`);
  return value;
}

async function stableCount(read: () => number, quietMs = 250, timeoutMs = 2_000): Promise<number> {
  const deadline = getTimerTime() + timeoutMs;
  let value = read();
  let unchangedSince = getTimerTime();
  while (getTimerTime() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const next = read();
    if (next !== value) {
      value = next;
      unchangedSince = getTimerTime();
    } else if (getTimerTime() - unchangedSince >= quietMs) {
      return value;
    }
  }
  throw new Error("Timed out waiting for the retained-query callback baseline.");
}

function largeBody(bytes: number): string {
  const body = new Uint8Array(bytes);
  let state = 0x9e3779b9;
  for (let index = 0; index < body.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    body[index] = 32 + ((state >>> 0) % 95);
  }
  return new TextDecoder().decode(body);
}
