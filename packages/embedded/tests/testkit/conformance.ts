import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type {
  ColValue,
  ReadSpec,
  StorageBackend,
  StoreSchema,
  UpsertIn,
} from "../../src/storage/types";

const schema: StoreSchema = {
  tables: [
    {
      name: "issues",
      columns: [{ name: "status" }, { name: "rank" }],
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
      columns: [{ name: "active" }],
      indexes: [{ name: "by_active", fields: ["active"] }],
    },
  ],
};

export interface ConformanceFactory {
  name: string;
  open(path: string, identityKey?: string): Promise<StorageBackend>;
}

export function defineConformance(factory: ConformanceFactory): void {
  const path = (name: string) => tmp(`${factory.name}_${name}.db`);

  describe(`${factory.name} storage conformance`, () => {
    test(
      "round-trips, deletes, reopens, and recovers creation time",
      { timeout: 30_000 },
      async () => {
        const db = path("roundtrip");
        let firstCreationTime = 0;
        {
          const store = await factory.open(db);
          await store.setup(schema);
          const first = issue("i1", "hello", "open", 1, store.clock.read());
          firstCreationTime = first.creationTime;
          await store.commit({ upserts: [first], deletes: [] });

          const got = await store.doc.read("issues", "i1");
          expect(got?._id).toBe("i1");
          expect(got?._creationTime).toBe(firstCreationTime);
          expect(got?.title).toBe("hello");
          expect(await store.doc.read("issues", "missing")).toBeUndefined();
          await store.close();
        }

        const store = await factory.open(db);
        await store.setup(schema);
        expect((await store.doc.read("issues", "i1"))?._id).toBe("i1");
        const second = issue("i2", "world", "open", 2, store.clock.read());
        expect(second.creationTime).toBeGreaterThan(firstCreationTime);
        await store.commit({ upserts: [second], deletes: [] });
        await store.commit({ upserts: [], deletes: [{ table: "issues", id: "i1" }] });

        expect(await store.doc.read("issues", "i1")).toBeUndefined();
        const page = await store.doc.page.read({ table: "issues", order: "asc" });
        expect(page.docs.map((doc) => doc._id)).toEqual(["i2"]);
        expect(page.cursor).toBeNull();
        await store.close();
      },
    );

    test("isolates identity keys", async () => {
      const db = path("identity");
      const a = await factory.open(db, "a");
      const b = await factory.open(db, "b");
      await a.setup(schema);
      await b.setup(schema);

      await a.commit({
        upserts: [issue("same", "A", "open", 1, a.clock.read())],
        deletes: [],
      });
      await b.commit({
        upserts: [issue("same", "B", "closed", 2, b.clock.read())],
        deletes: [],
      });

      expect((await a.doc.read("issues", "same"))?.title).toBe("A");
      expect((await b.doc.read("issues", "same"))?.title).toBe("B");
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
              columns: [{ name: "data" }],
              indexes: [],
            },
          ],
        }),
      ).rejects.toThrow("reserved column name: data");
      await store.close();
    });

    test("stores index values of any type (order keys carry no affinity)", async () => {
      const store = await factory.open(path("mixed_types"));
      await store.setup(boolSchema);
      await store.commit({
        upserts: [
          flag("yes", true, store.clock.read()),
          flag("mixed", "not-a-boolean" as never, store.clock.read()),
        ],
        deletes: [],
      });
      expect(await store.doc.read("flags", "yes")).toBeDefined();
      expect(await store.doc.read("flags", "mixed")).toBeDefined();
      await store.close();
    });

    test("scans and counts with ordering, range bounds, and caller-bug specs", async () => {
      const store = await factory.open(path("scan"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          issue("a", "A", "open", 1, store.clock.read()),
          issue("b", "B", "closed", 2, store.clock.read()),
          issue("c", "C", "open", 3, store.clock.read()),
        ],
        deletes: [],
      });

      const onlyOpen = await store.doc.page.read({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
        order: "asc",
      });
      expect(onlyOpen.docs.map((doc) => doc._id)).toEqual(["a", "c"]);

      const highRanks = await store.doc.page.read({
        table: "issues",
        index: "by_rank",
        bounds: [{ kind: "range", lower: 1, lowerInclusive: false }],
        order: "desc",
      });
      expect(highRanks.docs.map((doc) => doc._id)).toEqual(["c", "b"]);

      expect(await store.doc.count.read({ table: "issues" })).toBe(3);
      expect(
        await store.doc.count.read({
          table: "issues",
          index: "by_status",
          bounds: [{ kind: "eq", value: "open" }],
        }),
      ).toBe(2);
      await expect(
        store.doc.page.read({ table: "issues", index: "nope", order: "asc" }),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        store.doc.page.read({ table: "issues", order: "asc", pageSize: 40_000 }),
      ).rejects.toBeInstanceOf(Error);
      await store.close();
    });

    test("pages through keyset cursors in both orders", async () => {
      const store = await factory.open(path("paging"));
      await store.setup(schema);
      const upserts: UpsertIn[] = [];
      for (let i = 0; i < 7; i += 1) {
        upserts.push(
          issue(`i${i}`, `Issue ${i}`, i % 2 === 0 ? "open" : "closed", i, store.clock.read()),
        );
      }
      await store.commit({ upserts, deletes: [] });

      for (const order of ["asc", "desc"] as const) {
        const spec: ReadSpec = { table: "issues", order };
        const full = (await store.doc.page.read(spec)).docs.map((doc) => doc._id);
        expect(full).toHaveLength(7);
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await store.doc.page.read({ ...spec, pageSize: 3, cursor });
          paged.push(...page.docs.map((doc) => doc._id));
          cursor = page.cursor ?? undefined;
        } while (cursor !== undefined);
        expect(paged).toEqual(full);
      }
      await store.close();
    });

    test("pages a multi-page run of equal index values in descending order", async () => {
      const store = await factory.open(path("null_run_paging"));
      await store.setup(schema);
      const upserts: UpsertIn[] = [];
      for (let i = 0; i < 7; i += 1) {
        upserts.push({
          table: "issues",
          id: `n${i}`,
          data: { title: `t${i}`, rank: i },
          cols: { rank: i },
          creationTime: store.clock.read(),
        });
      }
      await store.commit({ upserts, deletes: [] });

      const spec: ReadSpec = { table: "issues", index: "by_status", order: "desc" };
      const full = (await store.doc.page.read(spec)).docs.map((doc) => doc._id);
      expect(full).toHaveLength(7);
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.doc.page.read({ ...spec, pageSize: 2, cursor });
        paged.push(...page.docs.map((doc) => doc._id));
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      expect(paged).toEqual(full);
      await store.close();
    });

    test("scans keys without decoding documents", async () => {
      const store = await factory.open(path("keys"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          issue("a", "A", "open", 1, store.clock.read()),
          issue("b", "B", "open", 2, store.clock.read()),
        ],
        deletes: [],
      });
      const page = await store.key.page.read({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: "open" }],
        order: "asc",
      });
      expect(page.ids).toEqual(["a", "b"]);
      expect(page.creationTimes[0]).toBeGreaterThan(0);
      expect(page.cursor).toBeNull();
      await store.close();
    });

    test("matches null and undefined index values exactly, with exact counts", async () => {
      const store = await factory.open(path("null_bounds"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          {
            table: "issues",
            id: "missing",
            data: { title: "Missing", rank: 1 },
            cols: { rank: 1 },
            creationTime: store.clock.read(),
          },
          {
            table: "issues",
            id: "explicit-null",
            data: { title: "Null", status: null, rank: 2 },
            cols: { status: null, rank: 2 },
            creationTime: store.clock.read(),
          },
        ],
        deletes: [],
      });

      const byNull = await store.doc.page.read({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: null }],
        order: "asc",
      });
      expect(byNull.docs.map((doc) => doc._id)).toEqual(["explicit-null"]);
      const byUndefined = await store.doc.page.read({
        table: "issues",
        index: "by_status",
        bounds: [{ kind: "eq", value: undefined }],
        order: "asc",
      });
      expect(byUndefined.docs.map((doc) => doc._id)).toEqual(["missing"]);
      expect(
        await store.doc.count.read({
          table: "issues",
          index: "by_status",
          bounds: [{ kind: "eq", value: null }],
        }),
      ).toBe(1);
      await store.close();
    });

    test("ledger prune preserves local commit sequence and keeps blobs binary", async () => {
      const store = await factory.open(path("prune_blobs"));
      await store.setup(schema);
      for (let i = 0; i < 3; i += 1) {
        await store.commit({
          upserts: [issue(`i${i}`, "t", "open", i, store.clock.read())],
          deletes: [],
        });
      }
      const pruned = await store.ledger.delete(Number.MAX_SAFE_INTEGER);
      expect(pruned.commitsDeleted).toBe(0);
      const next = await store.commit({
        upserts: [issue("i3", "t", "open", 3, store.clock.read())],
        deletes: [],
      });
      expect(next.commitSeq).toBe(4);

      expect(await store.blob.read("missing")).toBeNull();
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await store.blob.write("frame", bytes);
      expect(Array.from((await store.blob.read("frame")) ?? [])).toEqual([0, 1, 2, 250, 255]);
      await store.blob.delete("frame");
      expect(await store.blob.read("frame")).toBeNull();
      await store.close();
    });

    test("binds boolean index values", async () => {
      const store = await factory.open(path("bool"));
      await store.setup(boolSchema);
      await store.commit({
        upserts: [flag("yes", true, store.clock.read()), flag("no", false, store.clock.read())],
        deletes: [],
      });

      const active = await store.doc.page.read({
        table: "flags",
        index: "by_active",
        bounds: [{ kind: "eq", value: true }],
        order: "asc",
      });
      expect(active.docs.map((doc) => doc._id)).toEqual(["yes"]);
      await store.close();
    });

    test("binds bigint index values", async () => {
      const store = await factory.open(path("bigint"));
      await store.setup(schema);
      await store.commit({
        upserts: [
          {
            table: "issues",
            id: "i64",
            data: { title: "big", status: "open", rank: 9_007_199_254_740_993n },
            cols: { status: "open", rank: 9_007_199_254_740_993n },
            creationTime: store.clock.read(),
          },
        ],
        deletes: [],
      });

      const page = await store.doc.page.read({
        table: "issues",
        index: "by_rank",
        bounds: [{ kind: "eq", value: 9_007_199_254_740_993n }],
        order: "asc",
      });
      expect(page.docs.map((doc) => doc._id)).toEqual(["i64"]);
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
