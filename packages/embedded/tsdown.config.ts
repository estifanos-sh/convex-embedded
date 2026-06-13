import { readFileSync } from "node:fs";

import { defineConfig } from "vite-plus/pack";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __EMBEDDED_PACKAGE_VERSION__: JSON.stringify(version) },
  entry: {
    bundler: "src/bundler/index.ts",
    "browser-embedded": "src/browser/embedded.ts",
    browser: "src/browser/index.ts",
    "browser-worker": "src/browser/worker.ts",
    node: "src/node/index.ts",
    unplugin: "src/unplugin.ts",
    vite: "src/vite.ts",
  },
  format: "esm",
  dts: true,
  // Clean only the bundled JS/types this config emits (top-level dist files). `dist/native` and
  // `dist/wasm` are produced by the separate `native`/`wasm` scripts; a blanket clean would wipe
  // them on every `vp pack`/`dev` rebuild.
  clean: ["dist/*.mjs", "dist/*.mts", "dist/*.d.mts", "dist/*.d.ts", "dist/*.map"],
  deps: {
    neverBundle: ["virtual:convex-embedded", "virtual:convex-embedded/identity"],
  },
});
