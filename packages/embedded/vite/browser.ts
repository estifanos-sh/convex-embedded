import { playwright } from "vite-plus/test/browser/providers/playwright";
import type { TestProjectInlineConfiguration } from "vitest/config";

import { convexEmbedded } from "../src/vite.js";
import { readNumberEnvValue } from "../tests/bench/harness/env.js";
import {
  browserConvexDir,
  browserDistPath,
  convexBrowserPath,
  convexPath,
  convexServerPath,
  convexValuesPath,
  hostedRemoteUrl,
} from "../tests/bench/harness/paths.js";
import { browserCommands } from "../tests/browser/harness/commands.js";
import { browserRuntimeLog } from "../tests/browser/harness/log.js";

export const browserProject = {
  define: {
    __CONVEX_EMBEDDED_BROWSER_BENCH__: JSON.stringify(process.env.EMBEDDED_BROWSER_BENCH === "1"),
    __CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__: JSON.stringify(
      readNumberEnvValue("EMBEDDED_BROWSER_BENCH_ITERATIONS", 10),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__: JSON.stringify(process.env.EMBEDDED_BROWSER_BENCH_OUT),
    __CONVEX_EMBEDDED_BROWSER_BENCH_PROFILE__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_PROFILE ?? "smoke",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_ROWS__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_ROWS ?? "0,10,100,1000",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_STARTUP__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_STARTUP === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_REMOTE__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_REMOTE === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_SCALE === "1",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_CLIENTS__: JSON.stringify(
      readNumberEnvValue("EMBEDDED_BROWSER_BENCH_CLIENTS", 2),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_DURATION_MS__: JSON.stringify(
      readNumberEnvValue("EMBEDDED_BROWSER_BENCH_DURATION_MS", 250),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_SCALE_ROWS__: JSON.stringify(
      readNumberEnvValue("EMBEDDED_BROWSER_BENCH_SCALE_ROWS", 1_000),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_TIMEOUT_MS__: JSON.stringify(
      Math.min(300_000, readNumberEnvValue("EMBEDDED_BROWSER_BENCH_TIMEOUT_MS", 300_000)),
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_TABS__: JSON.stringify(
      process.env.EMBEDDED_BROWSER_BENCH_TABS ?? "one,two",
    ),
    __CONVEX_EMBEDDED_BROWSER_BENCH_WARMUPS__: JSON.stringify(
      readNumberEnvValue("EMBEDDED_BROWSER_BENCH_WARMUPS", 3),
    ),
    __CONVEX_EMBEDDED_HOSTED_URL__: JSON.stringify(hostedRemoteUrl ?? null),
  },
  plugins: [convexEmbedded({ convexDir: browserConvexDir }), browserRuntimeLog()],
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
      { find: "@convex-dev/embedded/browser", replacement: browserDistPath },
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
      "tests/browser/memory.ts",
      "tests/browser/protocol.ts",
      "tests/browser/runtime.ts",
      "tests/bench/browser/remote.ts",
      "tests/bench/browser/scale.ts",
    ],
    name: "browser",
    testTimeout: 30_000,
  },
} satisfies TestProjectInlineConfiguration;
