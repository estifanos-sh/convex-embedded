import { playwright } from "vite-plus/test/browser/providers/playwright";
import type { TestProjectInlineConfiguration } from "vitest/config";

import { convexEmbedded } from "../src/vite.js";
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
import schema from "../tests/fixture/convex/schema.js";

export const webkitProject = {
  define: {
    __CONVEX_EMBEDDED_HOSTED_URL__: JSON.stringify(hostedRemoteUrl ?? null),
  },
  optimizeDeps: {
    include: ["convex-helpers/server/pagination", "convex/browser", "convex/server"],
  },
  plugins: [convexEmbedded({ convexDir: browserConvexDir, schema }), browserRuntimeLog()],
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
      instances: [{ browser: "webkit" }],
      provider: playwright({
        persistentContext: "node_modules/.cache/webkit-userdata",
      }) as never,
    },
    fileParallelism: false,
    include: ["tests/browser/protocol.ts", "tests/browser/webkit.ts"],
    name: "webkit",
    testTimeout: 70_000,
  },
} satisfies TestProjectInlineConfiguration;
