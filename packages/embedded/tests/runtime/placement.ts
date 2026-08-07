import { v } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import type { DiagnosticEvent as EmbeddedEvent, EmbeddedDataEvent } from "../../src/events";
import type { LocalBuilders } from "../../src/local";
import { defineLocal, isLocalFunction } from "../../src/local/internal";
import { NativeStore } from "../../src/node/native";
import { createWriter, toSchema } from "../../src/runtime/database";
import { defineFunctions } from "../../src/runtime/functions";
import { createRunner, type LocalModuleMap, type Runner } from "../../src/runtime/runner";
import {
  defineEmbeddedSchema,
  localTable,
  replicatedTable,
  toRuntimeStoreSchema,
  type DeviceDataModel,
  type EmbeddedSchemaDefinition,
  type ReplicatedDataModel,
} from "../../src/schema";
import type { CommitOptions, RuntimeStorageWriter, StoreSchema } from "../../src/storage/types";
import { getTimerTime } from "../../src/time";
import { e } from "../../src/values";
import { nativeModule } from "../testkit/native";
import { temporaryPath } from "../testkit/runtime";

const schema: StoreSchema = {
  hash: "0".repeat(64),
  tables: [
    {
      name: "documents",
      placement: "replicated",
      columns: [],
      indexes: [],
      localFields: [{ field: "expanded", validator: { type: "boolean" } }],
    },
    {
      name: "preferences",
      placement: "device",
      columns: [],
      indexes: [],
    },
  ],
};

test("device writer merges and stages local fields without touching the wire row", async () => {
  const store = fakeStore();
  const writer = createWriter(store, toSchema(schema), undefined, "device");
  const id = "documents|00000000000040008000000000000001";

  await expect(writer.db.get("documents" as never, id as never)).resolves.toMatchObject({
    _id: id,
    title: "wire",
    expanded: true,
  });
  await writer.db.patch("documents" as never, id as never, { expanded: false } as never);

  const batch = writer.toBatch();
  expect(batch.docWrites).toEqual([]);
  expect(batch.localFieldWrites).toEqual([
    { table: "documents", id, field: "expanded", value: false },
  ]);
  expect(batch.localFieldDeletes).toEqual([]);
  await expect(
    writer.db.patch("documents" as never, id as never, { title: "forbidden" } as never),
  ).rejects.toThrow(/cannot write replicated field documents\.title/);
  await expect(
    writer.db.patch("documents" as never, id as never, { expanded: "not boolean" } as never),
  ).rejects.toThrow(/documents\.expanded/);
});

test("device writer uses ordinary document batches for local tables", async () => {
  const writer = createWriter(fakeStore(), toSchema(schema), undefined, "device");
  const id = await writer.db.insert("preferences" as never, { compact: true } as never);
  const batch = writer.toBatch();
  expect(batch.docWrites).toHaveLength(1);
  expect(batch.docWrites[0]).toMatchObject({ table: "preferences", id, data: { compact: true } });
  expect(batch.freshIds).toEqual([]);
  expect(batch.idMappings).toEqual([]);
});

test("replicated writer rejects device fields before staging a base row", async () => {
  const writer = createWriter(fakeStore(), toSchema(schema));

  await expect(
    Promise.resolve().then(() =>
      writer.db.insert("documents" as never, { expanded: true, title: "must stay local" } as never),
    ),
  ).rejects.toThrow(/device-only field documents\.expanded/);
  expect(writer.toBatch().docWrites).toEqual([]);
});

test("routes a remote function from the trusted manifest without loading a device module", async () => {
  const runner = createRunner({}, fakeStore(), schema, {
    manifest: {
      remote: {
        read: { kind: "query", placement: "remote", visibility: "public" },
        write: { kind: "mutation", placement: "remote", visibility: "public" },
      },
    },
  });

  await expect(runner.route("remote:read", {}, "query")).resolves.toEqual({
    execution: "hosted",
    args: {},
  });
  await expect(runner.route("remote:write", {}, "mutation")).resolves.toEqual({
    execution: "hosted",
    args: {},
  });
});

test("the devtools snapshot reads id mappings only for replicated tables", async () => {
  const runner = createRunner({ docs }, await deviceStore(), deviceStoreSchema);

  const snapshot = (await runner.devtools({ kind: "snapshot" })) as {
    storage: { idMappings: unknown[] };
  };

  expect(snapshot.storage.idMappings).toEqual([]);
});

test("devtools keeps device-table writes device scoped and reactive", async () => {
  const store = await deviceStore();
  const commits: Array<{
    batch: Parameters<RuntimeStorageWriter["commit"]>[0];
    options: CommitOptions | undefined;
  }> = [];
  const commit = store.commit.bind(store);
  store.commit = async (batch, options) => {
    commits.push({ batch, options });
    return commit(batch, options);
  };
  const module = draftsModule();
  const runner = createRunner({ docs }, store, deviceStoreSchema, {
    localModules: { "local/sync/drafts": () => Promise.resolve(module) },
  });
  await runner.localReady;
  const events: EmbeddedEvent[] = [];
  const unsubscribe = runner.subscribeEvents?.((event) => events.push(event));
  await runner.runMutation(module.setCompact, { compact: false });
  const rows = (await runner.devtools({ kind: "listRows", table: "preferences" })) as {
    rows: Array<{ _id: string }>;
  };
  const id = rows.rows[0]?._id;
  if (id === undefined) throw new Error("expected the device preference row");
  const updates: string[][] = [];
  const off = runner.onUpdate(module.readLabel, {}, (value) => updates.push(value as string[]));
  expect(await nextUpdate(updates, 0)).toEqual(["initial"]);

  const beforePatch = commits.length;
  await runner.devtools({
    fields: { label: "updated" },
    id,
    kind: "patchDocument",
    table: "preferences",
  });
  expect(await nextUpdate(updates, 1)).toEqual(["updated"]);
  expect(commits.slice(beforePatch)).toEqual([
    expect.objectContaining({
      batch: expect.objectContaining({
        dataOnlyIds: [],
        docWrites: [
          expect.objectContaining({ cols: [["idx_compact", false]], id, table: "preferences" }),
        ],
      }),
      options: { changes: "omit", source: "device" },
    }),
  ]);
  const patchEvent = events.find(
    (event): event is EmbeddedDataEvent =>
      event.type === "data" &&
      event.docWrites.some((write) => write.id === id && write.row.label === "updated"),
  );
  expect(patchEvent).toMatchObject({ source: "local", type: "data" });

  const beforeDelete = commits.length;
  await runner.devtools({ id, kind: "deleteDocument", table: "preferences" });
  expect(await nextUpdate(updates, 2)).toEqual([]);
  expect(commits.slice(beforeDelete)).toEqual([
    expect.objectContaining({ options: { changes: "omit", source: "device" } }),
  ]);
  const deleteEvent = events.find(
    (event): event is EmbeddedDataEvent =>
      event.type === "data" && event.deletes.some((deleted) => deleted.id === id),
  );
  expect(deleteEvent).toMatchObject({ source: "local", type: "data" });

  const afterDelete = commits.length;
  await runner.devtools({ id, kind: "deleteDocument", table: "preferences" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(commits).toHaveLength(afterDelete);
  expect(updates).toHaveLength(3);
  off();
  unsubscribe?.();
});

describe("device-only function modules", () => {
  test("names every registration and dispatches it by that name", async () => {
    const module = draftsModule();
    const runner = await localRunner({ "local/sync/drafts": () => Promise.resolve(module) });

    expect((module.setCompact as unknown as Record<string, unknown>).__embeddedLocalReference).toBe(
      "local/sync/drafts:setCompact",
    );
    expect(
      (module.readCompact as unknown as Record<string, unknown>).__embeddedLocalReference,
    ).toBe("local/sync/drafts:readCompact");
    await expect(runner.route(module.setCompact, { compact: true }, "mutation")).resolves.toEqual({
      execution: "local",
      placement: "local",
    });
    await runner.runMutation(module.setCompact, { compact: true });
    await expect(runner.runQuery(module.readCompact, {})).resolves.toEqual([true]);
    await expect(runner.runQuery("local/sync/drafts:readCompact", {})).resolves.toEqual([true]);
  });

  test("ignores non-registration exports", async () => {
    const helper = () => 1;
    const module = { ...draftsModule(), helper, label: "drafts" };
    const runner = await localRunner({ "local/sync/drafts": () => Promise.resolve(module) });

    expect(module.helper).toBe(helper);
    expect(module.label).toBe("drafts");
    expect((module.helper as unknown as Record<string, unknown>).__embeddedLocalReference).toBe(
      undefined,
    );
    await runner.runMutation(module.setCompact, { compact: true });
    await expect(runner.runQuery(module.readCompact, {})).resolves.toEqual([true]);
    await expect(runner.runQuery("local/sync/drafts:label", {})).rejects.toThrow(
      "local/sync/drafts:label is not registered under the configured local directories.",
    );
  });

  test("imports every configured module at once instead of one after another", async () => {
    const started = new Set<string>();
    let bothStarted!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const load = (moduleId: string) => async () => {
      started.add(moduleId);
      if (started.size === 2) bothStarted();
      await barrier;
      return draftsModule();
    };
    const runner = createRunner({}, fakeStore(), deviceStoreSchema, {
      localModules: {
        "local/sync/drafts": load("local/sync/drafts"),
        "local/sync/notes": load("local/sync/notes"),
      },
    });

    await runner.localReady;
    expect(started.size).toBe(2);
    await expect(runner.route("local/sync/notes:readCompact", {}, "query")).resolves.toEqual({
      execution: "local",
      placement: "local",
    });
  });

  test("rejects a module whose top level throws", async () => {
    const runner = createRunner({}, await deviceStore(), deviceStoreSchema, {
      localModules: {
        "local/sync/drafts": () => Promise.reject(new Error("drafts module failed to load")),
      },
    });

    await expect(runner.localReady).rejects.toThrow("drafts module failed to load");
  });

  test("refuses an internal registration at the app surface and allows it from a local caller", async () => {
    const module = draftsModule();
    const runner = await localRunner({ "local/sync/drafts": () => Promise.resolve(module) });

    await expect(runner.route(module.clear, {}, "mutation")).rejects.toThrow(
      "Internal local functions are only callable from other local functions.",
    );
    await expect(runner.runMutation(module.clear, {})).rejects.toThrow(
      "Internal local functions are only callable from other local functions.",
    );
    await runner.runMutation(module.setCompact, { compact: true });
    await runner.runMutation(module.reset, {});
    await expect(runner.runQuery(module.readCompact, {})).resolves.toEqual([]);
  });

  test("limits the setup ledger to device table records", async () => {
    const setup = device.internalAction({
      args: {},
      handler: async (ctx) =>
        await ctx.ledger.read({
          table: "documents",
          validator: v.object({ title: v.string() }),
        }),
    });
    const runner = createRunner({}, fakeStore(), schema, {
      localModules: { "local/setup": () => Promise.resolve({ setup }) },
      mode: "setup",
    });

    await runner.localReady;
    await expect(runner.runAction(setup, {}, { allowInternal: true })).rejects.toThrow(
      "ctx.ledger only permits device table records.",
    );
  });

  test("refuses file storage in a local query and a local mutation", async () => {
    const module = {
      read: device.query({
        args: {},
        handler: async (ctx) => Boolean((ctx as unknown as { storage: unknown }).storage),
      }),
      write: device.mutation({
        args: {},
        handler: async (ctx) => Boolean((ctx as unknown as { storage: unknown }).storage),
      }),
    };
    const runner = await localRunner({ "local/sync/files": () => Promise.resolve(module) });

    await expect(runner.runQuery(module.read, {})).rejects.toThrow(
      "Local functions cannot access file storage.",
    );
    await expect(runner.runMutation(module.write, {})).rejects.toThrow(
      "Local functions cannot access file storage.",
    );
  });

  test("reports the kind a registration actually has", async () => {
    const module = draftsModule();
    const runner = await localRunner({ "local/sync/drafts": () => Promise.resolve(module) });

    await expect(runner.route(module.readCompact, {}, "mutation")).rejects.toThrow(
      "local/sync/drafts:readCompact is a local query and cannot be called as a mutation.",
    );
    await expect(runner.route(module.setCompact, { compact: true }, "query")).rejects.toThrow(
      "local/sync/drafts:setCompact is a local mutation and cannot be called as a query.",
    );
  });

  test("refuses a name no configured module registered", async () => {
    const runner = await localRunner({
      "local/sync/drafts": () => Promise.resolve(draftsModule()),
    });

    await expect(runner.route("local/sync/missing:read", {}, "query")).rejects.toThrow(
      "local/sync/missing:read is not registered under the configured local directories.",
    );
  });

  test("serializes identity switches behind local mutation commits", async () => {
    for (const source of ["local", "remote"] as const) {
      const documentId = "documents|00000000000040008000000000000001";
      let mutationStarted!: () => void;
      let releaseMutation!: () => void;
      const started = new Promise<void>((resolve) => {
        mutationStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const module = {
        clearExpanded: device.mutation({
          args: { documentId: v.id("documents") },
          handler: async (ctx, args) => {
            await ctx.db.patch("documents", args.documentId, { expanded: undefined });
            mutationStarted();
            await release;
          },
        }),
      };
      const base = fakeStore();
      let identityKey = "identity-a";
      const order: string[] = [];
      const writeIdentity = async () => {
        order.push(`identity:${source}:identity-b`);
        identityKey = "identity-b";
      };
      const store = {
        ...base,
        commit: async (batch: Parameters<RuntimeStorageWriter["commit"]>[0]) => {
          order.push(`commit:${identityKey}:${batch.localFieldDeletes?.length ?? 0}`);
          return { changedTables: [], changes: [], commitSeq: 1 };
        },
        identity: {
          read: async () => ({ identity: null, identityKey }),
          write: writeIdentity,
        },
        remote: {
          close: async () => undefined,
          identity: async () => {
            await writeIdentity();
            return { identity: null, identityKey, protocolVersion: 1 };
          },
          start: async () => undefined,
        },
      } as RuntimeStorageWriter;
      const runner = createRunner({}, store, deviceStoreSchema, {
        localModules: { "local/identity": () => Promise.resolve(module) },
      });
      await runner.localReady;

      const mutation = runner.runMutation(module.clearExpanded, { documentId });
      await started;
      const switched =
        source === "local"
          ? runner.identity.write("identity-b")
          : runner.remote!.identity.read().then(() => undefined);
      await Promise.resolve();
      expect(order).toEqual([]);

      releaseMutation();
      await Promise.all([mutation, switched]);
      expect(order).toEqual(["commit:identity-a:1", `identity:${source}:identity-b`]);
    }
  });

  test("separates an unconfigured local directory from an unregistered name", async () => {
    const unconfigured = createRunner({}, await deviceStore(), deviceStoreSchema);
    const empty = createRunner({}, await deviceStore(), deviceStoreSchema, { localModules: {} });

    for (const runner of [unconfigured, empty]) {
      await expect(runner.route("local/sync/drafts:readCompact", {}, "query")).rejects.toThrow(
        "No local directory is configured; pass the local option to the bundler adapter.",
      );
    }
  });
});

describe("device overlay reactivity", () => {
  test("reruns a watching local query when a local mutation patches an overlay field", async () => {
    const module = viewModule();
    const runner = await localRunner({ "local/view": () => Promise.resolve(module) });
    const documentId = (await runner.runMutation("docs:seed", { title: "wire" })) as string;
    const updates: string[][] = [];
    const off = runner.onUpdate(module.expanded, {}, (value) => updates.push(value as string[]));
    expect(await nextUpdate(updates, 0)).toEqual([]);

    await runner.runMutation(module.toggleExpanded, { documentId });

    expect(await nextUpdate(updates, 1)).toEqual([documentId]);
    off();
  });

  test("reruns the overlay watcher when the same batch also writes a device row", async () => {
    const module = viewModule();
    const runner = await localRunner({ "local/view": () => Promise.resolve(module) });
    const documentId = (await runner.runMutation("docs:seed", { title: "wire" })) as string;
    const updates: string[][] = [];
    const off = runner.onUpdate(module.expanded, {}, (value) => updates.push(value as string[]));
    expect(await nextUpdate(updates, 0)).toEqual([]);

    await runner.runMutation(module.expandWithPreference, { compact: true, documentId });

    expect(await nextUpdate(updates, 1)).toEqual([documentId]);
    off();
  });
});

describe("device-only namespace typing", () => {
  test("binds generated builders to their schema's device data model", () => {
    expectTypeOf<typeof deviceSchema>().toExtend<EmbeddedSchemaDefinition>();
    expectTypeOf(device).toEqualTypeOf<LocalBuilders<DeviceDataModel<typeof deviceSchema>>>();

    const setCompact = device.mutation({
      args: { compact: v.boolean() },
      handler: async (ctx, args) => {
        await ctx.db.insert("preferences", { compact: args.compact, label: "initial" });
      },
    });
    expect(isLocalFunction(setCompact)).toBe(true);
  });
});

const deviceSchema = defineEmbeddedSchema({
  documents: replicatedTable({
    expanded: e.local(v.boolean()),
    title: v.string(),
  }),
  preferences: localTable({ compact: v.boolean(), label: v.string() }).index("by_compact", [
    "compact",
  ]),
});
const deviceStoreSchema = toRuntimeStoreSchema(deviceSchema);
const device = defineLocal(deviceSchema);

const docs = {
  seed: defineFunctions<ReplicatedDataModel<typeof deviceSchema>>().replicated.mutation({
    args: { title: v.string() },
    handler: async (ctx, args) => await ctx.db.insert("documents", { title: args.title }),
  }),
};

function viewModule() {
  return {
    expanded: device.query({
      args: {},
      handler: async (ctx) =>
        (await ctx.db.query("documents").collect())
          .filter((document) => document.expanded === true)
          .map((document) => document._id),
    }),
    expandWithPreference: device.mutation({
      args: { compact: v.boolean(), documentId: v.id("documents") },
      handler: async (ctx, args) => {
        await ctx.db.insert("preferences", { compact: args.compact, label: "initial" });
        await ctx.db.patch("documents", args.documentId, { expanded: true });
      },
    }),
    toggleExpanded: device.mutation({
      args: { documentId: v.id("documents") },
      handler: async (ctx, args) => {
        const document = await ctx.db.get("documents", args.documentId);
        await ctx.db.patch("documents", args.documentId, { expanded: document?.expanded !== true });
      },
    }),
  };
}

async function nextUpdate<T>(updates: T[], seen: number): Promise<T> {
  const started = getTimerTime();
  while (updates.length <= seen) {
    if (getTimerTime() - started > 1_000) {
      throw new Error(`timed out waiting for update ${seen + 1}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return updates[seen] as T;
}

function draftsModule() {
  const clear = device.internalMutation({
    args: {},
    handler: async (ctx) => {
      for (const row of await ctx.db.query("preferences").collect()) {
        await ctx.db.delete("preferences", row._id);
      }
    },
  });
  return {
    clear,
    readCompact: device.query({
      args: {},
      handler: async (ctx) =>
        (await ctx.db.query("preferences").collect()).map((row) => row.compact),
    }),
    readLabel: device.query({
      args: {},
      handler: async (ctx) => (await ctx.db.query("preferences").collect()).map((row) => row.label),
    }),
    reset: device.mutation({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(clear, {});
      },
    }),
    setCompact: device.mutation({
      args: { compact: v.boolean() },
      handler: async (ctx, args) => {
        await ctx.db.insert("preferences", { compact: args.compact, label: "initial" });
      },
    }),
  };
}

async function deviceStore(): Promise<RuntimeStorageWriter> {
  const store = await NativeStore.openWith(nativeModule().Store, temporaryPath("placement"));
  await store.setup(deviceStoreSchema);
  return store;
}

async function localRunner(localModules: LocalModuleMap): Promise<Runner> {
  const runner = createRunner({ docs }, await deviceStore(), deviceStoreSchema, { localModules });
  await runner.localReady;
  return runner;
}

function fakeStore(): RuntimeStorageWriter {
  const id = "documents|00000000000040008000000000000001";
  return {
    capabilities: { hasExactBounds: true },
    clock: { read: () => 10 },
    commit: async () => ({ changedTables: [], changes: [], commitSeq: 1 }),
    doc: {
      read: async (table: string, rowId: string) =>
        table === "documents" && rowId === id
          ? { _id: id, _creationTime: 1, title: "wire" }
          : undefined,
      device: { read: async () => ({ expanded: true }) },
      version: { read: async () => 1 },
      crdt: {
        read: async () => 0,
        snapshot: { read: async () => [] },
      },
      page: {
        read: async () => ({ docs: [], cursor: null }),
      },
      count: { read: async () => 0 },
    },
    id: {
      read: async () => undefined,
      page: { read: async () => [] },
    },
    key: {
      page: { read: async () => ({ ids: [], creationTimes: [], cursor: null }) },
    },
  } as unknown as RuntimeStorageWriter;
}
