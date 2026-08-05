import { convexToJson, jsonToConvex, v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { normalizeCopy, reviveDoc } from "../../src/runtime/codec";
import {
  assertNoPendingCommitTs,
  commitTsPlaceholder,
  hasPendingCommitTs,
  resolveKnownPendingCommitTs,
  resolvePendingCommitTs,
} from "../../src/runtime/pending";
import { validateValue } from "../../src/runtime/validate";

describe("pending commit timestamps", () => {
  test("uses Convex's single placeholder, validates it, and resolves only marked values", () => {
    expect(jsonToConvex({ $commitTs: null })).toBe(commitTsPlaceholder);
    validateValue(commitTsPlaceholder, v.commitTs(), "timestamp");

    const normalized = normalizeCopy({ nested: [commitTsPlaceholder] });
    expect(hasPendingCommitTs(normalized)).toBe(true);
    expect(convexToJson(normalized as never)).toEqual({ nested: [{ $commitTs: null }] });

    const timestamp = 123n;
    expect(resolvePendingCommitTs(normalized, timestamp)).toEqual({ nested: [timestamp] });
    expect(resolvePendingCommitTs((1n << 63n) - 1n, timestamp)).toBe((1n << 63n) - 1n);
  });

  test("trusted flagged payload resolution preserves byte containers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const resolved = resolveKnownPendingCommitTs({ bytes, nested: commitTsPlaceholder }, 123n);
    expect(resolved).toEqual({ bytes, nested: 123n });
    expect(resolved.bytes).toBe(bytes);
  });

  test("rejects a marker revived from durable storage", () => {
    const persisted = { stamp: { $commitTs: null } };
    reviveDoc(persisted);
    expect(() => assertNoPendingCommitTs(persisted, "persisted storage document")).toThrow(
      "persisted storage document cannot contain db.vars.commitTs",
    );
  });
});
