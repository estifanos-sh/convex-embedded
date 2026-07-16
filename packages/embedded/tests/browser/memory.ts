/**
 * Release-WASM memory regression gate.
 *
 * Each sample runs in a fresh dedicated worker and opens the packaged `dist/wasm/index.wasm` store.
 * The worker observes the exact shared `WebAssembly.Memory` constructed by the package, then drives
 * boot, 100-row steady state, or a 10k-row remote-shaped volume commit. `buffer.byteLength` is the
 * committed linear-memory high-water. The constructor's `maximum` is reported separately because
 * engines may reserve that virtual range even though it is not JavaScript heap or committed memory.
 * Chromium makes this deterministic in CI; it does not model WebKit's process kill threshold, so a
 * passing gate complements rather than replaces physical iPhone/iPad validation.
 */
import { describe, expect, test } from "vite-plus/test";

import memoryBudget from "../bench/memory.json";
import {
  compareMemory,
  readMemoryBaseline,
  summarizeMemory,
  type MemorySample,
  type MemoryScenario,
} from "../bench/harness/memory";

interface MemoryResult extends MemorySample {
  rows: number;
}

type WorkerMessage<T = MemoryResult> = { error: string; ok: false } | { ok: true; result: T };

const baseline = readMemoryBaseline(memoryBudget);
const RUNS = 3;
const REPEATABILITY_SPREAD_KIB = 16 * 1024;
const BOOT_ROWS = 2_000;
const scenarios: ReadonlyArray<{ expectedRows: number; rows: number; scenario: MemoryScenario }> = [
  { expectedRows: BOOT_ROWS, rows: 0, scenario: "boot" },
  { expectedRows: 100, rows: 100, scenario: "steady100" },
  { expectedRows: 10_000, rows: 10_000, scenario: "pull10k" },
];

describe("release WASM memory", () => {
  test("stays inside mobile high-water and reservation budgets", async () => {
    const samples: MemorySample[] = [];
    for (const { expectedRows, rows, scenario } of scenarios) {
      for (let run = 0; run < RUNS; run += 1) {
        const result = await sampleMemory(scenario, rows, run);
        expect(result.rows, `${scenario} run ${run + 1} row count`).toBe(expectedRows);
        expect(result.settledKiB).toBeLessThanOrEqual(result.peakKiB);
        samples.push(result);
      }
    }

    const summaries = summarizeMemory(samples);
    console.info(
      "release WASM memory samples",
      JSON.stringify({
        distinction:
          "peak/settled are committed WASM linear memory; maximum is its reservation limit; jsHeapUsed is independent optional engine telemetry",
        samples,
        summaries,
      }),
    );

    for (const summary of summaries) {
      expect(summary.runs, summary.scenario).toBe(RUNS);
      expect(summary.spreadKiB, `${summary.scenario} fresh-worker spread`).toBeLessThanOrEqual(
        REPEATABILITY_SPREAD_KIB,
      );
    }

    const worst = summaries.map((summary) => ({
      initialKiB: summary.initialKiB,
      jsHeapUsedKiB: summary.jsHeapUsedKiB,
      maximumKiB: summary.maximumKiB,
      peakKiB: summary.peakKiB,
      scenario: summary.scenario,
      settledKiB: summary.settledKiB,
    }));
    const failures = compareMemory(worst, baseline).filter(
      (comparison) => comparison.status === "fail",
    );
    expect(failures, JSON.stringify({ failures, summaries })).toEqual([]);
  }, 180_000);
});

async function sampleMemory(
  scenario: MemoryScenario,
  rows: number,
  run: number,
): Promise<MemoryResult> {
  const worker = new Worker(new URL("./memoryworker.ts", import.meta.url), { type: "module" });
  const storageId = `memory-${scenario}-${run}-${crypto.randomUUID()}`;
  try {
    if (scenario === "boot") await seedBootStore(storageId);
    return await new Promise<MemoryResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${scenario} release-WASM memory sample timed out`));
      }, 120_000);
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        clearTimeout(timeout);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message || `${scenario} memory worker failed`));
      };
      worker.postMessage({ op: "memory", rows, scenario, storageId });
    });
  } finally {
    worker.terminate();
  }
}

async function seedBootStore(storageId: string): Promise<void> {
  const worker = new Worker(new URL("./memoryworker.ts", import.meta.url), { type: "module" });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("boot memory fixture timed out")), 80_000);
      worker.onmessage = (event: MessageEvent<WorkerMessage<unknown>>) => {
        clearTimeout(timeout);
        if (event.data.ok) resolve();
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message || "boot memory fixture worker failed"));
      };
      worker.postMessage({ op: "seed", rows: BOOT_ROWS, storageId });
    });
  } finally {
    worker.terminate();
  }
}
