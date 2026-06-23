import { expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;
declare const __CONVEX_EMBEDDED_METAL_BENCH_RECONNECT_VOLUME__: boolean;
declare const __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__: number;
declare const __CONVEX_EMBEDDED_METAL_BENCH_DEPLOYMENT__: string | null;
declare const __CONVEX_EMBEDDED_METAL_BENCH_OUT__: string | undefined;
declare const __CONVEX_EMBEDDED_METAL_BENCH_REVS__: number;
declare const __CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__: boolean;
declare const __CONVEX_EMBEDDED_METAL_BENCH_TIMEOUT_MS__: number;

test.skipIf(!__CONVEX_EMBEDDED_METAL_BENCH_RECONNECT_VOLUME__)(
  "benchmarks metal reconnect with remote volume",
  async () => {
    const result = await metalCommands().embeddedMetalReconnectVolumeBenchmark({
      clients: __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__,
      deployment: hostedDeployment(),
      out: __CONVEX_EMBEDDED_METAL_BENCH_OUT__,
      remoteUrl: hostedRemoteUrl(),
      revs: __CONVEX_EMBEDDED_METAL_BENCH_REVS__,
      skipRevList: __CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__,
      timeoutMs: __CONVEX_EMBEDDED_METAL_BENCH_TIMEOUT_MS__,
    });

    const expectedClients = Math.max(2, __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__);
    expect(result.report.clients).toBe(expectedClients);
    expect(result.report.clientFinalTitles).toHaveLength(expectedClients);
    expect(result.report.clientStorageIds).toHaveLength(expectedClients);
    expect(result.report.revs).toBe(__CONVEX_EMBEDDED_METAL_BENCH_REVS__);
    expect(result.report.results.finalConvergenceCorrect).toBe(true);
    expect(
      result.report.clientFinalTitles.every((title) => title === result.report.foregroundTitle),
    ).toBe(true);
    expect(result.report.writerFinalTitle).toBe(result.report.foregroundTitle);
    expect(result.report.observerFinalTitle).toBe(result.report.foregroundTitle);
    expect(result.report.results.firstLocalQueryMs.samples).toBe(1);
    expect(Number.isFinite(result.report.results.firstLocalQueryMs.p99)).toBe(true);
    expect(result.report.results.reconnectStartToFirstRemoteEventMs.samples).toBe(1);
    expect(Number.isFinite(result.report.results.reconnectStartToFirstRemoteEventMs.p99)).toBe(
      true,
    );
    expect(result.report.results.reconnectStartToConvergenceMs.samples).toBe(1);
    expect(Number.isFinite(result.report.results.streamConvergenceMs.p99)).toBe(true);
    expect(result.report.results.foregroundDocWriteMs.samples).toBe(1);
    expect(result.report.results.foregroundRevCreateMs.samples).toBe(1);
    expect(result.report.results.hostedRevFirstReadMs.samples).toBe(1);
    expect(result.report.results.hostedRevReadMs.samples).toBe(5);
    expect(result.report.results.hostedSeedVisible).toBe(true);
    expect(result.report.results.seedMs.samples).toBe(1);
    expect(result.report.results.offlineWriteMs.samples).toBe(1);
    expect(result.report.results.offlineRevCreateMs.samples).toBe(1);
    expect(result.report.results.remotePullMs.samples).toBeGreaterThan(0);
    expect(result.report.results.storeJobs).toBeGreaterThanOrEqual(0);
    if (__CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__) {
      expect(result.report.results.localRevCount).toBeNull();
      expect(result.report.results.revListSkipped).toBe(true);
    } else {
      expect(result.report.results.localRevCount).toBeGreaterThanOrEqual(1);
      expect(result.report.results.revListSkipped).toBe(false);
    }
    expect(result.outPath).toMatch(/metal-reconnect-volume|\.json$/);
  },
  900_000,
);

function hostedRemoteUrl(): string {
  const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!url) {
    throw new Error("Set VITE_CONVEX_URL or CONVEX_URL in .env.local before running metal tests.");
  }
  return url;
}

function hostedDeployment(): string {
  const deployment = __CONVEX_EMBEDDED_METAL_BENCH_DEPLOYMENT__?.trim();
  if (!deployment) {
    throw new Error(
      "Set EMBEDDED_METAL_BENCH_DEPLOYMENT or CONVEX_DEPLOYMENT before running hosted volume tests.",
    );
  }
  return deployment;
}

function metalCommands(): {
  embeddedMetalReconnectVolumeBenchmark(options: MetalReconnectVolumeBenchOptions): Promise<{
    outPath: string;
    report: MetalReconnectVolumeBenchReport;
  }>;
} {
  return commands as unknown as {
    embeddedMetalReconnectVolumeBenchmark(options: MetalReconnectVolumeBenchOptions): Promise<{
      outPath: string;
      report: MetalReconnectVolumeBenchReport;
    }>;
  };
}

interface MetalReconnectVolumeBenchOptions {
  clients: number;
  deployment: string;
  out?: string;
  remoteUrl: string;
  revs: number;
  skipRevList?: boolean;
  timeoutMs?: number;
}

interface MetalReconnectVolumeBenchReport {
  clientFinalTitles: Array<string | null>;
  clientStorageIds: string[];
  clients: number;
  foregroundTitle: string;
  observerFinalTitle: string | null;
  remoteTicks: {
    observer: {
      storeJobs: number;
    };
  };
  results: {
    finalConvergenceCorrect: boolean;
    firstLocalQueryMs: MetalBenchSample;
    foregroundDocWriteMs: MetalBenchSample;
    foregroundRevCreateMs: MetalBenchSample;
    offlineRevCreateMs: MetalBenchSample;
    offlineWriteMs: MetalBenchSample;
    reconnectStartToFirstRemoteEventMs: MetalBenchSample;
    reconnectStartToConvergenceMs: MetalBenchSample;
    remotePullMs: MetalBenchSample;
    hostedRevFirstReadMs: MetalBenchSample;
    hostedRevReadMs: MetalBenchSample;
    hostedSeedVisible: boolean;
    localRevCount: number | null;
    revListSkipped: boolean;
    seedMs: MetalBenchSample;
    storeJobs: number;
    streamConvergenceMs: MetalBenchSample;
  };
  revs: number;
  writerFinalTitle: string | null;
}

interface MetalBenchSample {
  p99: number;
  samples: number;
}
