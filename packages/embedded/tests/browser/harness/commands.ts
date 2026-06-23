import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { getTimerTime } from "../../../src/time.js";
import { runBrowserLatencyBenchmark } from "../../bench/harness/latency.js";
import {
  readBrowserLatencyBenchOptions,
  readBrowserRemoteBenchOptions,
  readBrowserScaleBenchOptions,
  readBrowserStartupBenchOptions,
  resolveBenchOutPath,
} from "../../bench/harness/options.js";
import {
  browserDistPath,
  browserRemoteBenchOutPath,
  browserScaleBenchOutPath,
  browserStartupBenchOutPath,
  createRootDocument,
  listRootDocuments,
} from "../../bench/harness/paths.js";
import { runBrowserRemoteBenchmark } from "../../bench/harness/remote.js";
import { runBrowserScaleBenchmark } from "../../bench/harness/scale.js";
import { runBrowserStartupBenchmark } from "../../bench/harness/startup.js";
import type {
  BrowserLatencyBenchOptions,
  BrowserRemoteBenchOptions,
  BrowserScaleBenchOptions,
  BrowserStartupBenchOptions,
  PlaywrightCommandContext,
} from "../../bench/harness/types.js";
import {
  assertNoPageFailures,
  installEmbeddedPage,
  observePageFailures,
  sendPageMessage,
  waitForPageBodies,
} from "./page.js";
import type { EmbeddedPageState } from "./page.js";

export const browserCommands = {
  embeddedBrowserLatencyBenchmark: async (
    commandContext: unknown,
    options: BrowserLatencyBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserLatencyBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?bench=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserLatencyBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserStartupBenchmark: async (
    commandContext: unknown,
    options: BrowserStartupBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserStartupBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?bench=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserStartupBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserStartupBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserRemoteBenchmark: async (
    commandContext: unknown,
    options: BrowserRemoteBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserRemoteBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?remote=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserRemoteBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserRemoteBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserScaleBenchmark: async (
    commandContext: unknown,
    options: BrowserScaleBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserScaleBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?scale=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserScaleBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserScaleBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedMultiPage: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pageA = await context.context.newPage();
    const pageB = await context.context.newPage();
    try {
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel);
      await installEmbeddedPage(pageB, pageUrl, browserUrl, channel);
      await pageA.evaluate(async () => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState: EmbeddedPageState;
          }
        ).__embeddedPageState;
        await state.writeDocument("from-a");
      });
      await pageB.waitForFunction(() => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState?: EmbeddedPageState;
          }
        ).__embeddedPageState;
        return state?.updates.some((rows) => rows.some((row) => row.text === "from-a"));
      });
      await pageA.close();
      await pageB.evaluate(async () => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState: EmbeddedPageState;
          }
        ).__embeddedPageState;
        await state.writeDocument("from-b-after-close");
      });
      await pageB.waitForFunction(() => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState?: EmbeddedPageState;
          }
        ).__embeddedPageState;
        return state?.updates.some((rows) => rows.some((row) => row.text === "from-b-after-close"));
      });
    } finally {
      await pageA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
    }
  },
  embeddedRemoteDocumentMatches: async (
    _commandContext: unknown,
    url: string,
    text: string,
    body: string,
  ) => {
    const client = new ConvexHttpClient(url);
    const rows = await client.query(listRootDocuments, { prefix: text });
    return rows.some((row) => row.title === text && row.body === body);
  },
  embeddedRemoteDocumentExists: async (_commandContext: unknown, url: string, text: string) => {
    const client = new ConvexHttpClient(url);
    const rows = await client.query(listRootDocuments, { prefix: text });
    return rows.some((row) => row.title === text);
  },
  embeddedRemoteDocumentCreate: async (
    _commandContext: unknown,
    url: string,
    text: string,
    body: string,
  ) => {
    const client = new ConvexHttpClient(url);
    return await client.mutation(createRootDocument, {
      body,
      slug: text,
      title: text,
    });
  },
  embeddedMultiPageStress: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pages = await Promise.all([
      context.context.newPage(),
      context.context.newPage(),
      context.context.newPage(),
    ]);
    const closed = new Set<import("playwright").Page>();
    const failures: string[] = [];
    const expected = new Set<string>();
    for (const page of pages) observePageFailures(page, failures);
    try {
      await Promise.all(
        pages.map((page) =>
          installEmbeddedPage(page, pageUrl, browserUrl, channel, {
            clearStorageId: true,
          }),
        ),
      );
      await Promise.all(
        pages.map((page, index) => sendPageMessage(page, `initial-${index}`, expected)),
      );
      await waitForPageBodies(pages, expected);

      void pages[0]
        .evaluate(async () => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState: EmbeddedPageState;
            }
          ).__embeddedPageState;
          await state.writeDocument("closing-page");
        })
        .catch(() => undefined);
      await pages[0].close();
      closed.add(pages[0]);

      const active = [pages[1], pages[2]];
      for (let index = 0; index < 12; index += 1) {
        await sendPageMessage(active[index % active.length], `stress-${index}`, expected);
        if (index === 5) {
          await active[1].reload();
          await installEmbeddedPage(active[1], pageUrl, browserUrl, channel);
        }
        await waitForPageBodies(active, expected);
      }

      const fresh = await context.context.newPage();
      pages.push(fresh);
      observePageFailures(fresh, failures);
      await installEmbeddedPage(fresh, pageUrl, browserUrl, channel);
      await waitForPageBodies([fresh], expected);
      await assertNoPageFailures(
        pages.filter((page) => !closed.has(page)),
        failures,
      );
    } finally {
      await Promise.all(
        pages
          .filter((page) => !closed.has(page))
          .map((page) => page.close().catch(() => undefined)),
      );
    }
  },
  embeddedWatchOnlyLateSubscriber: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pageA = await context.context.newPage();
    const pageB = await context.context.newPage();
    const pageC = await context.context.newPage();
    const pages = [pageA, pageB, pageC];
    const failures: string[] = [];
    for (const page of pages) observePageFailures(page, failures);
    const expected = new Set<string>();
    try {
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await installEmbeddedPage(pageB, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await sendPageMessage(pageA, "watch-only-seed", expected);
      await waitForPageBodies([pageA, pageB], expected);

      await installEmbeddedPage(pageC, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageC], expected);

      await pageC.reload();
      await installEmbeddedPage(pageC, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageC], expected);

      await pageA.reload();
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageA, pageB, pageC], expected);
      await assertNoPageFailures(pages, failures);
    } finally {
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    }
  },
};
