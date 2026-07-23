import { installBrowserBenchPage } from "../../browser/harness/page.js";
import { browserLatencyScenarios } from "./options.js";
import type {
  BrowserLatencyBenchOptions,
  BrowserLatencyBenchReport,
  BrowserLatencyBenchResult,
  BrowserLatencyBenchScenario,
  PlaywrightCommandContext,
} from "./types.js";

export async function runBrowserLatencyBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: BrowserLatencyBenchOptions,
): Promise<BrowserLatencyBenchReport> {
  const results: BrowserLatencyBenchResult[] = [];
  const scenarios = browserLatencyScenarios(options);
  const browser = commandContext.context.browser();

  for (const scenario of scenarios) {
    const scenarioContext = browser ? await browser.newContext() : commandContext.context;
    const pages: import("playwright").Page[] = [];
    try {
      const pageA = await scenarioContext.newPage();
      pages.push(pageA);
      await installBrowserBenchPage(pageA, pageUrl, browserUrl, scenario, "primary");
      if (scenario.tabs === "two") {
        const pageB = await scenarioContext.newPage();
        pages.push(pageB);
        await installBrowserBenchPage(pageB, pageUrl, browserUrl, scenario, "secondary");
      }
      results.push(
        await pageA.evaluate(
          async ({ iterations, latencyP90BudgetMs, scenario, warmups }) => {
            const bench = (
              globalThis as typeof globalThis & {
                __embeddedBrowserBench: {
                  run(
                    scenario: BrowserLatencyBenchScenario,
                    iterations: number,
                    warmups: number,
                    latencyP90BudgetMs: number,
                  ): Promise<BrowserLatencyBenchResult>;
                };
              }
            ).__embeddedBrowserBench;
            return await bench.run(scenario, iterations, warmups, latencyP90BudgetMs);
          },
          {
            iterations: options.iterations,
            latencyP90BudgetMs: options.latencyP90BudgetMs,
            scenario,
            warmups: options.warmups,
          },
        ),
      );
    } finally {
      await Promise.all(
        pages.map((page) =>
          page
            .evaluate(() => {
              (
                globalThis as typeof globalThis & {
                  __embeddedBrowserBenchDispose?: () => void;
                }
              ).__embeddedBrowserBenchDispose?.();
            })
            .catch(() => undefined),
        ),
      );
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      if (scenarioContext !== commandContext.context) await scenarioContext.close();
    }
  }

  return {
    browser: "chromium",
    generatedAt: new Date().toISOString(),
    iterations: options.iterations,
    latencyP90BudgetMs: options.latencyP90BudgetMs,
    notes: [
      "remote is disabled for all scenarios",
      "each scenario uses a fresh Playwright BrowserContext when available",
      "browserUrl includes a cache-busting query, but Vite optimized dependency caching may still affect import/setup outside the measured window",
      "browser latency scenarios pass documents:read a benchmark limit large enough to observe seeded rows",
      "rowCount=0 measures empty-store add latency, so observedRows reflects warmup/sample inserts after the initially empty setup",
      "measured mutation latency is the public browser client promise; totalRuntimeMs is worker runtime timing reported by embedded diagnostics",
      `browser latency gate fails when measured p90 exceeds ${options.latencyP90BudgetMs}ms`,
    ],
    profile: options.profile,
    results,
    rowCounts: options.rowCounts,
    tabs: options.tabs,
    version: 1,
    warmups: options.warmups,
  };
}
