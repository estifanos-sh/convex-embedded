import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { NativeStore } from "../../src/node/native";
import type { StorageBackend, StoreSchema, StoredDoc, UpsertIn } from "../../src/storage/types";
import { getTimerTime } from "../../src/time";
import { defineConformance } from "../testkit/conformance";
import { nativeModule } from "../testkit/native";

defineConformance({
  name: "node-native",
  async open(path: string, identityKey = ""): Promise<StorageBackend> {
    return NativeStore.openWith(nativeModule().Store, path, { identityKey });
  },
});

const schema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [{ name: "status" }],
      indexes: [{ name: "by_status", fields: ["status"] }],
    },
  ],
};

const aliasSchema: StoreSchema = {
  tables: [
    {
      name: "users",
      columns: [{ name: "idx_profile_email", field: "profile.email" }],
      indexes: [
        {
          name: "by_email",
          fields: ["profile.email", "_creationTime"],
          columns: ["idx_profile_email", "creation_time_ms"],
        },
        { name: "by_creation_time", fields: ["_creationTime"], columns: ["creation_time_ms"] },
        { name: "by_id", fields: ["_id"], columns: ["id"] },
      ],
    },
  ],
};

const cacheSchema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [{ name: "status" }],
      indexes: [{ name: "by_status", fields: ["status"] }],
    },
    {
      name: "notes",
      columns: [{ name: "kind" }],
      indexes: [{ name: "by_kind", fields: ["kind"] }],
    },
  ],
};

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

async function open(path: string): Promise<NativeStore> {
  return NativeStore.openWith(nativeModule().Store, path);
}

function issue(id: string, title: string, status: string): UpsertIn {
  return {
    table: "issues",
    id,
    data: { title, status },
    cols: { status },
    creationTime: getTimerTime(),
  };
}

describe("native storage details", () => {
  test("rejects an impossible upload lease from a native adapter", async () => {
    const store = NativeStore.wrap({
      clear: async () => undefined,
      clockRead: () => 1,
      close: async () => undefined,
      setup: async () => undefined,
      uploadRead: async () => [
        {
          localStorageId: "_storage|local",
          sha256: "sha256:abc",
          size: 3,
          state: "claimed",
          owner: null,
          leaseUntil: 10,
          createdTime: 1,
          updatedTime: 1,
        },
      ],
    });

    await expect(store.upload.read()).rejects.toThrow("Invalid upload lease for state claimed");
  });

  test("rejects an impossible scheduled lease from a native adapter", async () => {
    const store = NativeStore.wrap({
      clear: async () => undefined,
      clockRead: () => 1,
      close: async () => undefined,
      scheduleRead: async () => [
        {
          jobId: "_scheduled_functions|local",
          kind: "mutation",
          name: "tasks:run",
          args: "{}",
          dueTime: 1,
          state: "running",
          leaseUntil: null,
          createdTime: 1,
          updatedTime: 1,
        },
      ],
      setup: async () => undefined,
    });

    await expect(store.schedule.read()).rejects.toThrow(
      "Invalid scheduled lease for state running",
    );
  });

  test("rejects an impossible mapped ID from a native adapter", async () => {
    const store = NativeStore.wrap({
      clear: async () => undefined,
      clockRead: () => 1,
      close: async () => undefined,
      idRead: async () => ({
        table: "issues",
        localId: "issues|local",
        convexId: null,
        state: "mapped",
        createdTime: 1,
        updatedTime: 1,
      }),
      setup: async () => undefined,
    });

    await expect(store.id.read("issues", "issues|local")).rejects.toThrow(
      "mapped ID mapping requires convexId",
    );
  });

  test("NativeStore satisfies the backend contract", async () => {
    const store = await open(tmp("native_backend_contract.db"));
    const backend: StorageBackend = store;
    expect(backend).toBe(store);
    await store.close();
  });

  test("invalid one-upsert encoding fails loudly instead of falling back to generic commit", async () => {
    let genericCommits = 0;
    const store = NativeStore.wrap({
      clear: async () => undefined,
      clockRead: () => 1,
      close: async () => undefined,
      commit: async () => {
        genericCommits += 1;
        return { changedTables: ["issues"], changes: [], commitSeq: 1 };
      },
      setup: async () => undefined,
    });

    await expect(
      store.commitOneUpsert!(
        {
          fresh: true,
          upsert: issue("missing-fast-path", "missing", "open"),
        },
        { changes: "omit", mutation: "none", source: "local" },
      ),
    ).rejects.toThrow("missing commitOneUpsertEncoded");
    expect(genericCommits).toBe(0);
  });

  test("completes a claimed upload through the atomic mapping path", async () => {
    const store = await open(tmp("native_upload_complete.db"));
    await store.setup(schema);
    await store.upload.write({
      contentType: "text/plain",
      createdTime: 10,
      localStorageId: "_storage|local",
      sha256: "sha256:abc",
      size: 3,
      lease: "pending",
      updatedTime: 10,
    });
    await store.id.write({
      createdTime: 10,
      localId: "_storage|local",
      mapping: "local",
      table: "_storage",
      updatedTime: 10,
    });

    expect(
      await store.upload.lease.write({
        lease: "claim",
        owner: "remote",
        nowMs: 20,
        leaseUntil: 120,
      }),
    ).toMatchObject({
      localStorageId: "_storage|local",
      owner: "remote",
      lease: "claimed",
    });
    await expect(
      store.upload.complete("_storage|local", "other", "_storage|server", 30),
    ).resolves.toBe(false);

    await expect(
      store.upload.complete("_storage|local", "remote", "_storage|server", 30),
    ).resolves.toBe(true);

    expect(await store.upload.read()).toEqual([]);
    expect(await store.id.read("_storage", "_storage|local")).toMatchObject({
      convexId: "_storage|server",
      localId: "_storage|local",
      mapping: "mapped",
      table: "_storage",
    });
    expect(await store.id.read("_storage", "_storage|local")).toMatchObject({
      createdTime: 10,
      updatedTime: 30,
    });
    await expect(
      store.upload.lease.write({
        lease: "claim",
        localStorageId: "_storage|local",
        owner: "remote",
        nowMs: 40,
        leaseUntil: 140,
      } as never),
    ).rejects.toThrow("invalid upload lease claim command payload");
    await store.close();
  });

  test("binds fresh params per call instead of reusing the cached plan", async () => {
    const store = await open(tmp("native_cache.db"));
    await store.setup(schema);
    await store.commit({
      upserts: [issue("a", "A", "open"), issue("b", "B", "closed")],
      deletes: [],
    });
    const byStatus = (value: string) =>
      store.doc.page.read({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value }],
        order: "asc",
      });
    expect((await byStatus("open")).docs.map((doc) => doc._id)).toEqual(["a"]);
    expect((await byStatus("closed")).docs.map((doc) => doc._id)).toEqual(["b"]);
    await store.close();
  });

  test("native schedule writes reject running jobs without a lease", async () => {
    const store = await open(tmp("native_schedule_exact_state.db"));
    await store.setup(schema);
    await expect(
      store.schedule.write({
        jobId: "_scheduled_functions|local",
        kind: "mutation",
        name: "tasks:run",
        args: "{}",
        dueTime: 1,
        state: "running",
        createdTime: 1,
        updatedTime: 1,
      } as never),
    ).rejects.toThrow("invalid scheduled job state: running");
    await store.close();
  });

  test("native commits reject partial terminal metadata", async () => {
    const store = await open(tmp("native_commit_exact_metadata.db"));
    await store.setup(schema);
    await expect(
      store.commit({ deletes: [], upserts: [] }, {
        changes: "omit",
        mutation: "terminal",
        mutationArgs: "{}",
        mutationFresh: false,
        mutationId: "mutation:partial",
        mutationName: "issues:send",
        mutationResult: "null",
        push: { json: "{}" },
        source: "local",
      } as never),
    ).rejects.toThrow("invalid exact commit metadata");
    await store.close();
  });

  test("plans Convex field paths through storage column aliases", async () => {
    const store = await open(tmp("native_aliases.db"));
    await store.setup(aliasSchema);
    const first = store.clock.read();
    await store.commit({
      upserts: [
        {
          table: "users",
          id: "users|a",
          data: { profile: { email: "a@example.com" } },
          cols: { idx_profile_email: "a@example.com" },
          creationTime: first,
        },
        {
          table: "users",
          id: "users|b",
          data: { profile: { email: "b@example.com" } },
          cols: { idx_profile_email: "b@example.com" },
          creationTime: store.clock.read(),
        },
      ],
      deletes: [],
    });

    expect(
      (
        await store.doc.page.read({
          table: "users",
          index: "by_email",
          bounds: [{ kind: "eq", value: "b@example.com" }],
          order: "asc",
        })
      ).docs.map((doc) => doc._id),
    ).toEqual(["users|b"]);
    expect(
      (
        await store.doc.page.read({
          table: "users",
          index: "by_creation_time",
          bounds: [{ kind: "range", lower: first, lowerInclusive: true }],
          order: "asc",
        })
      ).docs.map((doc) => doc._id),
    ).toEqual(["users|a", "users|b"]);
    expect(
      (
        await store.doc.page.read({
          table: "users",
          index: "by_id",
          bounds: [{ kind: "eq", value: "users|a" }],
          order: "asc",
        })
      ).docs.map((doc) => doc._id),
    ).toEqual(["users|a"]);
    await store.close();
  });

  test("resumes a scan strictly after an explicit key tuple", async () => {
    const store = await open(tmp("native_resume_key.db"));
    await store.setup(schema);
    await store.commit({
      upserts: [issue("a", "A", "open"), issue("b", "B", "open"), issue("c", "C", "open")],
      deletes: [],
    });
    const first = await store.doc.page.read({ table: "issues", order: "asc", pageSize: 2 });
    expect(first.cursor).not.toBeNull();
    const last = first.docs.at(-1)!;
    const resumed = await store.doc.page.read({
      table: "issues",
      order: "asc",
      resumeAfterKey: [last._creationTime, last._id],
    });
    expect(resumed.docs.map((doc) => doc._id)).toEqual(["c"]);

    await expect(
      store.doc.page.read({ table: "issues", order: "desc", cursor: first.cursor! }),
    ).rejects.toThrow("cursor");
    await store.close();
  });

  test("rejects more bounds than the index has columns", async () => {
    const store = await open(tmp("native_too_many_bounds.db"));
    await store.setup(schema);

    await expect(
      store.doc.page.read({
        table: "issues",
        index: "by_status",
        bounds: [
          { kind: "eq", value: "open" },
          { kind: "eq", value: 1 },
          { kind: "eq", value: 2 },
        ],
        order: "asc",
      }),
    ).rejects.toThrow(/more bounds than indexed columns/);
    await store.close();
  });

  test("rejects bounds for unknown tables and indexes", async () => {
    const store = await open(tmp("native_unknown_bound_schema.db"));
    await store.setup(schema);

    await expect(
      store.doc.page.read({
        table: "missing",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
        order: "asc",
      }),
    ).rejects.toThrow(/missing/);

    await expect(
      store.doc.count.read({
        table: "issues",
        index: "missing",
        bounds: [{ kind: "eq", value: "open" }],
      }),
    ).rejects.toThrow(/unknown index/);

    await store.close();
  });

  test("shares immutable cached docs and invalidates precise cache entries", async () => {
    const store = await open(tmp("native_read_cache_epoch.db"));
    await store.setup(cacheSchema);
    await store.commit({ upserts: [issue("a", "A", "open")], deletes: [] });

    const first = await store.doc.read("issues", "a");
    expect(first).toBeDefined();
    const second = await store.doc.read("issues", "a");
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as unknown as { status: string }).status = "mutated";
    }).toThrow(TypeError);

    await store.commit({
      upserts: [
        {
          table: "notes",
          id: "n",
          data: { kind: "memo" },
          cols: { kind: "memo" },
          creationTime: getTimerTime(),
        },
      ],
      deletes: [],
    });
    expect(await store.doc.read("issues", "a")).toBe(first);

    await store.commit({ upserts: [issue("a", "A2", "closed")], deletes: [] });
    const changed = await store.doc.read("issues", "a");
    expect(changed).not.toBe(first);
    expect(changed?.status).toBe("closed");

    const page = await store.doc.page.read({
      table: "issues",
      index: "by_status",
      bounds: [{ kind: "eq", value: "closed" }],
      order: "asc",
    });
    const cachedPage = await store.doc.page.read({
      table: "issues",
      index: "by_status",
      bounds: [{ kind: "eq", value: "closed" }],
      order: "asc",
    });
    expect(cachedPage).toBe(page);
    expect(cachedPage.docs[0]).toBe(page.docs[0]);
    expect(Object.isFrozen(cachedPage)).toBe(true);
    expect(Object.isFrozen(cachedPage.docs[0])).toBe(true);

    await store.commit({
      upserts: [issue("a", "A3", "closed")],
      deletes: [],
      dataOnlyIds: [{ table: "issues", id: "a" }],
    });
    const dataOnlyPage = await store.doc.page.read({
      table: "issues",
      index: "by_status",
      bounds: [{ kind: "eq", value: "closed" }],
      order: "asc",
    });
    expect(dataOnlyPage).not.toBe(page);
    expect(dataOnlyPage.docs[0]?.title).toBe("A3");
    expect(store.readCacheStats().queryTableEpochs.issues).toBeUndefined();

    const stats = store.readCacheStats();
    expect(stats.hits.doc).toBeGreaterThanOrEqual(2);
    expect(stats.hits.page).toBeGreaterThanOrEqual(2);
    expect(stats.docTableEpochs.issues).toBeUndefined();
    expect(stats.docTableEpochs.notes).toBeUndefined();
    expect(stats.queryTableEpochs.issues).toBeUndefined();
    expect(stats.queryTableEpochs.notes).toBeUndefined();

    await store.commit({ upserts: [issue("b", "B", "closed")], deletes: [] });
    const invalidatedPage = await store.doc.page.read({
      table: "issues",
      index: "by_status",
      bounds: [{ kind: "eq", value: "closed" }],
      order: "asc",
    });
    expect(invalidatedPage).not.toBe(page);
    expect(store.readCacheStats().queryTableEpochs.issues).toBe(1);

    await store.close();
  });

  test("does not share byte-containing docs with cache readers", async () => {
    const store = await open(tmp("native_read_cache_bytes.db"));
    await store.setup(schema);
    await store.commit({
      upserts: [
        {
          table: "issues",
          id: "bytes",
          data: { bytes: new Uint8Array([1, 2, 3]).buffer, status: "open" },
          cols: { status: "open" },
          creationTime: getTimerTime(),
        },
      ],
      deletes: [],
    });

    const first = (await store.doc.read("issues", "bytes")) as StoredDoc & {
      bytes: ArrayBuffer;
    };
    const second = (await store.doc.read("issues", "bytes")) as StoredDoc & {
      bytes: ArrayBuffer;
    };
    expect(second).not.toBe(first);
    new Uint8Array(first.bytes)[0] = 9;
    const third = (await store.doc.read("issues", "bytes")) as StoredDoc & {
      bytes: ArrayBuffer;
    };
    expect(new Uint8Array(third.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.readCacheStats().unshareableReturns).toBeGreaterThanOrEqual(3);

    await store.close();
  });
});
