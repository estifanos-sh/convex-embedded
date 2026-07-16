/**
 * Standing memory gate. Mirrors the runtime-hot latency baseline (`tests/bench/baseline.json` +
 * `bench:compare`) but records the wasm heap high-water per scenario instead of throughput.
 *
 * The measured quantity is `WebAssembly.Memory.buffer.byteLength`: turso's page-cache arena is
 * `std::alloc::alloc_zeroed` on wasm (an `mmap` arena only on native), and the Rust + loro heap sit
 * in the same linear memory, so `byteLength` is the whole embedded runtime footprint the browser must
 * back — and the number iOS kills a tab over. Linear memory only ever grows, so this is a true
 * high-water mark; `peakKiB` samples it during the scenario and `settledKiB` reads it once the
 * scenario's async work quiesces. A future `allocatedBytes` export could separate live from reserved.
 *
 * Integration: the browser memory test runs the packaged artifact in a fresh worker, intercepts the
 * exact shared memory passed to it, and drives boot, 100-row, and 10k-row scenarios. This module owns
 * the sample/budget shapes, summary, and threshold comparison used by that real browser gate.
 */

export type MemoryScenario = "boot" | "steady100" | "pull10k";

export const MEMORY_SCENARIOS: readonly MemoryScenario[] = ["boot", "steady100", "pull10k"];

export interface MemorySample {
  initialKiB: number;
  jsHeapUsedKiB: number | null;
  maximumKiB: number;
  peakKiB: number;
  scenario: MemoryScenario;
  settledKiB: number;
}

export interface MemoryBudget {
  capturedPeakKiB: number;
  capturedRuns: number;
  capturedSpreadKiB: number;
  maximumKiB: number;
  peakKiB: number;
  scenario: MemoryScenario;
}

export interface MemoryBaseline {
  capturedAt: string;
  notes: string[];
  budgets: MemoryBudget[];
  source: string;
  version: 2;
}

export interface MemoryComparison {
  budgetPeakKiB: number;
  currentPeakKiB: number;
  currentMaximumKiB: number;
  maximumBudgetKiB: number;
  scenario: MemoryScenario;
  status: "fail" | "pass";
}

export interface MemorySummary {
  initialKiB: number;
  jsHeapUsedKiB: number | null;
  maximumKiB: number;
  peakKiB: number;
  runs: number;
  scenario: MemoryScenario;
  settledKiB: number;
  spreadKiB: number;
}

/** Wasm linear-memory size in KiB. */
export function probeHeapKiB(memory: WebAssembly.Memory): number {
  return memory.buffer.byteLength / 1024;
}

/** A scenario passes only when both committed high-water and reservation limit stay in budget. */
export function compareMemory(
  samples: readonly MemorySample[],
  baseline: MemoryBaseline,
): MemoryComparison[] {
  return samples.map((sample) => {
    const target = baseline.budgets.find((entry) => entry.scenario === sample.scenario);
    if (!target) {
      throw new Error(`memory budget has no scenario ${sample.scenario}`);
    }
    return {
      budgetPeakKiB: target.peakKiB,
      currentPeakKiB: sample.peakKiB,
      currentMaximumKiB: sample.maximumKiB,
      maximumBudgetKiB: target.maximumKiB,
      scenario: sample.scenario,
      status:
        sample.peakKiB <= target.peakKiB && sample.maximumKiB <= target.maximumKiB
          ? "pass"
          : "fail",
    };
  });
}

/** Reduces repeated fresh-worker measurements without hiding the worst run. */
export function summarizeMemory(samples: readonly MemorySample[]): MemorySummary[] {
  return MEMORY_SCENARIOS.map((scenario) => {
    const runs = samples.filter((sample) => sample.scenario === scenario);
    if (runs.length === 0) throw new Error(`memory samples have no scenario ${scenario}`);
    const peaks = runs.map((sample) => sample.peakKiB);
    const jsHeap = runs
      .map((sample) => sample.jsHeapUsedKiB)
      .filter((value): value is number => value !== null);
    return {
      initialKiB: Math.max(...runs.map((sample) => sample.initialKiB)),
      jsHeapUsedKiB: jsHeap.length === 0 ? null : Math.max(...jsHeap),
      maximumKiB: Math.max(...runs.map((sample) => sample.maximumKiB)),
      peakKiB: Math.max(...peaks),
      runs: runs.length,
      scenario,
      settledKiB: Math.max(...runs.map((sample) => sample.settledKiB)),
      spreadKiB: Math.max(...peaks) - Math.min(...peaks),
    };
  });
}

export function readMemoryBaseline(value: unknown): MemoryBaseline {
  const baseline = value as MemoryBaseline;
  if (baseline.version !== 2 || !Array.isArray(baseline.budgets)) {
    throw new Error("memory budget is malformed");
  }
  for (const scenario of MEMORY_SCENARIOS) {
    const budget = baseline.budgets.find((entry) => entry.scenario === scenario);
    if (
      budget === undefined ||
      !Number.isFinite(budget.peakKiB) ||
      !Number.isFinite(budget.maximumKiB) ||
      !Number.isFinite(budget.capturedPeakKiB) ||
      !Number.isInteger(budget.capturedRuns) ||
      !Number.isFinite(budget.capturedSpreadKiB) ||
      budget.peakKiB <= 0 ||
      budget.maximumKiB < budget.peakKiB ||
      budget.capturedPeakKiB > budget.peakKiB ||
      budget.capturedRuns < 2 ||
      budget.capturedSpreadKiB < 0
    ) {
      throw new Error(`memory budget is malformed for ${scenario}`);
    }
  }
  return baseline;
}
