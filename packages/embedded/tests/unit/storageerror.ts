import { describe, expect, test } from "vite-plus/test";

import { WasmStore } from "../../src/browser/store";
import { isEmbeddedError } from "../../src/error";
import { NativeStore } from "../../src/node/native";
import { StoreAdapter, type StoreBinding } from "../../src/storage/binding";

const prebaseline = new Error(
  "[convex-embedded:EMBEDDED_PRE_BASELINE_STORE] store epoch 0 predates baseline 1",
);

describe("storage open error boundaries", () => {
  test.each([
    ["Node", () => NativeStore.openWith({ open: () => Promise.reject(prebaseline) }, "test")],
    ["browser", () => WasmStore.openWith({ open: () => Promise.reject(prebaseline) }, "test")],
  ])("%s preserves the typed prebaseline classification", async (_name, open) => {
    const error = await open().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(isEmbeddedError(error, "EMBEDDED_PRE_BASELINE_STORE")).toBe(true);
  });

  test("normalizes a prebaseline failure raised by migrationBegin after open", async () => {
    const store = new StoreAdapter({
      migrationBegin: () => Promise.reject(prebaseline),
    } as unknown as StoreBinding);
    const error = await store.candidate
      .prepare({ hash: "f".repeat(64), setupHash: "", tables: [] })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(isEmbeddedError(error, "EMBEDDED_PRE_BASELINE_STORE")).toBe(true);
  });
});
