import { describe, expect, test } from "vite-plus/test";

import { readQuery } from "../../../../demos/browser/vite/src/lib/query";

describe("browser demo query state", () => {
  test("keeps loading, ready-empty, and failure distinct", () => {
    expect(readQuery(() => undefined)).toEqual({ query: "loading" });
    expect(readQuery(() => [])).toEqual({ query: "ready", value: [] });

    const failure = new Error("store failed");
    expect(
      readQuery(() => {
        throw failure;
      }),
    ).toEqual({ query: "failed", error: failure });
  });
});
