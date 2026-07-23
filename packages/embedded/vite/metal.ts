import { playwright } from "vite-plus/test/browser/providers/playwright";
import type { TestProjectInlineConfiguration } from "vitest/config";

import { metalBench } from "../../../config/bench.js";
import { convexEmbedded } from "../src/vite.js";
import { metalCommands } from "../tests/bench/harness/commands.js";
import {
  browserDistPath,
  convexBrowserPath,
  convexPath,
  convexServerPath,
  convexValuesPath,
  hostedDeployment,
  hostedRemoteUrl,
  metalConvexDir,
} from "../tests/bench/harness/paths.js";
import { browserRuntimeLog } from "../tests/browser/harness/log.js";
import schema from "../tests/metal/convex/schema.js";

const bench = metalBench();

export const metalProject = {
  test: {
    browser: {
      commands: metalCommands,
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright() as never,
    },
    include: ["tests/metal/metal.ts", "tests/metal/reconnect.ts", "tests/metal/scale.ts"],
    name: "metal",
    testTimeout: 120_000,
  },
  define: {
    __CONVEX_EMBEDDED_HOSTED_URL__: JSON.stringify(hostedRemoteUrl ?? null),
    __CONVEX_EMBEDDED_METAL_BENCH_SCALE__: JSON.stringify(
      process.env.EMBEDDED_METAL_BENCH_SCALE === "1",
    ),
    __CONVEX_EMBEDDED_METAL_BENCH_RECONNECT_VOLUME__: JSON.stringify(
      process.env.EMBEDDED_METAL_BENCH_RECONNECT_VOLUME === "1",
    ),
    __CONVEX_EMBEDDED_METAL_BENCH_CLIENTS__: JSON.stringify(bench.clients),
    __CONVEX_EMBEDDED_METAL_BENCH_DEPLOYMENT__: JSON.stringify(
      process.env.EMBEDDED_METAL_BENCH_DEPLOYMENT ?? hostedDeployment ?? null,
    ),
    __CONVEX_EMBEDDED_METAL_BENCH_WRITES__: JSON.stringify(bench.writes),
    __CONVEX_EMBEDDED_METAL_BENCH_OUT__: JSON.stringify(process.env.EMBEDDED_METAL_BENCH_OUT),
    __CONVEX_EMBEDDED_METAL_BENCH_REVS__: JSON.stringify(bench.scaleRevs),
    __CONVEX_EMBEDDED_METAL_BENCH_SKIP_REV_LIST__: JSON.stringify(
      process.env.EMBEDDED_METAL_BENCH_SKIP_REV_LIST === "1",
    ),
    __CONVEX_EMBEDDED_METAL_BENCH_TIMEOUT_MS__: JSON.stringify(Math.min(300_000, bench.timeoutMs)),
  },
  plugins: [convexEmbedded({ convexDir: metalConvexDir, schema }), browserRuntimeLog()],
  resolve: {
    alias: [
      { find: "@convex-dev/embedded/browser", replacement: browserDistPath },
      { find: "convex/browser", replacement: convexBrowserPath },
      { find: "convex/server", replacement: convexServerPath },
      { find: "convex/values", replacement: convexValuesPath },
      { find: "convex", replacement: convexPath },
    ],
  },
} satisfies TestProjectInlineConfiguration;
