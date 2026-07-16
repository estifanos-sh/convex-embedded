import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  compareMemory,
  MEMORY_SCENARIOS,
  probeHeapKiB,
  readMemoryBaseline,
  summarizeMemory,
  type MemorySample,
} from "../bench/harness/memory";

const baselinePath = resolve(dirname(fileURLToPath(import.meta.url)), "../bench/memory.json");

const baseline = readMemoryBaseline(JSON.parse(readFileSync(baselinePath, "utf8")) as unknown);

describe("memory standing gate", () => {
  test("budget covers every scenario and distinguishes high-water from reservation", () => {
    for (const scenario of MEMORY_SCENARIOS) {
      const budget = baseline.budgets.find((entry) => entry.scenario === scenario);
      expect(budget, scenario).toBeDefined();
      expect(budget!.maximumKiB).toBeGreaterThanOrEqual(budget!.peakKiB);
    }
  });

  test("committed high-water and reservation limits fail independently", () => {
    const atCeiling: MemorySample[] = baseline.budgets.map((entry) => ({
      initialKiB: entry.peakKiB,
      jsHeapUsedKiB: null,
      maximumKiB: entry.maximumKiB,
      peakKiB: entry.peakKiB,
      scenario: entry.scenario,
      settledKiB: entry.peakKiB,
    }));
    for (const comparison of compareMemory(atCeiling, baseline)) {
      expect(comparison.status, comparison.scenario).toBe("pass");
    }

    const overHighWater = atCeiling.map((entry) => ({
      ...entry,
      peakKiB: entry.peakKiB + 1,
    }));
    for (const comparison of compareMemory(overHighWater, baseline)) {
      expect(comparison.status, comparison.scenario).toBe("fail");
    }
    const overReservation = atCeiling.map((entry) => ({
      ...entry,
      maximumKiB: entry.maximumKiB + 1,
    }));
    for (const comparison of compareMemory(overReservation, baseline)) {
      expect(comparison.status, comparison.scenario).toBe("fail");
    }
  });

  test("summary keeps the worst run and exposes repeatability spread", () => {
    const samples: MemorySample[] = [
      ...baseline.budgets.map((entry) => sample(entry.scenario, 80_000)),
      ...baseline.budgets.map((entry) => sample(entry.scenario, 82_000)),
      ...baseline.budgets.map((entry) => sample(entry.scenario, 81_000)),
    ];
    for (const summary of summarizeMemory(samples)) {
      expect(summary.runs).toBe(3);
      expect(summary.peakKiB).toBe(82_000);
      expect(summary.spreadKiB).toBe(2_000);
    }
  });

  test("probe reads committed linear-memory byteLength rather than the reservation limit", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(probeHeapKiB(memory)).toBe(64);
    memory.grow(3);
    expect(probeHeapKiB(memory)).toBe(256);
  });
});

function sample(scenario: MemorySample["scenario"], peakKiB: number): MemorySample {
  return {
    initialKiB: 64_000,
    jsHeapUsedKiB: null,
    maximumKiB: 524_288,
    peakKiB,
    scenario,
    settledKiB: peakKiB,
  };
}
