import { describe, expect, test } from "vite-plus/test";
import { v } from "convex/values";

import { validatorIdReferences } from "../../src/id/path";
import { normalizeMutationResult } from "../../src/result";

describe("mutation result normalization", () => {
  test("discovers only validator-proven ID paths with their tables", () => {
    expect(
      validatorIdReferences(
        v.object({ id: v.id("documents"), title: v.string(), children: v.array(v.id("comments")) }),
        { id: "d1", title: "d1", children: ["c1", "c2"] },
      ),
    ).toEqual([
      { path: "/children/0", table: "comments" },
      { path: "/children/1", table: "comments" },
      { path: "/id", table: "documents" },
    ]);
  });

  test("normalizes inserted IDs and their creation times by ordinal", () => {
    expect(
      normalizeMutationResult(
        {
          _id: "local-id",
          _creationTime: 123,
          child: { id: "local-id" },
          title: "kept",
        },
        "mutation-1",
        [{ ordinal: 0, table: "documents", id: "local-id" }],
        [],
        [],
        [
          { path: "/_id", table: "documents" },
          { path: "/child/id", table: "documents" },
        ],
      ),
    ).toEqual({
      _id: { kind: "insert", mutationId: "mutation-1", ordinal: 0, table: "documents" },
      _creationTime: { kind: "insertCreationTime", mutationId: "mutation-1", ordinal: 0 },
      child: {
        id: { kind: "insert", mutationId: "mutation-1", ordinal: 0, table: "documents" },
      },
      title: "kept",
    });
  });

  test("does not rewrite unrelated strings or existing document creation times", () => {
    const value = { _id: "existing", _creationTime: 123, title: "local-id" };
    expect(
      normalizeMutationResult(
        value,
        "mutation-1",
        [],
        [],
        [],
        [{ path: "/_id", table: "documents" }],
      ),
    ).toEqual({
      _id: { kind: "hosted", table: "documents", id: "existing" },
      _creationTime: {
        kind: "documentCreationTime",
        table: "documents",
        id: "existing",
      },
      title: "local-id",
    });
  });

  test("normalizes mapped document creation times by hosted ID", () => {
    expect(
      normalizeMutationResult(
        { _id: "local-id", _creationTime: 1 },
        "mutation-1",
        [],
        [],
        [],
        [{ path: "/_id", table: "documents" }],
        { "/_id": "hosted-id" },
      ),
    ).toEqual({
      _id: { kind: "hosted", table: "documents", id: "hosted-id" },
      _creationTime: {
        kind: "documentCreationTime",
        table: "documents",
        id: "hosted-id",
      },
    });
  });

  test("normalizes an existing returned document through its argument ID", () => {
    const local = normalizeMutationResult(
      { _id: "documents|local", _creationTime: 1, body: "local", title: "kept" },
      "mutation-1",
      [],
      [],
      [],
      [{ path: "/_id", table: "documents" }],
      {},
      new Map([["documents", new Set(["body"])]]),
      [{ id: "documents|local", path: "/id", table: "documents" }],
    );
    const hosted = normalizeMutationResult(
      { _id: "hosted-id", _creationTime: 2, body: "hosted", title: "kept" },
      "mutation-1",
      [],
      [],
      [],
      [{ path: "/_id", table: "documents" }],
      {},
      new Map([["documents", new Set(["body"])]]),
      [{ id: "hosted-id", path: "/id", table: "documents" }],
    );
    expect(local).toEqual(hosted);
    expect(local).toEqual({
      _id: { kind: "argument", table: "documents", path: "/id" },
      _creationTime: { kind: "argumentCreationTime", table: "documents", path: "/id" },
      body: { kind: "crdt", table: "documents", field: "body" },
      title: "kept",
    });
  });

  test("normalizes mapped IDs nested under generic return values", () => {
    expect(
      normalizeMutationResult(
        { revision: { rowId: "documents|0123456789abcdef0123456789abcdef" } },
        "mutation-1",
        [],
        [],
        [],
        [],
        { "/revision/rowId": "hosted-id" },
      ),
    ).toEqual({ revision: { rowId: "hosted-id" } });
  });

  test("normalizes scheduled function IDs by ordinal", () => {
    expect(
      normalizeMutationResult(
        "local-schedule",
        "mutation-1",
        [],
        ["local-schedule"],
        [],
        [{ path: "", table: "_scheduled_functions" }],
      ),
    ).toEqual({ kind: "schedule", mutationId: "mutation-1", ordinal: 0 });
  });

  test("normalizes generated upload URLs by ordinal", () => {
    expect(
      normalizeMutationResult(
        { url: "embedded://upload/local" },
        "mutation-1",
        [],
        [],
        ["embedded://upload/local"],
        [],
      ),
    ).toEqual({ url: { kind: "upload", mutationId: "mutation-1", ordinal: 0 } });
  });

  test("normalizes declared CRDT materializations inside returned documents", () => {
    expect(
      normalizeMutationResult(
        { _id: "document-id", body: "merged text", title: "kept" },
        "mutation-1",
        [],
        [],
        [],
        [{ path: "/_id", table: "documents" }],
        {},
        new Map([["documents", new Set(["body"])]]),
      ),
    ).toEqual({
      _id: { kind: "hosted", table: "documents", id: "document-id" },
      body: { kind: "crdt", table: "documents", field: "body" },
      title: "kept",
    });
  });
});
