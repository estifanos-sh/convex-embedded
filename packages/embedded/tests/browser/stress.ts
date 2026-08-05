import { describe, expect, test } from "vite-plus/test";

interface StressResult {
  coldMs: number;
  initialKiB: number;
  maximumKiB: number;
  peakKiB: number;
  rows: number;
  rowsPerSecond: number;
  settledKiB: number;
  warmMs: number;
}

type WorkerMessage = { error: string; ok: false } | { ok: true; result: StressResult };

describe("release WASM candidate stress", () => {
  test("preserves 1k and 10k rows across cold candidate and warm reopen", async () => {
    const results: StressResult[] = [];
    for (const rows of [1_000, 10_000]) results.push(await measure(rows));
    console.info("release WASM candidate stress", JSON.stringify(results));
    expect(results.map((result) => result.rows)).toEqual([1_000, 10_000]);
    expect(results.every((result) => result.coldMs > 0 && result.warmMs > 0)).toBe(true);
    expect(results.every((result) => result.settledKiB <= result.peakKiB)).toBe(true);
    expect(results.every((result) => result.maximumKiB <= 512 * 1024)).toBe(true);
    expect(results[0]!.peakKiB, "1k candidate committed WASM peak").toBeLessThanOrEqual(104 * 1024);
    expect(results[1]!.peakKiB, "10k candidate committed WASM peak").toBeLessThanOrEqual(
      112 * 1024,
    );
    expect(results[0]!.coldMs, "1k cold candidate").toBeLessThan(5_000);
    expect(results[1]!.coldMs, "10k cold candidate").toBeLessThan(30_000);
    expect(
      results.every((result) => result.warmMs < 2_000),
      "warm reopen budget",
    ).toBe(true);
    expect(
      results[1]!.coldMs / results[1]!.rows,
      "10k per-row migration cost against checked 1k baseline",
    ).toBeLessThanOrEqual((results[0]!.coldMs / results[0]!.rows) * 3);
    expect(results[1]!.warmMs, "10k warm growth against checked 1k baseline").toBeLessThanOrEqual(
      results[0]!.warmMs * 15 + 5,
    );
  }, 180_000);
});

async function measure(rows: number): Promise<StressResult> {
  const worker = new Worker(new URL("./memoryworker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<StressResult>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${rows}-row candidate stress timed out`)),
        150_000,
      );
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        clearTimeout(timeout);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message || `${rows}-row candidate worker failed`));
      };
      worker.postMessage({
        op: "candidate",
        rows,
        storageId: `candidate-${rows}-${crypto.randomUUID()}`,
      });
    });
  } finally {
    worker.terminate();
  }
}
