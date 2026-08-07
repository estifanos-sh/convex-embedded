import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DataModelFromSchemaDefinition, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { EmbeddedClient } from "../../src/client";
import { readDevtoolsBridge } from "../../src/devtools/bridge";
import { createConvexEmbeddedClientForTest } from "../../src/node/client";
import type { LedgerReader } from "../../src/runtime/ledger";
import { NativeStore } from "../../src/node/native";
import type { Runner } from "../../src/runtime/runner";
import {
  EMBEDDED_PROTOCOL_VERSION,
  EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
} from "../../src/protocol";
import { defineFunctions } from "../../src/runtime/functions";
import type { StoreBinding } from "../../src/storage/binding";
import type { RemoteSurface, RemoteTick } from "../../src/storage/types";
import { defineLocal, stampLocal } from "../../src/local/internal";
import {
  defineEmbeddedSchema,
  localTable,
  replicatedTable,
  toRuntimeStoreSchema,
} from "../../src/schema";
import { hashValue } from "../../src/hash";
import { getTimerTime } from "../../src/time";
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

const ensureCompact = device.internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if ((await ctx.db.query("preferences").first()) === null) {
      await ctx.db.insert("preferences", { compact: true });
    }
    return null;
  },
});
const setup = device.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(ensureCompact, {});
    return null;
  },
});
const setupModule = { ensureCompact, readCompact: prefs.readCompact, setup };
stampLocal("local/setup", "setup-graph-v1", setupModule);

const currentSetup = device.internalAction({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
const currentSetupModule = { currentSetup };
stampLocal("local/setup", "setup-graph-v2", currentSetupModule);

const writeThenFail = device.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(ensureCompact, {});
    throw new Error("setup failed after a durable batch");
  },
});
const failingSetupModule = { ensureCompact, writeThenFail };
stampLocal("local/failing", "setup-graph-failing", failingSetupModule);

const nestedLeaf = device.internalAction({
  args: {},
  returns: v.null(),
  handler: () => null,
});
const nestedSetup = device.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await (
      ctx as unknown as {
        runAction(action: typeof nestedLeaf, args: Record<string, never>): Promise<unknown>;
      }
    ).runAction(nestedLeaf, {});
    return null;
  },
});
const nestedSetupModule = { nestedLeaf, nestedSetup };
stampLocal("local/nested", "setup-graph-nested", nestedSetupModule);

const narrowedSchema = defineEmbeddedSchema({
  messages: replicatedTable({
    channel: v.string(),
    body: v.number(),
  }).index("by_channel", ["channel"]),
  preferences: localTable({ compact: v.boolean() }),
});
const narrowedDevice = defineLocal(narrowedSchema);
const narrowedSetup = narrowedDevice.internalAction({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
const narrowedSetupModule = { narrowedSetup };
stampLocal("local/narrowed", "setup-graph-narrowed", narrowedSetupModule);

const legacyPreferencesSchema = defineEmbeddedSchema({
  legacy_preferences: localTable({ compact: v.boolean() }),
});
const legacyPreferences = defineLocal(legacyPreferencesSchema);
const writeLegacyPreference = legacyPreferences.mutation({
  args: { compact: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("legacy_preferences", { compact: args.compact });
    return null;
  },
});
const legacyPreferencesModule = { writeLegacyPreference };
stampLocal("local/legacy", "legacy-preferences-v1", legacyPreferencesModule);

export const writeCurrentPreference = device.internalMutation({
  args: { compact: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((await ctx.db.query("preferences").first()) === null) {
      await ctx.db.insert("preferences", { compact: args.compact });
    }
    return null;
  },
});
let completedSetupLedger: LedgerReader | undefined;
export const migrateDroppedPreferences = device.internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    completedSetupLedger = ctx.ledger;
    let cursor: string | null = null;
    do {
      const page: { cursor: string | null; docs: readonly { _id: string; compact: boolean }[] } =
        await ctx.ledger.read({
          cursor,
          table: "legacy_preferences",
          validator: v.object({ compact: v.boolean() }),
        });
      for (const preference of page.docs) {
        await ctx.runMutation(writeCurrentPreference, { compact: preference.compact });
        await ctx.ledger.delete({ id: preference._id, table: "legacy_preferences" });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return null;
  },
});
const droppedPreferencesModule = {
  migrateDroppedPreferences,
  writeCurrentPreference,
};
stampLocal("local/upgrade", "dropped-preferences-v2", droppedPreferencesModule);

describe("v5 embedded client", () => {
  test("does not acquire the runtime and rejects operations before explicit open", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-not-open-${crypto.randomUUID()}.sqlite3`);
    const client = createConvexEmbeddedClientForTest(
      { schema, modules: { messages: modules }, path },
      nativeModule(),
    );
    try {
      expect(client.connectionState()).toMatchObject({
        local: { status: "idle" },
        replication: { status: "disabled" },
      });
      await expect(client.query(list, { channel: "general" })).rejects.toMatchObject({
        code: "EMBEDDED_NOT_OPEN",
      });
      await expect(
        client.mutation(send, { body: "one", channel: "general" }),
      ).rejects.toMatchObject({ code: "EMBEDDED_NOT_OPEN" });
      expect(existsSync(path)).toBe(false);
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("rejects an unstamped setup action before acquiring a native store", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-unstamped-${crypto.randomUUID()}.sqlite3`);
    const client = createConvexEmbeddedClientForTest(
      { schema, modules: { messages: modules }, path },
      nativeModule(),
    );
    const unstamped = device.internalAction({
      args: {},
      returns: v.null(),
      handler: () => null,
    });
    try {
      await expect(client.open(unstamped)).rejects.toThrow("bundled local module");
      expect(existsSync(path)).toBe(false);
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("uses ordinary typed query and mutation methods", async () => {
    const client = await createClient("ordinary");
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
    const client = await createClient("watch");
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
    const client = await createClient("surface");
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
      await client.open();
      await expect(client.query(identityRead, {})).resolves.toBe("issuer|cached");
      client.clearAuth();
      await expect(client.query(identityRead, {})).resolves.toBeNull();
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("runs a compatible schema upgrade through the candidate protocol without app setup", async () => {
    const path = join(
      tmpdir(),
      `convex-embedded-v5-automatic-upgrade-${crypto.randomUUID()}.sqlite3`,
    );
    const native = nativeModule();
    const first = createConvexEmbeddedClientForTest(
      { schema, modules: { messages: modules }, path },
      native,
    );
    const upgradedSchema = defineEmbeddedSchema({
      messages: replicatedTable({
        channel: v.string(),
        body: v.string(),
      }).index("by_channel", ["channel"]),
      preferences: localTable({ compact: v.boolean() }),
      notices: localTable({ read: v.boolean() }),
    });
    try {
      await first.open();
      await first.close();
      const second = createConvexEmbeddedClientForTest(
        { schema: upgradedSchema, modules: { messages: modules }, path },
        native,
      );
      try {
        await expect(second.open()).resolves.toBeUndefined();
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      rmSync(path, { force: true });
    }
  });

  test("moves a removed local table through the candidate ledger", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-dropped-table-${crypto.randomUUID()}.sqlite3`);
    const native = nativeModule();
    const original = createConvexEmbeddedClientForTest(
      {
        schema: legacyPreferencesSchema,
        modules: {},
        local: { legacy: async () => legacyPreferencesModule },
        path,
      },
      native,
    );
    try {
      await original.open();
      await original.mutation(writeLegacyPreference, { compact: true });
      await original.close();

      const upgraded = createConvexEmbeddedClientForTest(
        {
          schema,
          modules: { messages: modules },
          local: {
            prefs: async () => prefs,
            upgrade: async () => droppedPreferencesModule,
          },
          path,
        },
        native,
      );
      try {
        await upgraded.open(migrateDroppedPreferences);
        await expect(upgraded.query(prefs.readCompact, {})).resolves.toEqual([true]);
        await expect(
          completedSetupLedger?.read({
            table: "legacy_preferences",
            validator: v.object({ compact: v.boolean() }),
          }),
        ).rejects.toThrow("ctx.ledger is available only while client.open(setup) is running.");
      } finally {
        await upgraded.close();
      }
    } finally {
      await original.close();
      rmSync(path, { force: true });
    }
  });

  test("plain open does not expose a candidate ledger", async () => {
    const path = join(
      tmpdir(),
      `convex-embedded-v5-plain-compatibility-${crypto.randomUUID()}.sqlite3`,
    );
    const client = createConvexEmbeddedClientForTest(
      {
        schema,
        modules: { messages: modules },
        local: {
          prefs: async () => prefs,
          upgrade: async () => droppedPreferencesModule,
        },
        path,
      },
      nativeModule(),
    );
    try {
      await expect(client.open()).resolves.toBeUndefined();
      await expect(client.query(prefs.readCompact, {})).resolves.toEqual([]);
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("blocks cutover when carried local data violates the target validator", async () => {
    const path = join(
      tmpdir(),
      `convex-embedded-v5-invalid-upgrade-${crypto.randomUUID()}.sqlite3`,
    );
    const native = nativeModule();
    const originalOptions = {
      schema,
      modules: { messages: modules },
      local: { prefs: async () => prefs },
      path,
    };
    const original = createConvexEmbeddedClientForTest(originalOptions, native);
    try {
      await original.open();
      await original.mutation(prefs.setCompact, { compact: false });
      await original.close();

      const incompatibleSchema = defineEmbeddedSchema({
        messages: replicatedTable({ channel: v.string(), body: v.string() }).index("by_channel", [
          "channel",
        ]),
        preferences: localTable({ compact: v.string() }),
      });
      const incompatible = createConvexEmbeddedClientForTest(
        { schema: incompatibleSchema, modules: { messages: modules }, path },
        native,
      );
      await expect(incompatible.open()).rejects.toThrow("preferences.compact must be a string");
      await incompatible.close();

      const reopened = createConvexEmbeddedClientForTest(originalOptions, native);
      await reopened.open();
      await expect(reopened.query(prefs.readCompact, {})).resolves.toEqual([false]);
      await reopened.close();
    } finally {
      await original.close();
      rmSync(path, { force: true });
    }
  });

  test("runs a stamped internal local action before first publication and reuses its identity", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-setup-${crypto.randomUUID()}.sqlite3`);
    const native = nativeModule();
    const options = {
      schema,
      modules: { messages: modules },
      local: { setup: async () => setupModule },
      path,
    };
    const first = createConvexEmbeddedClientForTest(options, native);
    try {
      await Promise.all([first.open(setup), first.open(setup)]);
      await expect(first.open(writeThenFail)).rejects.toMatchObject({
        code: "EMBEDDED_OPEN_MISMATCH",
      });
      await expect(first.query(prefs.readCompact, {})).resolves.toEqual([true]);
      await first.close();

      const second = createConvexEmbeddedClientForTest(options, native);
      await expect(second.open(setup)).resolves.toBeUndefined();
      await expect(second.query(prefs.readCompact, {})).resolves.toEqual([true]);
      await second.close();

      const omitted = createConvexEmbeddedClientForTest(options, native);
      await expect(omitted.open()).resolves.toBeUndefined();
      await expect(omitted.query(prefs.readCompact, {})).resolves.toEqual([true]);
      await omitted.close();
    } finally {
      await first.close();
      rmSync(path, { force: true });
    }
  });

  test("quarantines a validator-incompatible queued suffix before setup materialization", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-queue-setup-${crypto.randomUUID()}.sqlite3`);
    const native = nativeModule();
    const original = createConvexEmbeddedClientForTest(
      { schema, modules: { messages: modules }, path },
      native,
    );
    try {
      await original.open();
      await original.mutation(send, { body: "old queued shape", channel: "general" });
      await original.close();

      const upgraded = createConvexEmbeddedClientForTest(
        {
          schema: narrowedSchema,
          modules: { messages: modules },
          local: { narrowed: async () => narrowedSetupModule },
          path,
        },
        native,
      );
      await expect(upgraded.open(narrowedSetup)).resolves.toBeUndefined();
      await expect(upgraded.query(list, { channel: "general" })).resolves.toEqual([]);
      await upgraded.close();
    } finally {
      await original.close();
      rmSync(path, { force: true });
    }
  });

  test("rejects a setup reference copied from a different local module graph", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-stale-setup-${crypto.randomUUID()}.sqlite3`);
    const client = createConvexEmbeddedClientForTest(
      {
        schema,
        modules: { messages: modules },
        local: { setup: async () => currentSetupModule },
        path,
      },
      nativeModule(),
    );
    try {
      await expect(client.open(setup)).rejects.toThrow(
        "does not match the loaded local module graph",
      );
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("rejects nested local actions at runtime even through an untyped setup context", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-nested-setup-${crypto.randomUUID()}.sqlite3`);
    const client = createConvexEmbeddedClientForTest(
      {
        schema,
        modules: { messages: modules },
        local: { nested: async () => nestedSetupModule },
        path,
      },
      nativeModule(),
    );
    try {
      await expect(client.open(nestedSetup)).rejects.toThrow(
        "Local actions cannot call nested actions",
      );
    } finally {
      await client.close();
      rmSync(path, { force: true });
    }
  });

  test("keeps the published generation unchanged and makes a failed setup open terminal", async () => {
    const path = join(tmpdir(), `convex-embedded-v5-setup-failure-${crypto.randomUUID()}.sqlite3`);
    const native = nativeModule();
    const baselineOptions = {
      schema,
      modules: { messages: modules },
      local: { prefs: async () => prefs },
      path,
    };
    const baseline = createConvexEmbeddedClientForTest(baselineOptions, native);
    try {
      await baseline.open();
      await baseline.mutation(prefs.setCompact, { compact: false });
      await baseline.close();

      const failing = createConvexEmbeddedClientForTest(
        {
          ...baselineOptions,
          local: { failing: async () => failingSetupModule },
        },
        native,
      );
      await expect(failing.open(writeThenFail)).rejects.toThrow(
        "setup failed after a durable batch",
      );
      await expect(failing.open(writeThenFail)).rejects.toThrow(
        "setup failed after a durable batch",
      );
      await failing.close();

      const reopened = createConvexEmbeddedClientForTest(baselineOptions, native);
      await reopened.open();
      await expect(reopened.query(prefs.readCompact, {})).resolves.toEqual([false]);
      await reopened.close();
    } finally {
      await baseline.close();
      rmSync(path, { force: true });
    }
  });
});

describe("v5 embedded client device-only functions", () => {
  test("writes and watches a device table through registrations the app imported", async () => {
    const client = await createClient("device-only", {
      "sync/prefs": () => Promise.resolve(prefs),
    });
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
    const client = await createClient("device-only-orphan", {
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
    const client = await createClient("device-only-unconfigured");
    try {
      await expect(client.query(orphan, {})).rejects.toThrow(
        "No local directory is configured; pass the local option to the bundler adapter.",
      );
    } finally {
      await client.close();
    }
  });

  test("refuses an internal registration at the app surface", async () => {
    const client = await createClient("device-only-internal", {
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
    const client = await createClient("device-only-copies", {
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
      await client.open();
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
      expect(client.connectionState()).toMatchObject({
        local: { status: "ready" },
        replication: { status: "starting" },
      });
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
      const deadline = getTimerTime() + 2_000;
      while (client.connectionState().replication.status !== "error" && getTimerTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const state = client.connectionState();
      expect(state.replication.status).toBe("error");
      if (state.replication.status === "error") {
        expect(state.replication.error.message).toContain("handshake refused");
      }
      await expect(client.query(list, { channel: "general" })).resolves.toEqual([]);
      expect(client.connectionState().local.status).toBe("ready");
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
      expect(client.connectionState().local.status).toBe("closed");
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
      expect(client.connectionState().local.status).toBe("closed");
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
      await waitUntil(() => client.connectionState().replication.status === "error");
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
        await waitUntil(() => client.connectionState().replication.status === "error");
        expect(control.startCalls()).toBe(1);
        await waitUntil(() => control.startCalls() >= 2, 12_000);
        await waitUntil(() => control.pullCalls() >= 1, 12_000);
        await waitUntil(() => client.connectionState().replication.status !== "error", 12_000);
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
  const snapshot = readDevtoolsBridge(client).snapshot();
  return snapshot.queries.map((query) => ({ key: query.key, name: query.name }));
}

async function createClient(name: string, local?: Record<string, () => Promise<unknown>>) {
  const path = join(tmpdir(), `convex-embedded-v5-${name}-${crypto.randomUUID()}.sqlite3`);
  const options = { schema, local, modules: { messages: modules }, path };
  const client = createConvexEmbeddedClientForTest(options, nativeModule());
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    rmSync(path, { force: true });
  };
  await client.open();
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
  await client.open();
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
  const deadline = getTimerTime() + timeoutMs;
  while (!predicate()) {
    if (getTimerTime() >= deadline) throw new Error("waitUntil condition was not met in time");
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
    settlements: [],
    rowsApplied: 0,
    sent: 0,
    storeJobs: 0,
  };
}
