import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { openTurso } from "../src/node/turso";
import { EmbeddedStore } from "../src/storage/store";
import type { EmbeddedStoreBackend, StoreSchema, UpsertIn } from "../src/storage/types";
import { defineConformance } from "./conformance";

defineConformance({
  name: "ts-turso",
  async open(path: string, identityKey = ""): Promise<EmbeddedStoreBackend> {
    return EmbeddedStore.open(await openTurso(path), identityKey);
  },
});

const schema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [{ name: "status", affinity: "TEXT" }],
      indexes: [{ name: "by_status", fields: ["status"] }],
    },
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
  return {
    table: "issues",
    id,
    data: { title, status },
    cols: { status },
    creationTime: Date.now(),
  };
}

describe("ts storage details", () => {
  test("EmbeddedStore satisfies the backend contract", async () => {
    const store = await open(tmp("ts_backend_contract.db"));
    const backend: EmbeddedStoreBackend = store;
    expect(backend).toBe(store);
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
    expect((await byStatus("open"))?.map((doc) => doc._id)).toEqual(["a"]);
    expect((await byStatus("closed"))?.map((doc) => doc._id)).toEqual(["b"]);
    await store.close();
  });
});
