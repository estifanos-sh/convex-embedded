import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ColValue, EmbeddedStoreBackend, StoreSchema, UpsertIn } from "../src/storage/types";

const schema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [
        { name: "status", affinity: "TEXT" },
        { name: "rank", affinity: "INTEGER" },
      ],
      indexes: [
        { name: "by_status", fields: ["status"] },
        { name: "by_rank", fields: ["rank"] },
      ],
    },
    { name: "t", columns: [], indexes: [] },
  ],
};

const boolSchema: StoreSchema = {
  tables: [
    {
      name: "flags",
      columns: [{ name: "active", affinity: "INTEGER" }],
      indexes: [{ name: "by_active", fields: ["active"] }],
    },
  ],
};

export interface ConformanceFactory {
  name: string;
  open(path: string, identityKey?: string): Promise<EmbeddedStoreBackend>;
}

export function defineConformance(factory: ConformanceFactory): void {
  const path = (name: string) => tmp(`${factory.name}_${name}.db`);

  describe(`${factory.name} storage conformance`, () => {
    test("round-trips, deletes, reopens, and recovers creation time", async () => {
      const db = path("roundtrip");
      let firstCreationTime = 0;
      {
        const store = await factory.open(db);
        await store.setup(schema);
        const first = issue("i1", "hello", "open", 1, store.nextCreationTime());
        firstCreationTime = first.creationTime;
        await store.commit({ upserts: [first], deletes: [] });

        const got = await store.get("issues", "i1");
        expect(got?._id).toBe("i1");
        expect(got?._creationTime).toBe(firstCreationTime);
        expect(got?.data.title).toBe("hello");
        expect(await store.get("issues", "missing")).toBeUndefined();
        await store.close();
      }

      const store = await factory.open(db);
      await store.setup(schema);
      expect((await store.get("issues", "i1"))?._id).toBe("i1");
      const second = issue("i2", "world", "open", 2, store.nextCreationTime());
      expect(second.creationTime).toBeGreaterThan(firstCreationTime);
      await store.commit({ upserts: [second], deletes: [] });
      await store.commit({ upserts: [], deletes: [{ table: "issues", id: "i1" }] });

      expect(await store.get("issues", "i1")).toBeUndefined();
      expect((await store.scan({ table: "issues", order: "asc" }))?.map((doc) => doc._id)).toEqual([
        "i2",
      ]);
      await store.close();
    });

    test("isolates identity keys", async () => {
      const db = path("identity");
      const a = await factory.open(db, "a");
      const b = await factory.open(db, "b");
      await a.setup(schema);
      await b.setup(schema);

      await a.commit({
        upserts: [issue("same", "A", "open", 1, a.nextCreationTime())],
        deletes: [],
      });
      await b.commit({
        upserts: [issue("same", "B", "closed", 2, b.nextCreationTime())],
        deletes: [],
      });

      expect((await a.get("issues", "same"))?.data.title).toBe("A");
      expect((await b.get("issues", "same"))?.data.title).toBe("B");
      await a.close();
      await b.close();
    });

    test("rejects unsafe schema names before issuing SQL", async () => {
      const store = await factory.open(path("idents"));
      await expect(
        store.setup({ tables: [{ name: "issues; DROP TABLE x", columns: [], indexes: [] }] }),
      ).rejects.toThrow("invalid identifier");
      await expect(
        store.setup({
          tables: [
            {
              name: "issues",
              columns: [{ name: "data", affinity: "TEXT" }],
              indexes: [],
            },
          ],
        }),
      ).rejects.toThrow("reserved column name: data");
      await store.close();
    });

    test("rolls back a failed batch", async () => {
      const store = await factory.open(path("rollback"));
      await store.setup(boolSchema);
      await expect(
        store.commit({
          upserts: [
            flag("good", true, store.nextCreationTime()),
            flag("bad", "not-an-integer", store.nextCreationTime()),
          ],
          deletes: [],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await store.get("flags", "good")).toBeUndefined();
      await store.close();
    });

    test("scans and counts with ordering, range bounds, and unsupported plans", async () => {
      const store = await factory.open(path("scan"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          issue("a", "A", "open", 1, store.nextCreationTime()),
          issue("b", "B", "closed", 2, store.nextCreationTime()),
          issue("c", "C", "open", 3, store.nextCreationTime()),
        ],
        deletes: [],
      });

      const onlyOpen = await store.scan({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
        order: "asc",
      });
      expect(onlyOpen?.map((doc) => doc._id)).toEqual(["a", "c"]);

      const highRanks = await store.scan({
        table: "issues",
        index: "by_rank",
        bounds: [{ kind: "range", lower: 1, lowerInclusive: false }],
        order: "desc",
      });
      expect(highRanks?.map((doc) => doc._id)).toEqual(["c", "b"]);

      expect(await store.count({ table: "issues" })).toBe(3);
      expect(
        await store.count({
          table: "issues",
          index: "by_status",
          bounds: [{ kind: "eq", value: "open" }],
        }),
      ).toBe(2);
      expect(await store.scan({ table: "issues", index: "nope", order: "asc" })).toBeNull();
      await expect(
        store.scan({ table: "issues", order: "asc", limit: 40_000 }),
      ).rejects.toBeInstanceOf(Error);
      await store.close();
    });

    test("returns a miss for nullable index bounds that cannot be pushed down exactly", async () => {
      const store = await factory.open(path("null_bounds"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          {
            table: "issues",
            id: "missing",
            data: { title: "Missing", rank: 1 },
            cols: { rank: 1 },
            creationTime: store.nextCreationTime(),
          },
          {
            table: "issues",
            id: "explicit-null",
            data: { title: "Null", status: null, rank: 2 },
            cols: { status: null, rank: 2 },
            creationTime: store.nextCreationTime(),
          },
        ],
        deletes: [],
      });

      const spec = {
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq" as const, value: null }],
      };
      expect(await store.scan({ ...spec, order: "asc" })).toBeNull();
      expect(await store.count(spec)).toBeNull();
      await store.close();
    });

    test("binds boolean index values", async () => {
      const store = await factory.open(path("bool"));
      await store.setup(boolSchema);
      await store.commit({
        upserts: [
          flag("yes", true, store.nextCreationTime()),
          flag("no", false, store.nextCreationTime()),
        ],
        deletes: [],
      });

      const active = await store.scan({
        table: "flags",
        index: "by_active",
        bounds: [{ kind: "eq", value: true }],
        order: "asc",
      });
      expect(active?.map((doc) => doc._id)).toEqual(["yes"]);
      await store.close();
    });
  });
}

function tmp(name: string): string {
  const p = join(tmpdir(), name);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  return p;
}

function issue(
  id: string,
  title: string,
  status: string,
  rank: number,
  creationTime: number,
): UpsertIn {
  return {
    table: "issues",
    id,
    data: { title, status, rank },
    cols: { status, rank },
    creationTime,
  };
}

function flag(id: string, active: ColValue, creationTime: number): UpsertIn {
  return {
    table: "flags",
    id,
    data: { active },
    cols: { active },
    creationTime,
  };
}
