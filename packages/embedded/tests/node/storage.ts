import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { NativeStore } from "../../src/node/native";
import type { StorageBackend, StoreSchema, UpsertIn } from "../../src/storage/types";
import { defineConformance } from "./conformance";
import { nativeModule } from "./native";

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
    creationTime: Date.now(),
  };
}

describe("native storage details", () => {
  test("NativeStore satisfies the backend contract", async () => {
    const store = await open(tmp("native_backend_contract.db"));
    const backend: StorageBackend = store;
    expect(backend).toBe(store);
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
      store.doc.scan({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value }],
        order: "asc",
      });
    expect((await byStatus("open")).docs.map((doc) => doc._id)).toEqual(["a"]);
    expect((await byStatus("closed")).docs.map((doc) => doc._id)).toEqual(["b"]);
    await store.close();
  });

  test("plans Convex field paths through storage column aliases", async () => {
    const store = await open(tmp("native_aliases.db"));
    await store.setup(aliasSchema);
    const first = store.clock.next();
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
          creationTime: store.clock.next(),
        },
      ],
      deletes: [],
    });

    expect(
      (
        await store.doc.scan({
          table: "users",
          index: "by_email",
          bounds: [{ kind: "eq", value: "b@example.com" }],
          order: "asc",
        })
      ).docs.map((doc) => doc._id),
    ).toEqual(["users|b"]);
    expect(
      (
        await store.doc.scan({
          table: "users",
          index: "by_creation_time",
          bounds: [{ kind: "range", lower: first, lowerInclusive: true }],
          order: "asc",
        })
      ).docs.map((doc) => doc._id),
    ).toEqual(["users|a", "users|b"]);
    expect(
      (
        await store.doc.scan({
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
    const first = await store.doc.scan({ table: "issues", order: "asc", pageSize: 2 });
    expect(first.cursor).not.toBeNull();
    const last = first.docs.at(-1)!;
    const resumed = await store.doc.scan({
      table: "issues",
      order: "asc",
      resumeAfterKey: [last._creationTime, last._id],
    });
    expect(resumed.docs.map((doc) => doc._id)).toEqual(["c"]);

    await expect(
      store.doc.scan({ table: "issues", order: "desc", cursor: first.cursor! }),
    ).rejects.toThrow("cursor");
    await store.close();
  });

  test("rejects more bounds than the index has columns", async () => {
    const store = await open(tmp("native_too_many_bounds.db"));
    await store.setup(schema);

    // by_status has columns (status, creation_time_ms); three bounds exceeds that.
    await expect(
      store.doc.scan({
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
      store.doc.scan({
        table: "missing",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
        order: "asc",
      }),
    ).rejects.toThrow(/missing/);

    await expect(
      store.doc.count({
        table: "issues",
        index: "missing",
        bounds: [{ kind: "eq", value: "open" }],
      }),
    ).rejects.toThrow(/unknown index/);

    await store.close();
  });
});
