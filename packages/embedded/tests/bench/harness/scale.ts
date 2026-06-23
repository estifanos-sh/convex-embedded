import { getTimerTime } from "../../../src/time.js";
import { installBrowserScalePage } from "../../browser/harness/page.js";
import { summarizeBenchSamples } from "./metal.js";
import { browserSeedPath } from "./paths.js";
import type {
  BrowserScaleBenchOptions,
  BrowserScaleBenchReport,
  BrowserScalePageState,
  PlaywrightCommandContext,
} from "./types.js";

export async function runBrowserScaleBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: BrowserScaleBenchOptions,
): Promise<BrowserScaleBenchReport> {
  const browser = commandContext.context.browser();
  const scenarioContext = browser ? await browser.newContext() : commandContext.context;
  const pages: import("playwright").Page[] = [];
  const storageId = `browser-scale-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const prefix = `${storageId}:`;
  try {
    const seedPage = await scenarioContext.newPage();
    const seedStartedAt = getTimerTime();
    try {
      await seedBrowserScaleStore(seedPage, pageUrl, `/@fs${browserSeedPath}`, {
        prefix,
        rows: options.rows,
        storageId,
      });
    } finally {
      await seedPage.close().catch(() => undefined);
    }
    const seedMs = getTimerTime() - seedStartedAt;

    const startupSamples: number[] = [];
    for (let index = 0; index < options.clients; index += 1) {
      const page = await scenarioContext.newPage();
      pages.push(page);
      const startupStartedAt = getTimerTime();
      await installBrowserScalePage(page, pageUrl, browserUrl, {
        prefix,
        queryLimit: 1,
        storageId,
      });
      startupSamples.push(getTimerTime() - startupStartedAt);
    }
    const primary = pages[0];
    if (!primary) throw new Error("Browser scale benchmark needs at least one page.");
    const result = await primary.evaluate(async (durationMs) => {
      const scale = (
        globalThis as typeof globalThis & {
          __embeddedBrowserScale: BrowserScalePageState;
        }
      ).__embeddedBrowserScale;
      return await scale.run(durationMs);
    }, options.durationMs);
    const streamConvergenceStartedAt = getTimerTime();
    const observers = await Promise.all(
      pages.map((page) =>
        page.evaluate(async (title) => {
          const scale = (
            globalThis as typeof globalThis & {
              __embeddedBrowserScale: BrowserScalePageState;
            }
          ).__embeddedBrowserScale;
          await scale.waitForTitle(title);
          return { latestTitle: scale.latestTitle, updateCount: scale.updateCount };
        }, result.finalTitle),
      ),
    );
    const streamConvergenceMs = getTimerTime() - streamConvergenceStartedAt;
    const observerFinalTitles = observers.map((observer) => observer.latestTitle);
    const observerUpdates = observers.map((observer) => observer.updateCount);
    return {
      browser: "chromium",
      clients: options.clients,
      durationMs: options.durationMs,
      finalTitle: result.finalTitle,
      generatedAt: new Date().toISOString(),
      notes: [
        "remote is disabled; every page uses the same browser storage id",
        "row volume is seeded through benchmark-only storage batches before measured clients and watches attach",
        "seed time is reported separately from reopen and foreground operation latency",
        "fanout measures one writer page with watch subscribers across all benchmark pages",
      ],
      observerFinalTitles,
      observerUpdates,
      rows: options.rows,
      results: {
        allObserversSawFinal: observerFinalTitles.every((title) => title === result.finalTitle),
        fanoutWrites: result.fanoutWrites,
        seedMs: summarizeBenchSamples([seedMs]),
        startupMs: summarizeBenchSamples(startupSamples),
        streamConvergenceMs: summarizeBenchSamples([streamConvergenceMs]),
        writeMs: result.writeMs,
      },
      version: 4,
    };
  } finally {
    await Promise.all(
      pages.map((page) =>
        page
          .evaluate(() => {
            (
              globalThis as typeof globalThis & {
                __embeddedBrowserScaleDispose?: () => void;
              }
            ).__embeddedBrowserScaleDispose?.();
          })
          .catch(() => undefined),
      ),
    );
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    if (scenarioContext !== commandContext.context) await scenarioContext.close();
  }
}

async function seedBrowserScaleStore(
  page: import("playwright").Page,
  url: string,
  seedUrl: string,
  options: { prefix: string; rows: number; storageId: string },
): Promise<void> {
  await page.goto(
    `${url}?scale-seed=${encodeURIComponent(`${getTimerTime()}-${Math.random().toString(36).slice(2)}`)}`,
  );
  await page.evaluate(
    async ({ prefix, rows, seedUrl, storageId }) => {
      const worker = new Worker(seedUrl, { type: "module" });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Browser volume seed exceeded its 210-second budget.")),
            210_000,
          );
          worker.addEventListener("message", (event: MessageEvent) => {
            const result = event.data as { error?: string; ok?: boolean };
            clearTimeout(timeout);
            if (result.ok === true) resolve();
            else reject(new Error(result.error ?? "Browser volume seed failed."));
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          });
          worker.postMessage({ prefix, rows, storageId });
        });
      } finally {
        worker.terminate();
      }
    },
    { ...options, seedUrl },
  );
}
