import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { benchDefaults, readTabs } from "../../../../../config/bench.js";
import { readList, readNumber } from "../../../../../config/read.js";
import { writeRevisionVolume } from "../../../scripts/volume.js";
import { browserBenchOutPath, hostedDeployment, metalFixtureDir, packageRoot } from "./paths.js";
import type {
  BrowserLatencyBenchOptions,
  BrowserLatencyBenchScenario,
  BrowserRemoteBenchOptions,
  BrowserScaleBenchOptions,
  BrowserStartupBenchOptions,
  MetalReconnectVolumeBenchOptions,
  MetalScaleBenchOptions,
} from "./types.js";

export function browserLatencyScenarios(
  options: BrowserLatencyBenchOptions,
): BrowserLatencyBenchScenario[] {
  const devtoolsValues = options.profile === "full" ? [false, true] : [false, true];
  const watchValues = options.profile === "full" ? [false, true] : [false, true];
  const scenarios: BrowserLatencyBenchScenario[] = [];
  for (const tabs of options.tabs) {
    for (const rowCount of options.rowCounts) {
      for (const devtoolsOpen of devtoolsValues) {
        for (const watchActive of watchValues) {
          if (
            options.profile === "smoke" &&
            tabs === "two" &&
            (rowCount !== 100 || devtoolsOpen || !watchActive)
          ) {
            continue;
          }
          scenarios.push({ devtoolsOpen, rowCount, tabs, watchActive });
        }
      }
    }
  }
  return scenarios;
}

export function readBrowserLatencyBenchOptions(
  fallback: BrowserLatencyBenchOptions,
): BrowserLatencyBenchOptions {
  return {
    iterations: readNumber(
      "EMBEDDED_BROWSER_BENCH_ITERATIONS",
      fallback.iterations || benchDefaults.browser.iterations,
    ),
    latencyP90BudgetMs: readNumber(
      "EMBEDDED_BROWSER_BENCH_LATENCY_P90_BUDGET_MS",
      fallback.latencyP90BudgetMs || benchDefaults.browser.latencyP90BudgetMs,
    ),
    out: process.env.EMBEDDED_BROWSER_BENCH_OUT ?? fallback.out,
    profile:
      process.env.EMBEDDED_BROWSER_BENCH_PROFILE === "full"
        ? "full"
        : process.env.EMBEDDED_BROWSER_BENCH_PROFILE === "smoke"
          ? "smoke"
          : fallback.profile,
    rowCounts: readList("EMBEDDED_BROWSER_BENCH_ROWS", fallback.rowCounts),
    tabs: readTabs("EMBEDDED_BROWSER_BENCH_TABS", fallback.tabs),
    warmups: readNumber(
      "EMBEDDED_BROWSER_BENCH_WARMUPS",
      fallback.warmups || benchDefaults.browser.warmups,
    ),
  };
}

export function readBrowserStartupBenchOptions(
  fallback: BrowserStartupBenchOptions,
): BrowserStartupBenchOptions {
  return {
    iterations: readNumber(
      "EMBEDDED_BROWSER_BENCH_ITERATIONS",
      fallback.iterations || benchDefaults.browser.iterations,
    ),
    out: process.env.EMBEDDED_BROWSER_BENCH_OUT ?? fallback.out,
    warmups: readNumber(
      "EMBEDDED_BROWSER_BENCH_WARMUPS",
      fallback.warmups || benchDefaults.browser.warmups,
    ),
  };
}

export function readBrowserRemoteBenchOptions(
  fallback: BrowserRemoteBenchOptions,
): BrowserRemoteBenchOptions {
  return {
    iterations: readNumber(
      "EMBEDDED_BROWSER_REMOTE_ITERATIONS",
      fallback.iterations || benchDefaults.browser.remoteIterations,
    ),
    out: process.env.EMBEDDED_BROWSER_REMOTE_OUT ?? fallback.out,
    remoteUrl: process.env.EMBEDDED_BROWSER_REMOTE_URL ?? fallback.remoteUrl,
    timeoutMs: readNumber(
      "EMBEDDED_BROWSER_REMOTE_TIMEOUT_MS",
      fallback.timeoutMs || benchDefaults.browser.remoteTimeoutMs,
    ),
    warmups: readNumber(
      "EMBEDDED_BROWSER_REMOTE_WARMUPS",
      fallback.warmups || benchDefaults.browser.remoteWarmups,
    ),
  };
}

export function readBrowserScaleBenchOptions(
  fallback: BrowserScaleBenchOptions,
): BrowserScaleBenchOptions {
  return {
    clients: readNumber(
      "EMBEDDED_BROWSER_BENCH_CLIENTS",
      fallback.clients || benchDefaults.browser.scaleClients,
    ),
    durationMs: readNumber(
      "EMBEDDED_BROWSER_BENCH_DURATION_MS",
      fallback.durationMs || benchDefaults.browser.scaleDurationMs,
    ),
    out: process.env.EMBEDDED_BROWSER_BENCH_OUT ?? fallback.out,
    rows: readNumber(
      "EMBEDDED_BROWSER_BENCH_SCALE_ROWS",
      fallback.rows || benchDefaults.browser.scaleRows,
    ),
  };
}

export function readMetalScaleBenchOptions(
  fallback: MetalScaleBenchOptions,
): MetalScaleBenchOptions {
  return {
    clients: readNumber(
      "EMBEDDED_METAL_BENCH_CLIENTS",
      fallback.clients || benchDefaults.metal.clients,
    ),
    out: process.env.EMBEDDED_METAL_BENCH_OUT ?? fallback.out,
    remoteUrl: fallback.remoteUrl,
    revs: readNumber("EMBEDDED_METAL_BENCH_REVS", fallback.revs || benchDefaults.metal.scaleRevs),
    skipRevList:
      process.env.EMBEDDED_METAL_BENCH_SKIP_REV_LIST === "1" || fallback.skipRevList === true,
    timeoutMs: Math.min(
      300_000,
      readNumber(
        "EMBEDDED_METAL_BENCH_TIMEOUT_MS",
        fallback.timeoutMs ?? benchDefaults.metal.timeoutMs,
      ),
    ),
    writes: readNumber(
      "EMBEDDED_METAL_BENCH_WRITES",
      fallback.writes || benchDefaults.metal.writes,
    ),
  };
}

export function readMetalReconnectVolumeBenchOptions(
  fallback: MetalReconnectVolumeBenchOptions,
): MetalReconnectVolumeBenchOptions {
  return {
    clients: readNumber(
      "EMBEDDED_METAL_BENCH_CLIENTS",
      fallback.clients || benchDefaults.metal.clients,
    ),
    deployment:
      process.env.EMBEDDED_METAL_BENCH_DEPLOYMENT ??
      process.env.CONVEX_DEPLOYMENT ??
      hostedDeployment ??
      fallback.deployment,
    out: process.env.EMBEDDED_METAL_BENCH_OUT ?? fallback.out,
    remoteUrl: fallback.remoteUrl,
    revs: readNumber(
      "EMBEDDED_METAL_BENCH_REVS",
      fallback.revs || benchDefaults.metal.reconnectRevs,
    ),
    skipRevList:
      process.env.EMBEDDED_METAL_BENCH_SKIP_REV_LIST === "1" || fallback.skipRevList === true,
    timeoutMs: readNumber(
      "EMBEDDED_METAL_BENCH_TIMEOUT_MS",
      fallback.timeoutMs || benchDefaults.metal.timeoutMs,
    ),
  };
}

export function replaceMetalRevisionVolume(options: {
  deployment: string;
  remoteUrl: string;
  revs: number;
  rowId: string;
}): void {
  const deployment = options.deployment.trim();
  if (!deployment) {
    throw new Error(
      "Hosted volume seeding requires EMBEDDED_METAL_BENCH_DEPLOYMENT or CONVEX_DEPLOYMENT.",
    );
  }
  if (deployment === "prod" || deployment.startsWith("prod:")) {
    throw new Error("Hosted volume seeding cannot replace revision history in production.");
  }
  const hostname = new URL(options.remoteUrl).hostname;
  const deploymentName = deployment.includes(":")
    ? deployment.slice(deployment.indexOf(":") + 1)
    : deployment;
  if (!hostname.startsWith(`${deploymentName}.`)) {
    throw new Error(
      `Hosted volume deployment ${deployment} does not match remote URL ${options.remoteUrl}.`,
    );
  }

  const scratch = mkdtempSync(`${tmpdir()}/embedded-volume-`);
  try {
    const documents = path.join(scratch, "revisions", "documents.jsonl");
    const input = path.join(scratch, "revisions.zip");
    writeRevisionVolume({ out: documents, rowId: options.rowId, rows: options.revs });
    const zipped = spawnSync("zip", ["-q", "-r", input, "revisions"], {
      cwd: scratch,
      encoding: "utf8",
    });
    if (zipped.status !== 0) {
      throw new Error(
        `Hosted revision snapshot compression failed (${zipped.status ?? "signal"}): ${zipped.stderr || zipped.stdout}`,
      );
    }
    const imported = spawnSync(
      "vpx",
      ["convex", "import", "--component", "embedded", "--replace", "--yes", input],
      { cwd: metalFixtureDir, encoding: "utf8" },
    );
    if (imported.status !== 0) {
      throw new Error(
        `Hosted revision import failed (${imported.status ?? "signal"}): ${imported.stderr || imported.stdout}`,
      );
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

export function resolveBenchOutPath(
  out: string | undefined,
  fallback = browserBenchOutPath,
): string {
  if (!out) return fallback;
  return path.isAbsolute(out) ? out : path.resolve(packageRoot, out);
}
