import { expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

declare const __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE__: boolean;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__: number;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_DURATION_MS__: number;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__: string | undefined;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE_ROWS__: number;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_TIMEOUT_MS__: number;

test.skipIf(!__CONVEX_EMBEDDED_BROWSER_BENCH_SCALE__)(
  "benchmarks browser scale fanout",
  async () => {
    const result = await browserCommands().embeddedBrowserScaleBenchmark({
      clients: __CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__,
      durationMs: __CONVEX_EMBEDDED_BROWSER_BENCH_DURATION_MS__,
      out: __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__,
      rows: __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE_ROWS__,
    });

    expect(result.report.clients).toBe(__CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__);
    expect(result.report.rows).toBe(__CONVEX_EMBEDDED_BROWSER_BENCH_SCALE_ROWS__);
    expect(result.report.results.seedMs.samples).toBe(1);
    expect(result.report.results.startupMs.samples).toBe(__CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__);
    expect(result.report.results.fanoutWrites).toBeGreaterThan(0);
    expect(result.report.results.allObserversSawFinal).toBe(true);
    expect(result.report.observerFinalTitles).toEqual(
      Array.from({ length: result.report.clients }, () => result.report.finalTitle),
    );
    expect(result.report.observerUpdates).toHaveLength(__CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__);
    expect(result.outPath).toMatch(/browser-scale|\.json$/);
  },
  __CONVEX_EMBEDDED_BROWSER_BENCH_TIMEOUT_MS__,
);

function browserCommands(): {
  embeddedBrowserScaleBenchmark(options: BrowserScaleBenchOptions): Promise<{
    outPath: string;
    report: BrowserScaleBenchReport;
  }>;
} {
  return commands as unknown as {
    embeddedBrowserScaleBenchmark(options: BrowserScaleBenchOptions): Promise<{
      outPath: string;
      report: BrowserScaleBenchReport;
    }>;
  };
}

interface BrowserScaleBenchOptions {
  clients: number;
  durationMs: number;
  out?: string;
  rows: number;
}

interface BrowserScaleBenchReport {
  clients: number;
  finalTitle: string;
  observerFinalTitles: Array<string | null>;
  observerUpdates: number[];
  results: {
    allObserversSawFinal: boolean;
    fanoutWrites: number;
    seedMs: { samples: number };
    startupMs: { samples: number };
  };
  rows: number;
}
