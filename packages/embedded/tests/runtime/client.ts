import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { EmbeddedClient } from "../../src/client";
import { createConvexEmbeddedClientForTest } from "../../src/node/client";
import { NativeStore } from "../../src/node/native";
import {
  EMBEDDED_PROTOCOL_VERSION,
  EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
} from "../../src/protocol";
import { defineFunctions } from "../../src/runtime/functions";
import type { StoreBinding } from "../../src/storage/binding";
import type { RemoteSurface, RemoteTick } from "../../src/storage/types";
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

describe("v5 embedded client local-first remote start", () => {
  test("resolves local queries before the background remote start completes", async () => {
    const control = pendingRemote();
    const { client, path } = await createRemoteClient("local-first", control.remote);
    try {
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      expect(control.startCalls()).toBe(1);
      expect(client.connectionState()).toMatchObject({ local: "ready", remote: "starting" });
    } finally {
      control.resolveStart();
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("surfaces a failing remote start as a remote error without rejecting local queries", async () => {
    const control = pendingRemote();
    const { client, path } = await createRemoteClient("remote-error", control.remote);
    try {
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      control.rejectStart(new Error("handshake refused"));
      const deadline = Date.now() + 2_000;
      while (client.connectionState().remote !== "error" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const state = client.connectionState();
      expect(state.remote).toBe("error");
      if (state.remote === "error") expect(state.remoteError).toContain("handshake refused");
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      expect(client.connectionState().local).toBe("ready");
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("close settles cleanly while the remote start is still in flight", async () => {
    const control = pendingRemote();
    const { client, path } = await createRemoteClient("close-in-flight", control.remote);
    try {
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      expect(control.startCalls()).toBe(1);
      const closing = client.close();
      control.resolveStart();
      await closing;
      expect(client.connectionState().local).toBe("closed");
      expect(control.startCalls()).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("closing during an in-flight remote start settles without awaiting the start", async () => {
    const control = abortableRemote();
    const { client, path } = await createRemoteClient("close-bounded", control.remote);
    try {
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      expect(control.startCalls()).toBe(1);
      const closing = client.close();
      const outcome = await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("closed");
      await closing;
      expect(client.connectionState().local).toBe("closed");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("closing after the remote start already rejected does not throw", async () => {
    const control = pendingRemote();
    const { client, path } = await createRemoteClient("reject-then-close", control.remote);
    try {
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      control.rejectStart(new Error("handshake refused"));
      await waitUntil(() => client.connectionState().remote === "error");
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  test(
    "recovers replication after an initial start failure once connectivity returns",
    { timeout: 20_000 },
    async () => {
      const control = recoverableRemote(new Error("offline at launch"));
      const { client, path } = await createRemoteClient("recover", control.remote);
      try {
        await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
        await waitUntil(() => client.connectionState().remote === "error");
        expect(control.startCalls()).toBe(1);
        await waitUntil(() => control.startCalls() >= 2, 12_000);
        await waitUntil(() => control.pullCalls() >= 1, 12_000);
        await waitUntil(() => client.connectionState().remote !== "error", 12_000);
      } finally {
        await client.close();
        rmSync(path, { force: true });
      }
    },
  );
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

async function createRemoteClient(
  name: string,
  remote: RemoteSurface,
): Promise<{ client: EmbeddedClient; path: string }> {
  const path = join(tmpdir(), `convex-embedded-v5-remote-${name}-${crypto.randomUUID()}.sqlite3`);
  const store = await NativeStore.openWith(nativeModule().Store, path, {
    defaultIdentityKey: EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
    selectorKey: path,
  });
  (store as unknown as { remote: RemoteSurface }).remote = remote;
  const client = new EmbeddedClient({
    schema,
    modules: { messages: modules },
    store,
    remote: { url: "http://remote.invalid" },
  });
  return { client, path };
}

function pendingRemote(): {
  remote: RemoteSurface;
  resolveStart: () => void;
  rejectStart: (error: unknown) => void;
  startCalls: () => number;
} {
  let resolveGate!: () => void;
  let rejectGate!: (error: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  let calls = 0;
  const remote: RemoteSurface = {
    start: async () => {
      calls += 1;
      await gate;
    },
    close: async () => undefined,
    pull: async () => emptyTick(),
    scope: { write: async () => undefined },
    identity: async () => ({ identity: null, protocolVersion: EMBEDDED_PROTOCOL_VERSION }),
  };
  return {
    remote,
    resolveStart: () => resolveGate(),
    rejectStart: (error) => rejectGate(error),
    startCalls: () => calls,
  };
}

function abortableRemote(): { remote: RemoteSurface; startCalls: () => number } {
  let calls = 0;
  let abort!: (error: unknown) => void;
  const gate = new Promise<void>((_, reject) => {
    abort = reject;
  });
  gate.catch(() => undefined);
  const remote: RemoteSurface = {
    start: async () => {
      calls += 1;
      await gate;
    },
    close: async () => {
      abort(new Error("remote transport closed"));
    },
    pull: async () => emptyTick(),
    scope: { write: async () => undefined },
    identity: async () => ({ identity: null, protocolVersion: EMBEDDED_PROTOCOL_VERSION }),
  };
  return { remote, startCalls: () => calls };
}

function recoverableRemote(firstError: unknown): {
  remote: RemoteSurface;
  startCalls: () => number;
  pullCalls: () => number;
} {
  let starts = 0;
  let pulls = 0;
  let pending: unknown = firstError;
  const remote: RemoteSurface = {
    start: async () => {
      starts += 1;
      if (pending !== undefined) {
        const error = pending;
        pending = undefined;
        throw error;
      }
    },
    close: async () => undefined,
    pull: async () => {
      pulls += 1;
      return emptyTick();
    },
    scope: { write: async () => undefined },
    identity: async () => ({ identity: null, protocolVersion: EMBEDDED_PROTOCOL_VERSION }),
  };
  return { remote, startCalls: () => starts, pullCalls: () => pulls };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function emptyTick(): RemoteTick {
  return {
    changedResults: [],
    changedTables: [],
    pullAttempted: 0,
    pullChangesApplied: 0,
    pullDiagnostics: 0,
    pullSnapshots: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushFailed: 0,
    pushRebases: 0,
    pushed: 0,
    receiptsPushed: 0,
    received: 0,
    reconnected: false,
    retainedRevisions: [],
    rowsApplied: 0,
    sent: 0,
    storeJobs: 0,
  };
}
