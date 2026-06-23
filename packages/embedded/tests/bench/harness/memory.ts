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
 * Integration: the browser bench (post wasm rebuild) passes the worker's `WebAssembly.Memory` and a
 * scenario body — boot an existing store, sync N=100 docs, bootstrap a 10k-row pull — plus a settle
 * that drains the tick loop and checkpoints. This module owns only the probe, the sample/baseline
 * shapes, and the threshold compare so all three are typechecked and unit-tested without wasm.
 */

export type MemoryScenario = "boot" | "steady100" | "pull10k";

export const MEMORY_SCENARIOS: readonly MemoryScenario[] = ["boot", "steady100", "pull10k"];

export interface MemorySample {
  peakKiB: number;
  scenario: MemoryScenario;
  settledKiB: number;
}

export interface MemoryBaseline {
  capturedAt: string;
  notes: string[];
  samples: MemorySample[];
  source: string;
  tolerance: number;
  version: 1;
}

export interface MemoryComparison {
  baselinePeakKiB: number;
  currentPeakKiB: number;
  ratio: number;
  scenario: MemoryScenario;
  status: "fail" | "pass";
}

/** Wasm linear-memory size in KiB. */
export function probeHeapKiB(memory: WebAssembly.Memory): number {
  return memory.buffer.byteLength / 1024;
}

/**
 * Peak (sampled every `intervalMs` during `run`) and settled heap for one scenario. Linear memory is
 * monotonic, so the peak is the high-water reached during the scenario and settled is the reading
 * after the caller's async work quiesces.
 */
export async function measureScenario(
  scenario: MemoryScenario,
  memory: WebAssembly.Memory,
  run: () => Promise<void>,
  settle: () => Promise<void>,
  intervalMs = 25,
): Promise<MemorySample> {
  let peakKiB = probeHeapKiB(memory);
  const sampler = setInterval(() => {
    peakKiB = Math.max(peakKiB, probeHeapKiB(memory));
  }, intervalMs);
  try {
    await run();
    peakKiB = Math.max(peakKiB, probeHeapKiB(memory));
  } finally {
    clearInterval(sampler);
  }
  await settle();
  const settledKiB = probeHeapKiB(memory);
  return { peakKiB: Math.max(peakKiB, settledKiB), scenario, settledKiB };
}

/** A scenario passes when its peak heap stays within `tolerance` of the baseline peak. */
export function compareMemory(
  samples: readonly MemorySample[],
  baseline: MemoryBaseline,
): MemoryComparison[] {
  return samples.map((sample) => {
    const target = baseline.samples.find((entry) => entry.scenario === sample.scenario);
    if (!target) {
      throw new Error(`memory baseline has no scenario ${sample.scenario}`);
    }
    const ratio = sample.peakKiB / target.peakKiB;
    return {
      baselinePeakKiB: target.peakKiB,
      currentPeakKiB: sample.peakKiB,
      ratio,
      scenario: sample.scenario,
      status: ratio <= 1 + baseline.tolerance ? "pass" : "fail",
    };
  });
}

export function readMemoryBaseline(value: unknown): MemoryBaseline {
  const baseline = value as MemoryBaseline;
  if (baseline.version !== 1 || !Array.isArray(baseline.samples)) {
    throw new Error("memory baseline is malformed");
  }
  return baseline;
}
