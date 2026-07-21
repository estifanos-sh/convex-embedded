import { expect, test } from "vite-plus/test";

import { createWriter, toSchema } from "../../src/runtime/database";
import { createRunner } from "../../src/runtime/runner";
import type { RuntimeStorageWriter, StoreSchema } from "../../src/storage/types";

const schema: StoreSchema = {
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
