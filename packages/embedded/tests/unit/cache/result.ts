import { convexToJson, v } from "convex/values";
import type { Value } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type { ResultEntry, RuntimeStorageReader, StoredDoc } from "../../../src/storage/types";
import {
  decodePaths,
  decodeSkeleton,
  reconstruct,
  splicePointer,
} from "../../../src/runtime/cache";

function skeletonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(convexToJson(value as Value)));
}

function pathsBytes(rows: Array<{ path: string; table: string; rowId: string }>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}

function entry(
  skeleton: unknown,
  rows: Array<{ path: string; table: string; rowId: string }> = [],
): ResultEntry {
  return {
    key: "k",
    function: "f",
    args: "{}",
    schemaHash: "local",
    moduleHash: "local",
    skeleton: skeletonBytes(skeleton),
    paths: pathsBytes(rows),
    skeletonHash: "h",
    clock: 1,
  };
}

describe("retained-result skeleton codec", () => {
  test("decodes an Int64/Bytes transformed result through the value codec (S3 round-trip)", () => {
    // v.int64 encodes as {$integer}, v.bytes as {$bytes}; both must survive the skeleton codec.
    const value = {
      count: 9_007_199_254_740_993n,
      digest: new Uint8Array([1, 2, 3, 255]).buffer,
      label: "server",
      ratio: 1.5,
    };
    const _validated = v.object({
      count: v.int64(),
      digest: v.bytes(),
      label: v.string(),
      ratio: v.number(),
    });
    void _validated;
    const decoded = decodeSkeleton(skeletonBytes(value)) as {
      count: bigint;
      digest: ArrayBuffer;
      label: string;
      ratio: number;
    };
    expect(decoded.count).toBe(9_007_199_254_740_993n);
    expect(new Uint8Array(decoded.digest)).toEqual(new Uint8Array([1, 2, 3, 255]));
    expect(decoded.label).toBe("server");
    expect(decoded.ratio).toBe(1.5);
  });

  test("decodePaths recovers the resultRows array", () => {
    const rows = [{ path: "/latest", table: "documents", rowId: "j57" }];
    expect(decodePaths(pathsBytes(rows))).toEqual(rows);
    expect(decodePaths(pathsBytes([]))).toEqual([]);
  });

  test("splicePointer follows RFC-6901 escapes and array indices", () => {
    expect(splicePointer({ latest: null }, "/latest", { title: "x" })).toEqual({
      latest: { title: "x" },
    });
    expect(splicePointer([null, null], "/1", "z")).toEqual([null, "z"]);
    expect(splicePointer({ "a/b": { "c~d": null } }, "/a~1b/c~0d", 5)).toEqual({
      "a/b": { "c~d": 5 },
    });
    expect(splicePointer({ any: 1 }, "", "whole")).toBe("whole");
  });
});

function reader(
  present: Map<string, StoredDoc>,
  bases: Map<string, StoredDoc>,
  mappings: Array<{ localId: string; convexId: string }>,
): RuntimeStorageReader {
  return {
    doc: {
      read: (_table: string, id: string) => Promise.resolve(present.get(id)),
      version: { read: () => Promise.resolve(1) },
      crdt: {
        read: () => Promise.resolve(undefined),
        snapshot: { read: () => Promise.resolve([]) },
      },
      page: { read: () => Promise.resolve({ cursor: null, docs: [] }) },
      count: { read: () => Promise.resolve(null) },
      base: { read: (_table: string, id: string) => Promise.resolve(bases.get(id)) },
    },
    key: { page: { read: () => Promise.resolve({ cursor: null, ids: [], creationTimes: [] }) } },
    id: {
      write: () => Promise.resolve(),
      read: () => Promise.resolve(undefined),
      page: {
        read: () =>
          Promise.resolve(
            mappings.map((m) => ({
              table: "messages",
              localId: m.localId,
              mapping: "mapped" as const,
              convexId: m.convexId,
              createdTime: 1,
              updatedTime: 1,
            })),
          ),
      },
      delete: () => Promise.resolve(),
    },
  } as unknown as RuntimeStorageReader;
}

describe("retained-result reconstruction", () => {
  test("splices the current local projection of a present referenced row", async () => {
    const doc = { _id: "messages|1", _creationTime: 1, title: "current" } as StoredDoc;
    const store = reader(new Map([[doc._id, doc]]), new Map(), [
      { localId: doc._id, convexId: "hosted1" },
    ]);
    const value = (await reconstruct(
      entry({ latest: null, total: 5 }, [{ path: "/latest", table: "messages", rowId: "hosted1" }]),
      store,
    )) as { latest: StoredDoc; total: number };
    expect(value.latest.title).toBe("current");
    expect(value.total).toBe(5);
  });

  test("splices the retained base of a dirty-deleted referenced row", async () => {
    const base = { _id: "messages|2", _creationTime: 1, title: "base" } as StoredDoc;
    const store = reader(new Map(), new Map([[base._id, base]]), [
      { localId: base._id, convexId: "hosted2" },
    ]);
    const value = (await reconstruct(
      entry({ latest: null }, [{ path: "/latest", table: "messages", rowId: "hosted2" }]),
      store,
    )) as { latest: StoredDoc };
    expect(value.latest.title).toBe("base");
  });

  test("an absent, non-dirty-deleted referenced row is a storage-invariant fault", async () => {
    const store = reader(new Map(), new Map(), [{ localId: "messages|3", convexId: "hosted3" }]);
    await expect(
      reconstruct(
        entry({ latest: null }, [{ path: "/latest", table: "messages", rowId: "hosted3" }]),
        store,
      ),
    ).rejects.toThrow(/storage invariant/);
  });

  test("an entry with no resultRows returns its skeleton verbatim", async () => {
    const store = reader(new Map(), new Map(), []);
    expect(await reconstruct(entry({ total: 42, label: "server" }), store)).toEqual({
      total: 42,
      label: "server",
    });
  });
});
