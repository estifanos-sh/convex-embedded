import { expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;
declare const __CONVEX_EMBEDDED_METAL_BENCH_SCALE__: boolean;
declare const __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__: number;
declare const __CONVEX_EMBEDDED_METAL_BENCH_WRITES__: number;
declare const __CONVEX_EMBEDDED_METAL_BENCH_OUT__: string | undefined;
declare const __CONVEX_EMBEDDED_METAL_BENCH_REVS__: number;
declare const __CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__: boolean;
declare const __CONVEX_EMBEDDED_METAL_BENCH_TIMEOUT_MS__: number;

test.skipIf(!__CONVEX_EMBEDDED_METAL_BENCH_SCALE__)(
  "benchmarks metal remote scale sync",
  async () => {
    const result = await metalCommands().embeddedMetalScaleBenchmark({
      clients: __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__,
      out: __CONVEX_EMBEDDED_METAL_BENCH_OUT__,
      remoteUrl: hostedRemoteUrl(),
      revs: __CONVEX_EMBEDDED_METAL_BENCH_REVS__,
      skipRevList: __CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__,
      timeoutMs: __CONVEX_EMBEDDED_METAL_BENCH_TIMEOUT_MS__,
      writes: __CONVEX_EMBEDDED_METAL_BENCH_WRITES__,
    });

    expect(result.report.clients).toBe(__CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__);
    expect(result.report.revs).toBe(__CONVEX_EMBEDDED_METAL_BENCH_REVS__);
    expect(result.report.results.revCreateMs.samples).toBe(__CONVEX_EMBEDDED_METAL_BENCH_REVS__);
    expect(result.report.results.revCycleMs.samples).toBe(__CONVEX_EMBEDDED_METAL_BENCH_REVS__);
    expect(result.report.results.revWriteMs.samples).toBe(__CONVEX_EMBEDDED_METAL_BENCH_REVS__);
    if (__CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__) {
      expect(result.report.results.revCount).toBeNull();
      expect(result.report.results.revListSkipped).toBe(true);
    } else {
      expect(result.report.results.revCount).toBeGreaterThanOrEqual(
        __CONVEX_EMBEDDED_METAL_BENCH_REVS__,
      );
      expect(result.report.results.revListSkipped).toBe(false);
    }
    expect(result.report.observerRevCounts).toHaveLength(__CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__);
    if (__CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__) {
      expect(result.report.observerRevCounts).toEqual(
        Array.from({ length: __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__ }, () => null),
      );
    } else {
      expect(result.report.observerRevCounts[0]).toBeGreaterThanOrEqual(
        __CONVEX_EMBEDDED_METAL_BENCH_REVS__,
      );
      expect(result.report.observerRevCounts.slice(1)).toEqual(
        Array.from({ length: __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__ - 1 }, () => 0),
      );
    }
    expect(result.report.results.fanoutWrites).toBeGreaterThan(0);
    expect(result.report.results.fanoutWrites).toBe(__CONVEX_EMBEDDED_METAL_BENCH_WRITES__);
    expect(result.report.results.allObserversSawFinal).toBe(true);
    expect(result.report.observerFinalTitles).toEqual(
      Array.from({ length: result.report.clients }, () => result.report.finalTitle),
    );
    expect(result.report.observerStorageIds).toHaveLength(__CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__);
    expect(result.report.remoteTicks.pushAccepted).toBeGreaterThan(0);
    expect(result.report.remoteTicks.settlementsAcknowledged).toBe(
      result.report.remoteTicks.pushAccepted,
    );
    expect(result.report.remoteTicks.rowsApplied).toBeGreaterThan(0);
    expect(result.report.remoteTicks.received).toBeGreaterThan(0);
    expect(Number.isFinite(result.report.results.revCreateMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.revCycleMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.revWriteMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.remotePullMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.remotePushMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.settlementMs.p99)).toBe(true);
    expect(Number.isFinite(result.report.results.streamConvergenceMs.p99)).toBe(true);
    expect(result.outPath).toMatch(/metal-scale|\.json$/);
  },
  300_000,
);

function hostedRemoteUrl(): string {
  const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!url) {
    throw new Error("Set VITE_CONVEX_URL or CONVEX_URL in .env.local before running metal tests.");
  }
  return url;
}

function metalCommands(): {
  embeddedMetalScaleBenchmark(options: MetalScaleBenchOptions): Promise<{
    outPath: string;
    report: MetalScaleBenchReport;
  }>;
} {
  return commands as unknown as {
    embeddedMetalScaleBenchmark(options: MetalScaleBenchOptions): Promise<{
      outPath: string;
      report: MetalScaleBenchReport;
    }>;
  };
}

interface MetalScaleBenchOptions {
  clients: number;
  out?: string;
  remoteUrl: string;
  revs: number;
  skipRevList?: boolean;
  timeoutMs?: number;
  writes: number;
}

interface MetalScaleBenchReport {
  clients: number;
  finalTitle: string;
  observerFinalTitles: Array<string | null>;
  observerRevCounts: Array<number | null>;
  observerStorageIds: string[];
  remoteTicks: {
    pullAttempted: number;
    pushAccepted: number;
    pushAttempted: number;
    pushConflicts: number;
    pushRebases: number;
    pushFailed: number;
    received: number;
    retainedRevisions: number;
    rowsApplied: number;
    sent: number;
    settlementsAcknowledged: number;
    storeJobs: number;
  };
  results: {
    allObserversSawFinal: boolean;
    fanoutWrites: number;
    remotePullMs: MetalScaleBenchSample;
    remotePushMs: MetalScaleBenchSample;
    settlementMs: MetalScaleBenchSample;
    revCount: number | null;
    revCreateMs: MetalScaleBenchSample;
    revCycleMs: MetalScaleBenchSample;
    revListSkipped: boolean;
    revWriteMs: MetalScaleBenchSample;
    streamConvergenceMs: MetalScaleBenchSample;
  };
  revs: number;
  writes: number;
}

interface MetalScaleBenchSample {
  p95: number;
  p99: number;
  samples: number;
}
