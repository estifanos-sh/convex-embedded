import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tsdownConfig from "./tsdown.config.js";

import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser/providers/playwright";
import { convexEmbedded } from "./src/vite.js";

/**
 * The playwright provider's `BrowserCommandContext` augmentation, stated locally. pnpm resolves
 * two peer variants of the test runner in this workspace, so the augmentation can land on the
 * other variant's interface; commands cast to this shape instead of depending on it.
 */
interface PlaywrightCommandContext {
  context: import("playwright").BrowserContext;
  page: import("playwright").Page;
}

const browserLogPath = fileURLToPath(new URL("./tests/browser/.logs/runtime.log", import.meta.url));
const browserDistPath = fileURLToPath(new URL("./dist/browser.mjs", import.meta.url));
const convexPath = fileURLToPath(import.meta.resolve("convex"));
const convexServerPath = fileURLToPath(import.meta.resolve("convex/server"));
const convexValuesPath = fileURLToPath(import.meta.resolve("convex/values"));
let browserLogInitialized = false;
const disallowedBrowserRuntimeError =
  /leader became unresponsive|worker request|timed out|toggle failed|clearCompleted failed/i;

export default defineConfig({
  pack: tsdownConfig,
  plugins: [browserRuntimeLog()],
  test: {
    projects: [
      {
        test: {
          environment: "node",
          exclude: ["tests/browser/**/*.ts", "tests/node/conformance.ts", "tests/node/native.ts"],
          include: ["tests/node/**/*.ts"],
          name: "node",
        },
      },
      {
        plugins: [convexEmbedded({ convexDir: "tests/browser/convex" }), browserRuntimeLog()],
        resolve: {
          alias: [
            { find: "@convex-dev/embedded/browser", replacement: browserDistPath },
            { find: "convex/server", replacement: convexServerPath },
            { find: "convex/values", replacement: convexValuesPath },
            { find: "convex", replacement: convexPath },
          ],
        },
        test: {
          browser: {
            commands: {
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
                    await state.client.mutation("messages:send", {
                      body: "from-a",
                      channel: state.channel,
                    });
                  });
                  await pageB.waitForFunction(() => {
                    const state = (
                      globalThis as typeof globalThis & {
                        __embeddedPageState?: EmbeddedPageState;
                      }
                    ).__embeddedPageState;
                    return state?.updates.some((rows) => rows.some((row) => row.body === "from-a"));
                  });
                  await pageA.close();
                  await pageB.evaluate(async () => {
                    const state = (
                      globalThis as typeof globalThis & {
                        __embeddedPageState: EmbeddedPageState;
                      }
                    ).__embeddedPageState;
                    await state.client.mutation("messages:send", {
                      body: "from-b-after-close",
                      channel: state.channel,
                    });
                  });
                  await pageB.waitForFunction(() => {
                    const state = (
                      globalThis as typeof globalThis & {
                        __embeddedPageState?: EmbeddedPageState;
                      }
                    ).__embeddedPageState;
                    return state?.updates.some((rows) =>
                      rows.some((row) => row.body === "from-b-after-close"),
                    );
                  });
                } finally {
                  await pageA.close().catch(() => undefined);
                  await pageB.close().catch(() => undefined);
                }
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
                      await state.client.mutation("messages:send", {
                        body: "closing-page",
                        channel: state.channel,
                      });
                    })
                    .catch(() => undefined);
                  await pages[0].close();
                  closed.add(pages[0]);

                  const active = [pages[1], pages[2]];
                  for (let index = 0; index < 12; index += 1) {
                    await sendPageMessage(
                      active[index % active.length],
                      `stress-${index}`,
                      expected,
                    );
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
            },
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: playwright() as never,
          },
          exclude: ["tests/browser/convex/**/*.ts"],
          include: ["tests/browser/**/*.ts"],
          name: "browser",
          testTimeout: 30_000,
        },
      },
    ],
  },
});

function browserRuntimeLog() {
  return {
    name: "convex-embedded:browser-log",
    configureServer(server: {
      middlewares: {
        use(
          route: string,
          handler: (
            req: { originalUrl?: string; url?: string },
            res: { end(body?: string): void; setHeader(name: string, value: string): void },
          ) => void,
        ): void;
        use(
          handler: (
            req: { originalUrl?: string; url?: string },
            res: unknown,
            next: () => void,
          ) => void,
        ): void;
      };
    }) {
      appendBrowserLog({ phase: "server:start", source: "vite" });
      server.middlewares.use((req, _res, next) => {
        const url = req.originalUrl ?? req.url ?? "";
        if (shouldLogRequest(url)) {
          appendBrowserLog({ phase: "server:request", source: "vite", url });
        }
        next();
      });
      server.middlewares.use("/__convex_embedded_page", (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.end('<!doctype html><html><body><main id="root"></main></body></html>');
      });
      server.middlewares.use("/__convex_embedded_browser_log", (req, res) => {
        try {
          const rawUrl = req.originalUrl ?? req.url ?? "";
          const url = new URL(rawUrl, "http://localhost");
          const entry = url.searchParams.get("entry") ?? "{}";
          appendBrowserLog(JSON.parse(entry) as Record<string, unknown>);
          res.setHeader("Content-Type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });
    },
  };
}

async function installEmbeddedPage(
  page: import("playwright").Page,
  url: string,
  browserUrl: string,
  channel: string,
  options: { clearStorageId?: boolean; initialQuery?: boolean } = {},
): Promise<void> {
  await page.goto(url);
  if (options.clearStorageId) {
    await page.evaluate(() => localStorage.removeItem("convex-embedded.storageId"));
  }
  await page.evaluate(
    async ({ browserUrl, channel, initialQuery }) => {
      (
        globalThis as typeof globalThis & {
          __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: unknown) => void;
        }
      ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
        void fetch(
          `/__convex_embedded_browser_log?entry=${encodeURIComponent(
            JSON.stringify({
              detail: event,
              now: Date.now(),
              phase: "multipage:debug",
              runtime: performance.now(),
              url: location.href,
            }),
          )}`,
        ).catch(() => undefined);
      };
      const { ConvexEmbeddedClient } = await import(browserUrl);
      const client = new ConvexEmbeddedClient();
      const errors: string[] = [];
      const updates: Array<Array<{ body: string; channel: string }>> = [];
      let observedData = false;
      const formatError = (error: unknown) =>
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const pushRows = (rows: Array<{ body: string; channel: string }>) => {
        if (observedData && rows.length === 0) {
          errors.push("observed empty query result after data had existed");
        }
        if (rows.length > 0) observedData = true;
        updates.push(rows);
      };
      if (initialQuery) {
        try {
          pushRows(
            (await client.query("messages:list", { channel })) as Array<{
              body: string;
              channel: string;
            }>,
          );
        } catch (error) {
          errors.push(formatError(error));
          throw error;
        }
      }
      const watch = client.watchQuery("messages:list", { channel });
      watch.onUpdate(
        () => {
          pushRows((watch.localQueryResult() ?? []) as Array<{ body: string; channel: string }>);
        },
        (error: unknown) => errors.push(formatError(error)),
      );
      (globalThis as typeof globalThis & { __embeddedPageState?: unknown }).__embeddedPageState = {
        channel,
        client,
        errors,
        updates,
      };
    },
    { browserUrl, channel, initialQuery: options.initialQuery ?? true },
  );
}

function observePageFailures(page: import("playwright").Page, failures: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" || disallowedBrowserRuntimeError.test(text)) {
      failures.push(`[console:${message.type()}] ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    failures.push(`[pageerror] ${error.message}`);
  });
}

async function sendPageMessage(
  page: import("playwright").Page,
  body: string,
  expected: Set<string>,
): Promise<void> {
  await page.evaluate(async (body) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedPageState: EmbeddedPageState;
      }
    ).__embeddedPageState;
    await state.client.mutation("messages:send", {
      body,
      channel: state.channel,
    });
  }, body);
  expected.add(body);
}

async function waitForPageBodies(
  pages: import("playwright").Page[],
  expected: Set<string>,
): Promise<void> {
  const bodies = [...expected];
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        (expectedBodies) => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState?: EmbeddedPageState;
            }
          ).__embeddedPageState;
          const latest = state?.updates.at(-1) ?? [];
          const actual = new Set(latest.map((row) => row.body));
          return expectedBodies.every((body) => actual.has(body));
        },
        bodies,
        { timeout: 15_000 },
      ),
    ),
  );
}

async function assertNoPageFailures(
  pages: import("playwright").Page[],
  failures: string[],
): Promise<void> {
  const stateErrors = (
    await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState?: EmbeddedPageState;
            }
          ).__embeddedPageState;
          return state?.errors ?? [];
        }),
      ),
    )
  ).flat();
  const allFailures = [...failures, ...stateErrors];
  if (allFailures.length > 0) {
    throw new Error(`Browser multi-page stress observed failures:\n${allFailures.join("\n")}`);
  }
}

interface EmbeddedPageState {
  channel: string;
  client: {
    mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
    query(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  errors: string[];
  updates: Array<Array<{ body: string; channel: string }>>;
}

function appendBrowserLog(entry: Record<string, unknown>): void {
  initBrowserLog();
  appendFileSync(browserLogPath, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, "utf8");
}

function initBrowserLog(): void {
  if (browserLogInitialized) return;
  browserLogInitialized = true;
  mkdirSync(path.dirname(browserLogPath), { recursive: true });
  rmSync(browserLogPath, { force: true });
}

function shouldLogRequest(url: string): boolean {
  return (
    url.includes("__vitest") ||
    url.includes("__vitest_browser") ||
    url.includes("tests/browser") ||
    url.includes("@id/") ||
    url.includes("@fs/")
  );
}
