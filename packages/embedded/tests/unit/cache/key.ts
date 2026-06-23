import { describe, expect, test } from "vite-plus/test";

import { canonicalJson, hashValue, resultCacheKey } from "../../../src/hash";

describe("retained-result cache key", () => {
  test("is the sha-256 hex of the canonical ResultKey (Cut 7 §1)", async () => {
    const argsKey = canonicalJson({ owner: "a", limit: 10 });
    const key = {
      functionPath: "stats:list",
      argsKey,
      identity: "unauthenticated",
      schemaHash: "schema-1",
      moduleGraphHash: "modules-1",
    };
    const expected = await hashValue({
      functionPath: "stats:list",
      argsKey,
      identity: "unauthenticated",
      schemaHash: "schema-1",
      moduleGraphHash: "modules-1",
    });
    expect(await resultCacheKey(key)).toBe(expected);
    expect(await resultCacheKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("argsKey reuses canonicalJson so watch and cache identity cannot drift", () => {
    const argsKey = canonicalJson({ owner: "a", limit: 10 });
    expect(canonicalJson({ limit: 10, owner: "a" })).toBe(argsKey);
    expect(argsKey).toBe('{"limit":10,"owner":"a"}');
  });

  test("any ResultKey field change cold-keys the cache", async () => {
    const base = {
      functionPath: "stats:list",
      argsKey: canonicalJson({ owner: "a" }),
      identity: "unauthenticated",
      schemaHash: "schema-1",
      moduleGraphHash: "modules-1",
    };
    const baseKey = await resultCacheKey(base);
    expect(await resultCacheKey({ ...base, functionPath: "stats:other" })).not.toBe(baseKey);
    expect(await resultCacheKey({ ...base, argsKey: canonicalJson({ owner: "b" }) })).not.toBe(
      baseKey,
    );
    expect(await resultCacheKey({ ...base, identity: "deadbeef" })).not.toBe(baseKey);
    expect(await resultCacheKey({ ...base, schemaHash: "schema-2" })).not.toBe(baseKey);
    expect(await resultCacheKey({ ...base, moduleGraphHash: "modules-2" })).not.toBe(baseKey);
  });
});
