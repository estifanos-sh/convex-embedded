import { playwright } from "vite-plus/test/browser/providers/playwright";
import type { TestProjectInlineConfiguration } from "vitest/config";

import { browserBench } from "../../../config/bench.js";
import { convexEmbedded } from "../src/vite.js";
import {
  browserConvexDir,
  browserDistPath,
  browserLocalDir,
  convexBrowserPath,
  convexPath,
  convexServerPath,
  convexValuesPath,
  hostedRemoteUrl,
  localEntryPath,
  localInternalEntryPath,
} from "../tests/bench/harness/paths.js";
import { browserCommands } from "../tests/browser/harness/commands.js";
import { browserRuntimeLog } from "../tests/browser/harness/log.js";
import schema from "../tests/fixture/convex/schema.js";

const bench = browserBench();

export const browserProject = {
  define: {
    __CONVEX_EMBEDDED_BROWSER_BENCH__: JSON.stringify(process.env.EMBEDDED_BROWSER_BENCH === "1"),
    __CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__: JSON.stringify(bench.iterations),
    __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__: JSON.stringify(process.env.EMBEDDED_BROWSER_BENCH_OUT),
    __CONVEX_EMBEDDED_BROWSER_BENCH_PROFILE__: JSON.stringify(bench.profile),
    __CONVEX_EMBEDDED_BROWSER_BENCH_ROWS__: JSON.stringify(bench.rowCounts.join(",")),
    __CONVEX_EMBEDDED_BROWSER_BENCH_STARTUP__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_STARTUP === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_REMOTE__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_REMOTE === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_SCALE === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__: JSON.stringify(bench.scaleClients),
    __CONVEX_EMBEDDED_BROWSER_BENCH_DURATION_MS__: JSON.stringify(bench.scaleDurationMs),
    __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE_ROWS__: JSON.stringify(bench.scaleRows),
    __CONVEX_EMBEDDED_BROWSER_BENCH_TIMEOUT_MS__: JSON.stringify(
      Math.min(300_000, bench.timeoutMs),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_TABS__: JSON.stringify(bench.tabs.join(",")),
    __CONVEX_EMBEDDED_BROWSER_BENCH_WARMUPS__: JSON.stringify(bench.warmups),
    __CONVEX_EMBEDDED_HOSTED_URL__: JSON.stringify(hostedRemoteUrl ?? null),
  },
  plugins: [
    convexEmbedded({
      convexDir: browserConvexDir,
      local: browserLocalDir,
      schema,
    }),
    browserRuntimeLog(),
  ],
  optimizeDeps: {
    include: [
      "@codemirror/lang-json",
      "@codemirror/lint",
      "@tanstack/devtools",
      "codemirror",
      "convex/browser",
      "solid-js",
      "solid-js/web",
    ],
  },
  resolve: {
    dedupe: ["solid-js"],
    alias: [
      { find: "@estifanos-sh/convex-embedded/browser", replacement: browserDistPath },
      { find: "@estifanos-sh/convex-embedded/internal/local", replacement: localInternalEntryPath },
      { find: "@estifanos-sh/convex-embedded/local", replacement: localEntryPath },
      { find: "convex/browser", replacement: convexBrowserPath },
      { find: "convex/server", replacement: convexServerPath },
      { find: "convex/values", replacement: convexValuesPath },
      { find: "convex", replacement: convexPath },
    ],
  },
  test: {
    browser: {
      commands: browserCommands,
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright() as never,
    },
    include: [
      "tests/browser/fixture.ts",
      "tests/browser/memory.ts",
      "tests/browser/protocol.ts",
      "tests/browser/runtime.ts",
      "tests/browser/stress.ts",
      "tests/bench/browser/remote.ts",
      "tests/bench/browser/scale.ts",
    ],
    name: "browser",
    testTimeout: 30_000,
  },
} satisfies TestProjectInlineConfiguration;
