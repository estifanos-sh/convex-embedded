import { readList, readNumber, readValue } from "./read.ts";

type BrowserProfile = "full" | "smoke";
type BrowserTab = "one" | "two";

/**
 * The single source of every benchmark default. `browserBench`/`metalBench` apply the process
 * environment as an override at each existing evaluation point; the node constants seed the local
 * scale and runtime benches, which keep their own throw-on-invalid readers.
 */
export const benchDefaults = {
  browser: {
    iterations: 10,
    warmups: 3,
    profile: "smoke",
    rowCounts: [0, 10, 100, 1_000],
    tabs: ["one", "two"],
    latencyP90BudgetMs: 10,
    timeoutMs: 300_000,
    scaleClients: 2,
    scaleDurationMs: 250,
    scaleRows: 1_000,
    remoteIterations: 20,
    remoteWarmups: 3,
    remoteTimeoutMs: 15_000,
  },
  metal: {
    clients: 5,
    writes: 50,
    scaleRevs: 2_000,
    reconnectRevs: 5,
    timeoutMs: 120_000,
  },
  node: {
    runtime: {
      iterations: 1_000,
      smokeIterations: 25,
      warmups: 100,
      rows: 10_000,
      smokeRows: 250,
      watcherFanout: 0,
    },
    scale: {
      clients: 8,
      smokeClients: 2,
      durationMs: 2_000,
      smokeDurationMs: 100,
      operations: 1_000,
      smokeOperations: 20,
      rows: 100_000,
      smokeRows: 1_000,
      seedBatchSize: 10_000,
    },
  },
} as const;

/** Read a browser-tab selection list, falling back to the given defaults. */
export function readTabs(name: string, fallback: readonly BrowserTab[]): BrowserTab[] {
  const raw = readValue(name);
  if (raw === undefined) return [...fallback];
  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is BrowserTab => part === "one" || part === "two");
  return parsed.length > 0 ? parsed : [...fallback];
}

/** Resolve the browser benchmark knobs from the environment over the shared defaults. */
export function browserBench() {
  const defaults = benchDefaults.browser;
  return {
    iterations: readNumber("EMBEDDED_BROWSER_BENCH_ITERATIONS", defaults.iterations),
    warmups: readNumber("EMBEDDED_BROWSER_BENCH_WARMUPS", defaults.warmups),
    profile: browserBenchProfile(),
    rowCounts: readList("EMBEDDED_BROWSER_BENCH_ROWS", defaults.rowCounts),
    tabs: readTabs("EMBEDDED_BROWSER_BENCH_TABS", defaults.tabs),
    latencyP90BudgetMs: readNumber(
      "EMBEDDED_BROWSER_BENCH_LATENCY_P90_BUDGET_MS",
      defaults.latencyP90BudgetMs,
    ),
    timeoutMs: readNumber("EMBEDDED_BROWSER_BENCH_TIMEOUT_MS", defaults.timeoutMs),
    scaleClients: readNumber("EMBEDDED_BROWSER_BENCH_CLIENTS", defaults.scaleClients),
    scaleDurationMs: readNumber("EMBEDDED_BROWSER_BENCH_DURATION_MS", defaults.scaleDurationMs),
    scaleRows: readNumber("EMBEDDED_BROWSER_BENCH_SCALE_ROWS", defaults.scaleRows),
    remoteIterations: readNumber("EMBEDDED_BROWSER_REMOTE_ITERATIONS", defaults.remoteIterations),
    remoteWarmups: readNumber("EMBEDDED_BROWSER_REMOTE_WARMUPS", defaults.remoteWarmups),
    remoteTimeoutMs: readNumber("EMBEDDED_BROWSER_REMOTE_TIMEOUT_MS", defaults.remoteTimeoutMs),
  };
}

/** Resolve the metal benchmark knobs from the environment over the shared defaults. */
export function metalBench() {
  const defaults = benchDefaults.metal;
  return {
    clients: readNumber("EMBEDDED_METAL_BENCH_CLIENTS", defaults.clients),
    writes: readNumber("EMBEDDED_METAL_BENCH_WRITES", defaults.writes),
    scaleRevs: readNumber("EMBEDDED_METAL_BENCH_REVS", defaults.scaleRevs),
    timeoutMs: readNumber("EMBEDDED_METAL_BENCH_TIMEOUT_MS", defaults.timeoutMs),
  };
}

function browserBenchProfile(): BrowserProfile {
  const raw = readValue("EMBEDDED_BROWSER_BENCH_PROFILE");
  if (raw === "full") return "full";
  if (raw === "smoke") return "smoke";
  return benchDefaults.browser.profile;
}
