import { expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

declare const __CONVEX_EMBEDDED_BROWSER_BENCH_REMOTE__: boolean;
declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;

test.skipIf(!__CONVEX_EMBEDDED_BROWSER_BENCH_REMOTE__)(
  "compares hosted Embedded convergence with direct Convex",
  async () => {
    if (!__CONVEX_EMBEDDED_HOSTED_URL__) {
      throw new Error("Hosted browser benchmark requires a configured Convex URL.");
    }
    const result = await browserCommands().embeddedBrowserRemoteBenchmark({
      iterations: 20,
      remoteUrl: __CONVEX_EMBEDDED_HOSTED_URL__,
      timeoutMs: 15_000,
      warmups: 3,
    });

    expect(result.report.version).toBe(4);
    expect(result.report.samples).toHaveLength(result.report.iterations);
    expect(result.report.summaries.directPeerMs.samples).toBe(result.report.iterations);
    expect(result.report.summaries.embeddedPeerMs.samples).toBe(result.report.iterations);
    expect(result.report.samples.every((sample) => sample.direct.transitions === 1)).toBe(true);
    expect(result.report.samples.filter((sample) => sample.order === "direct-first")).toHaveLength(
      result.report.iterations / 2,
    );
    expect(
      result.report.samples.filter((sample) => sample.order === "embedded-first"),
    ).toHaveLength(result.report.iterations / 2);
    expect(result.report.samples.every((sample) => sample.embedded.writer.pushAccepted >= 1)).toBe(
      true,
    );
    expect(
      result.report.samples.every((sample) => sample.embedded.observer.pullAttempted >= 1),
    ).toBe(true);
    expect(result.report.samples.every((sample) => sample.embedded.observer.storeJobs === 1)).toBe(
      true,
    );

    expect(result.report.cache.embeddedListFunction).toBe("documents:summaries");
    expect(result.report.cache.embeddedSummaryKeys).toEqual(["_id", "title", "updatedAt"]);
    expect(result.report.cache.embeddedListOmitsBody).toBe(true);
    expect(result.report.cache.bodyEditCacheServes).toBeGreaterThan(0);
    expect(result.report.cache.bodyEditListWrites).toBe(0);
    expect(result.report.cache.bodyEditResultWrites).toBe(0);
    expect(result.report.cache.titleEditResultWrites).toBeGreaterThan(0);
    expect(result.report.samples.every((sample) => sample.embedded.listTransitions === 0)).toBe(
      true,
    );
    expect(result.report.samples.every((sample) => sample.embedded.resultWrites === 0)).toBe(true);
    expect(result.report.samples.every((sample) => sample.direct.listTransitions === 0)).toBe(true);

    expect(result.report.unrelated.directTransitions).toBe(0);
    expect(result.report.unrelated.embeddedTransitions).toBe(0);
    expect(result.report.unrelated.embeddedObserver.storeJobs).toBe(0);
    expect(result.report.lifecycle).toEqual({
      create: true,
      crdt: true,
      delete: true,
      plain: true,
    });
    expect(result.report.suspicious).toEqual([]);
  },
  180_000,
);

function browserCommands(): {
  embeddedBrowserRemoteBenchmark(options: BrowserRemoteBenchOptions): Promise<{
    outPath: string;
    report: BrowserRemoteBenchReport;
  }>;
} {
  return commands as unknown as {
    embeddedBrowserRemoteBenchmark(options: BrowserRemoteBenchOptions): Promise<{
      outPath: string;
      report: BrowserRemoteBenchReport;
    }>;
  };
}

interface BrowserRemoteBenchOptions {
  iterations: number;
  remoteUrl: string;
  timeoutMs: number;
  warmups: number;
}

interface BrowserRemoteTickEvidence {
  pullAttempted: number;
  pushAccepted: number;
  storeJobs: number;
}

interface BrowserRemoteBenchReport {
  cache: {
    embeddedListFunction: string;
    embeddedListOmitsBody: boolean;
    embeddedSummaryKeys: string[];
    bodyEditCacheServes: number;
    bodyEditListWrites: number;
    bodyEditResultWrites: number;
    titleEditCacheServes: number;
    titleEditResultWrites: number;
  };
  iterations: number;
  lifecycle: { create: boolean; crdt: boolean; delete: boolean; plain: boolean };
  samples: Array<{
    direct: { listTransitions: number; transitions: number };
    embedded: {
      cacheServes: number;
      listTransitions: number;
      observer: BrowserRemoteTickEvidence;
      resultWrites: number;
      writer: BrowserRemoteTickEvidence;
    };
    order: "direct-first" | "embedded-first";
  }>;
  summaries: {
    directPeerMs: { p95: number; samples: number };
    embeddedPeerMs: { p95: number; samples: number };
  };
  suspicious: string[];
  unrelated: {
    directTransitions: number;
    embeddedObserver: BrowserRemoteTickEvidence;
    embeddedTransitions: number;
  };
  version: 4;
}
