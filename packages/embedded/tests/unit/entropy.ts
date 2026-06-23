import { describe, expect, test } from "vite-plus/test";

import { withEntropy } from "../../src/entropy";

describe("local-capable entropy guard", () => {
  test("shimmed sync entropy stays reproducible and deterministic", async () => {
    const first = await withEntropy(1_000, "seed", () => ({
      uuid: crypto.randomUUID(),
      byte: crypto.getRandomValues(new Uint8Array(1))[0],
    }));
    const second = await withEntropy(1_000, "seed", () => ({
      uuid: crypto.randomUUID(),
      byte: crypto.getRandomValues(new Uint8Array(1))[0],
    }));
    expect(first).toEqual(second);
  });

  test("crypto.subtle stays available for engine hashing inside a run", async () => {
    const ok = await withEntropy(1_000, "seed", () => typeof crypto.subtle.digest === "function");
    expect(ok).toBe(true);
    expect(typeof globalThis.crypto.subtle.digest).toBe("function");
  });
});
