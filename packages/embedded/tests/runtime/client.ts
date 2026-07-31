import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { EmbeddedClient, type EmbeddedClientDebugSnapshot } from "../../src/client";
import { createConvexEmbeddedClientForTest } from "../../src/node/client";
import { NativeStore } from "../../src/node/native";
import type { Runner } from "../../src/runtime/runner";
import {
  EMBEDDED_PROTOCOL_VERSION,
  EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
} from "../../src/protocol";
import { defineFunctions } from "../../src/runtime/functions";
import type { StoreBinding } from "../../src/storage/binding";
import type { RemoteSurface, RemoteTick } from "../../src/storage/types";
import { defineLocal } from "../../src/local";
import {
  defineEmbeddedSchema,
  localTable,
  replicatedTable,
  toRuntimeStoreSchema,
} from "../../src/schema";
import { hashValue } from "../../src/hash";
import { nativeModule } from "../testkit/native";

const schema = defineEmbeddedSchema({
  messages: replicatedTable({
    channel: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
  preferences: localTable({ compact: v.boolean() }),
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

const device = defineLocal(schema);
const prefs = {
  readCompact: device.query({
    args: {},
    handler: async (ctx) => (await ctx.db.query("preferences").collect()).map((row) => row.compact),
  }),
  setCompact: device.mutation({
    args: { compact: v.boolean() },
    handler: async (ctx, args) => {
      await ctx.db.insert("preferences", { compact: args.compact });
    },
  }),
  wipe: device.internalMutation({
    args: {},
    handler: async (ctx) => {
      for (const row of await ctx.db.query("preferences").collect()) {
        await ctx.db.delete("preferences", row._id);
      }
    },
  }),
};

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

describe("v5 embedded client device-only functions", () => {
  test("writes and watches a device table through registrations the app imported", async () => {
    const client = createClient("device-only", { "sync/prefs": () => Promise.resolve(prefs) });
    try {
      const watch = client.watchQuery(prefs.readCompact, {});
      let observed: boolean[] | undefined;
      const update = new Promise<void>((resolve) => {
        const stop = watch.onUpdate(() => {
          if (watch.localQueryResult()?.length === 1) {
            observed = watch.localQueryResult();
            stop();
            resolve();
          }
        });
      });
      await client.mutation(prefs.setCompact, { compact: true });
      await expect(client.query(prefs.readCompact, {})).resolves.toEqual([true]);
      await update;
      expect(observed).toEqual([true]);
    } finally {
      await client.close();
    }
  });

  test("refuses a registration no configured local module carries", async () => {
    const orphan = device.mutation({
      args: { compact: v.boolean() },
      handler: async (ctx, args) => {
        await ctx.db.insert("preferences", { compact: args.compact });
      },
    });
    const client = createClient("device-only-orphan", {
      "sync/prefs": () => Promise.resolve(prefs),
    });
    try {
      await expect(client.mutation(orphan, { compact: true })).rejects.toThrow(
        "This device-only function is not registered under the configured local directories, or the embedded client has not finished starting.",
      );
    } finally {
      await client.close();
    }
  });

  test("reports an unconfigured local directory before an unregistered name", async () => {
    const orphan = device.query({
      args: {},
      handler: async (ctx) => (await ctx.db.query("preferences").collect()).length,
    });
    const client = createClient("device-only-unconfigured");
    try {
      await expect(client.query(orphan, {})).rejects.toThrow(
        "No local directory is configured; pass the local option to the bundler adapter.",
      );
    } finally {
      await client.close();
    }
  });

  test("refuses an internal registration at the app surface", async () => {
    const client = createClient("device-only-internal", {
      "sync/prefs": () => Promise.resolve(prefs),
    });
    try {
      await expect(
        // @ts-expect-error internal device-only functions are not part of the app surface
        client.mutation(prefs.wipe, {}),
      ).rejects.toThrow("Internal local functions are only callable from other local functions.");
    } finally {
      await client.close();
    }
  });

  test("reads the local directory configuration of a prebuilt runtime it does not own", async () => {
    const orphan = device.query({
      args: {},
      handler: async (ctx) => (await ctx.db.query("preferences").collect()).length,
    });
    const configured = new EmbeddedClient({ runner: prebuiltRunner(true) });
    const unconfigured = new EmbeddedClient({ runner: prebuiltRunner(false) });
    try {
      await expect(configured.query(orphan, {})).rejects.toThrow(
        "This device-only function is not registered under the configured local directories, or the embedded client has not finished starting.",
      );
      await expect(unconfigured.query(orphan, {})).rejects.toThrow(
        "No local directory is configured; pass the local option to the bundler adapter.",
      );
    } finally {
      await configured.close();
      await unconfigured.close();
    }
  });

  test("watches one subscription for separate copies of the same registration", async () => {
    const client = createClient("device-only-copies", {
      "sync/prefs": () => Promise.resolve(prefs),
    });
    try {
      await client.mutation(prefs.setCompact, { compact: true });
      const copy = { ...prefs.readCompact };
      const watch = client.watchQuery(prefs.readCompact, {});
      let stop: (() => void) | undefined;
      await new Promise<void>((resolve) => {
        stop = watch.onUpdate(resolve);
      });
      try {
        expect(client.watchQuery(copy, {}).localQueryResult()).toEqual([true]);
        expect(devtoolsQueries(client)).toEqual([
          { key: expect.any(String), name: "local/sync/prefs:readCompact" },
        ]);
      } finally {
        stop?.();
      }
    } finally {
      await client.close();
    }
  });

  test("imports device modules while the store sets up", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-device-setup-${crypto.randomUUID()}.sqlite3`);
    const store = await NativeStore.openWith(nativeModule().Store, path, {
      defaultIdentityKey: EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
      selectorKey: path,
    });
    let setupStarted!: () => void;
    const setupRunning = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    const setup = store.setup.bind(store);
    store.setup = async (storeSchema) => {
      setupStarted();
      await setup(storeSchema);
    };
    const client = new EmbeddedClient({
      schema,
      modules: { messages: modules },
      localModules: {
        "local/sync/prefs": async () => {
          await setupRunning;
          return prefs;
        },
      },
      store,
    });
    try {
      await expect(client.query(prefs.readCompact, {})).resolves.toEqual([]);
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

function prebuiltRunner(localConfigured: boolean): Runner {
  return {
    identity: { read: async () => undefined, write: async () => undefined },
    localConfigured,
    route: async () => ({ execution: "local", placement: "local" }),
    runQuery: async () => undefined,
    runMutation: async () => undefined,
    runAction: async () => undefined,
    handleUpload: async () => ({ storageId: "unused" }),
    devtools: async () => undefined,
    invalidate: () => undefined,
    rerunResults: () => undefined,
    onUpdate: () => () => undefined,
  };
}

function devtoolsQueries(client: EmbeddedClient): Array<{ key: string; name: string }> {
  const snapshot = (
    client as unknown as { __devtoolsSnapshot(): EmbeddedClientDebugSnapshot }
  ).__devtoolsSnapshot();
  return snapshot.queries.map((query) => ({ key: query.key, name: query.name }));
}

function createClient(name: string, local?: Record<string, () => Promise<unknown>>) {
  const path = join(tmpdir(), `convex-embedded-v5-${name}-${crypto.randomUUID()}.sqlite3`);
  const options = { schema, local, modules: { messages: modules }, path };
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
