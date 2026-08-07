import { v } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import type { EmbeddedDataEvent } from "../../src/events";
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
import type { RuntimeStorageWriter, StoreSchema } from "../../src/storage/types";
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
      columns: [{ field: "compact", name: "compact" }],
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

test("device writer preserves columns for an unindexed patch of a persisted local table", async () => {
  const writer = createWriter(fakeStore(), toSchema(schema), undefined, "device");
  const id = "preferences|00000000000040008000000000000002";

  await writer.db.patch("preferences" as never, id as never, { note: "after" } as never);

  expect(writer.toBatch()).toMatchObject({
    dataOnlyIds: [],
    docWrites: [
      {
        table: "preferences",
        id,
        data: { compact: true, note: "after" },
        cols: [["compact", true]],
      },
    ],
  });
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

test("the devtools snapshot collects supported storage diagnostics sequentially", async () => {
  const base = fakeStore();
  const reads: string[] = [];
  const crdtReads: string[] = [];
  const projectionReads: string[] = [];
  const fileReads: string[] = [];
  const store = {
    ...base,
    doc: {
      ...base.doc,
      crdt: {
        read: async (table: string, id: string, field: string) => {
          reads.push(`crdt:${table}:${id}:${field}`);
          crdtReads.push(`${table}:${id}:${field}`);
          return id === "documents|good" ? 7 : undefined;
        },
        snapshot: { read: async () => [] },
      },
    },
    file: {
      read: async (storageId: string) => {
        reads.push(`file:${storageId}`);
        fileReads.push(storageId);
        return storageId === "_storage|mapped" || storageId === "_storage|upload"
          ? { contentType: "text/plain", id: storageId, size: 1 }
          : undefined;
      },
    },
    id: {
      page: {
        read: async (table: string) =>
          (reads.push(`mapping:${table}`), table === "documents")
            ? [
                { localId: "documents|good", table: "documents" },
                { localId: 1, table: "documents" },
                { localId: "documents|missing", table: "missing" },
              ]
            : table === "_storage"
              ? [{ localId: "_storage|mapped", table: "_storage" }]
              : [],
      },
    },
    remoteDocDebugRead: async (table: string, id: string) => {
      reads.push(`projection:${table}:${id}`);
      projectionReads.push(`${table}:${id}`);
      return id === "documents|good" ? { localDocumentId: id, table } : undefined;
    },
    dirtyHeadsDebugRead: async () => {
      reads.push("dirtyHeads");
      return [];
    },
    upload: {
      read: async () => {
        reads.push("uploads");
        return [
          { localStorageId: "_storage|mapped" },
          { localStorageId: "_storage|upload" },
          { localStorageId: 1 },
        ];
      },
    },
  } as unknown as RuntimeStorageWriter;
  const runner = createRunner({}, store, {
    hash: "devtools-collectors",
    tables: [
      {
        columns: [],
        crdtFields: [{ field: "body", kind: "text" }],
        indexes: [],
        name: "documents",
        placement: "replicated",
      },
    ],
  });

  const snapshot = (await runner.devtools({ kind: "snapshot" })) as {
    storage: {
      crdtHeads: unknown[];
      files: Array<{ id: string }>;
      idMappings: unknown[];
      projections: unknown[];
    };
  };

  expect(snapshot.storage.idMappings).toEqual([
    { localId: "documents|good", table: "documents" },
    { localId: 1, table: "documents" },
    { localId: "documents|missing", table: "missing" },
    { localId: "_storage|mapped", table: "_storage" },
  ]);
  expect(snapshot.storage.crdtHeads).toEqual([
    { field: "body", headSeq: 7, id: "documents|good", table: "documents" },
  ]);
  expect(snapshot.storage.projections).toEqual([
    { localDocumentId: "documents|good", table: "documents" },
  ]);
  expect(snapshot.storage.files).toEqual([
    { contentType: "text/plain", id: "_storage|mapped", size: 1 },
    { contentType: "text/plain", id: "_storage|upload", size: 1 },
  ]);
  expect(crdtReads).toEqual(["documents:documents|good:body"]);
  expect(projectionReads).toEqual([
    "documents:documents|good",
    "missing:documents|missing",
    "_storage:_storage|mapped",
  ]);
  expect(fileReads).toEqual(["_storage|mapped", "_storage|upload"]);
  expect(reads).toEqual([
    "mapping:documents",
    "mapping:_storage",
    "uploads",
    "dirtyHeads",
    "crdt:documents:documents|good:body",
    "projection:documents:documents|good",
    "projection:missing:documents|missing",
    "projection:_storage:_storage|mapped",
    "file:_storage|mapped",
    "file:_storage|upload",
  ]);
});

test("the devtools snapshot tolerates unavailable optional storage diagnostics", async () => {
  const base = fakeStore();
  const runner = createRunner(
    {},
    {
      ...base,
      file: undefined,
      id: undefined,
      upload: undefined,
    } as unknown as RuntimeStorageWriter,
    schema,
  );

  const snapshot = (await runner.devtools({ kind: "snapshot" })) as {
    storage: {
      crdtHeads: unknown[];
      files: unknown[];
      idMappings: unknown[];
      projections: unknown[];
    };
  };

  expect(snapshot.storage).toMatchObject({
    crdtHeads: [],
    files: [],
    idMappings: [],
    projections: [],
  });
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

  test("reruns watchers and emits a local event for a persisted device-table patch", async () => {
    const module = draftsModule();
    const runner = await localRunner({ "local/sync/drafts": () => Promise.resolve(module) });
    const id = (await runner.runMutation(module.setCompact, { compact: true })) as string;
    const updates: string[][] = [];
    const events: EmbeddedDataEvent[] = [];
    const off = runner.onUpdate(module.readNotes, {}, (value) => updates.push(value as string[]));
    const unsubscribe = runner.subscribeEvents?.((event) => {
      if (event.type === "data") events.push(event);
    });
    expect(await nextUpdate(updates, 0)).toEqual(["before"]);

    await runner.runMutation(module.patchNote, { id, note: "after" });

    expect(await nextUpdate(updates, 1)).toEqual(["after"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        source: "local",
        docWrites: [
          expect.objectContaining({
            table: "preferences",
            id,
            row: expect.objectContaining({ compact: true, note: "after" }),
          }),
        ],
      }),
    );
    unsubscribe?.();
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
        await ctx.db.insert("preferences", { compact: args.compact, note: "before" });
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
  preferences: localTable({ compact: v.boolean(), note: v.string() }).index("by_compact", [
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
        await ctx.db.insert("preferences", { compact: args.compact, note: "before" });
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
    readNotes: device.query({
      args: {},
      handler: async (ctx) => (await ctx.db.query("preferences").collect()).map((row) => row.note),
    }),
    reset: device.mutation({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(clear, {});
      },
    }),
    setCompact: device.mutation({
      args: { compact: v.boolean() },
      handler: async (ctx, args) =>
        await ctx.db.insert("preferences", { compact: args.compact, note: "before" }),
    }),
    patchNote: device.mutation({
      args: { id: v.id("preferences"), note: v.string() },
      handler: async (ctx, args) => await ctx.db.patch("preferences", args.id, { note: args.note }),
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
  const preferenceId = "preferences|00000000000040008000000000000002";
  return {
    capabilities: { hasExactBounds: true },
    clock: { read: () => 10 },
    commit: async () => ({ changedTables: [], changes: [], commitSeq: 1 }),
    doc: {
      read: async (table: string, rowId: string) =>
        table === "documents" && rowId === id
          ? { _id: id, _creationTime: 1, title: "wire" }
          : table === "preferences" && rowId === preferenceId
            ? { _id: preferenceId, _creationTime: 2, compact: true, note: "before" }
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
