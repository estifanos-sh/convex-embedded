import { describe, expect, test } from "vite-plus/test";

import { normalizeCopy } from "../../src/runtime/codec";

describe("convex value limits", () => {
  test("rejects reserved and empty field names", () => {
    expect(() => normalizeCopy({ $x: 1 })).toThrow(/'\$'/);
    expect(() => normalizeCopy({ "": 1 })).toThrow(/nonempty/);
  });

  test("rejects arrays longer than 8192 values", () => {
    expect(() => normalizeCopy({ a: Array.from({ length: 8193 }, () => 0) })).toThrow(/8192/);
    expect(() => normalizeCopy({ a: Array.from({ length: 8192 }, () => 0) })).not.toThrow();
  });

  test("rejects objects with more than 1024 fields", () => {
    const wide = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, i]));
    expect(() => normalizeCopy(wide)).toThrow(/1024/);
  });

  test("rejects values nested deeper than 16 levels", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 18; i += 1) deep = { n: deep };
    expect(() => normalizeCopy(deep)).toThrow(/nests deeper/);
  });

  test("rejects strings with unpaired surrogates", () => {
    expect(() => normalizeCopy({ s: "\uD800" })).toThrow(/Unicode/);
    expect(() => normalizeCopy({ s: "ok" })).not.toThrow();
  });
});
