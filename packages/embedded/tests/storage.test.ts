import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { StoreSchema, UpsertIn } from "../src/storage/types";
import { EmbeddedStore } from "../src/storage/store";
import { openTurso } from "../src/node/turso";

const schema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [{ name: "status", affinity: "TEXT" }],
      indexes: [{ name: "by_status", fields: ["status"] }],
    },
    { name: "t", columns: [], indexes: [] },
  ],
};

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

async function open(path: string): Promise<EmbeddedStore> {
  return EmbeddedStore.open(await openTurso(path));
}

function issue(id: string, title: string, status: string): UpsertIn {
  return { table: "issues", id, data: { title }, cols: { status }, creationTime: Date.now() };
}

describe("storage", () => {
  test("round-trips and persists across reopen", async () => {
    const path = tmp("ts_roundtrip.db");
    {
      const store = await open(path);
      await store.setup(schema);
      await store.commit({ upserts: [issue("i1", "hello", "open")], deletes: [] });
      const got = await store.get("issues", "i1");
      expect(got?._id).toBe("i1");
      expect(typeof got?._creationTime).toBe("number");
      expect((got!.data as { title: string }).title).toBe("hello");
      expect(await store.get("issues", "missing")).toBeUndefined();
      await store.close();
    }

    const store = await open(path);
    await store.setup(schema);
    expect((await store.get("issues", "i1"))?._id).toBe("i1");
    await store.commit({ upserts: [issue("i2", "world", "open")], deletes: [] });
    expect((await store.scan({ table: "issues", order: "asc" }))?.length).toBe(2);
    await store.close();
  });

  test("rejects bad identifiers", async () => {
    const store = await open(tmp("ts_idents.db"));
    await expect(
      store.setup({ tables: [{ name: "issues; DROP TABLE x", columns: [], indexes: [] }] }),
    ).rejects.toBeInstanceOf(Error);
    await store.close();
  });

  test("commits a batch atomically", async () => {
    const store = await open(tmp("ts_atomic.db"));
    await store.setup(schema);
    const upserts: UpsertIn[] = Array.from({ length: 50 }, (_, i) => ({
      table: "t",
      id: `id-${i}`,
      data: { k: 1 },
      cols: {},
      creationTime: Date.now(),
    }));
    await store.commit({ upserts, deletes: [] });
    expect((await store.scan({ table: "t", order: "asc" }))?.length).toBe(50);
    await store.close();
  });

  test("scans by an index bound and counts", async () => {
    const store = await open(tmp("ts_index.db"));
    await store.setup(schema);
    await store.commit({
      upserts: [issue("a", "A", "open"), issue("b", "B", "closed"), issue("c", "C", "open")],
      deletes: [],
    });
    const onlyOpen = await store.scan({
      table: "issues",
      index: "by_status",
      bounds: [{ kind: "eq", value: "open" }],
      order: "asc",
    });
    expect(onlyOpen?.map((d) => d._id)).toEqual(["a", "c"]);
    expect(await store.count({ table: "issues" })).toBe(3);
    expect(
      await store.count({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
      }),
    ).toBe(2);
    await store.close();
  });

  test("binds fresh params per call instead of reusing the cached plan", async () => {
    const store = await open(tmp("ts_cache.db"));
    await store.setup(schema);
    await store.commit({
      upserts: [issue("a", "A", "open"), issue("b", "B", "closed")],
      deletes: [],
    });
    const byStatus = (value: string) =>
      store.scan({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value }],
        order: "asc",
      });
    expect((await byStatus("open"))?.map((d) => d._id)).toEqual(["a"]);
    expect((await byStatus("closed"))?.map((d) => d._id)).toEqual(["b"]);
    await store.close();
  });

  test("returns null on a pushdown miss and throws on an unsatisfiable spec", async () => {
    const store = await open(tmp("ts_miss.db"));
    await store.setup(schema);
    expect(await store.scan({ table: "issues", index: "nope", order: "asc" })).toBeNull();
    await expect(
      store.scan({ table: "issues", order: "asc", limit: 40_000 }),
    ).rejects.toBeInstanceOf(Error);
    await store.close();
  });

  test("deletes a document", async () => {
    const store = await open(tmp("ts_delete.db"));
    await store.setup(schema);
    await store.commit({ upserts: [issue("x", "X", "open")], deletes: [] });
    await store.commit({ upserts: [], deletes: [{ table: "issues", id: "x" }] });
    expect(await store.get("issues", "x")).toBeUndefined();
    await store.close();
  });
});
