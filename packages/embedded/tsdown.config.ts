import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node/index.ts" },
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@tursodatabase\//] },
});
