import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  compareMemory,
  MEMORY_SCENARIOS,
  measureScenario,
  probeHeapKiB,
  readMemoryBaseline,
  type MemorySample,
} from "../bench/harness/memory";

const baselinePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../bench/memory-baseline.json",
);

const baseline = readMemoryBaseline(
  JSON.parse(readFileSync(baselinePath, "utf8")) as unknown,
);

describe("memory standing gate", () => {
  test("baseline covers every scenario with monotonic settled <= peak", () => {
    for (const scenario of MEMORY_SCENARIOS) {
      const sample = baseline.samples.find((entry) => entry.scenario === scenario);
      expect(sample, scenario).toBeDefined();
      expect(sample!.settledKiB).toBeLessThanOrEqual(sample!.peakKiB);
    }
  });

  test("a scenario at the ceiling passes and one over the tolerance fails", () => {
    const atCeiling: MemorySample[] = baseline.samples.map((entry) => ({
      peakKiB: entry.peakKiB,
      scenario: entry.scenario,
      settledKiB: entry.settledKiB,
    }));
    for (const comparison of compareMemory(atCeiling, baseline)) {
      expect(comparison.status, comparison.scenario).toBe("pass");
    }

    const overBudget = atCeiling.map((entry) => ({
      ...entry,
      peakKiB: Math.ceil(entry.peakKiB * (1 + baseline.tolerance) + 1),
    }));
    for (const comparison of compareMemory(overBudget, baseline)) {
      expect(comparison.status, comparison.scenario).toBe("fail");
    }
  });

  test("probe reads linear-memory byteLength and measureScenario captures the high-water", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(probeHeapKiB(memory)).toBe(64);
    const sample = await measureScenario(
      "boot",
      memory,
      async () => {
        memory.grow(3);
      },
      async () => {},
      5,
    );
    expect(sample.peakKiB).toBe(256);
    expect(sample.settledKiB).toBe(256);
  });
});
