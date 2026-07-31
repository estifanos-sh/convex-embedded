import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import solid from "vite-plugin-solid";
import { defineConfig } from "vite-plus/pack";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const main = defineConfig({
  define: { __EMBEDDED_PACKAGE_VERSION__: JSON.stringify(version) },
  plugins: [solid()],
  entry: {
    bundler: "src/bundler/index.ts",
    "browser-embedded": "src/browser/embedded.ts",
    browser: "src/browser/index.ts",
    "component/crdt": "src/component/crdt.ts",
    "component/crdt/checkpoint": "src/component/crdt/checkpoint.ts",
    "component/crdt/field": "src/component/crdt/field.ts",
    "component/crdt/payload": "src/component/crdt/payload.ts",
    "component/convex.config": "src/component/convex.config.ts",
    "component/_generated/component": "src/component/_generated/component.ts",
    "component/file": "src/component/file.ts",
    "component/mutation": "src/component/mutation.ts",
    "component/protocol": "src/component/protocol.ts",
    "component/remote/client": "src/component/remote/client.ts",
    "component/rev": "src/component/rev.ts",
    "component/schema": "src/component/schema.ts",
    "devtools/index": "src/devtools/index.ts",
    "devtools/vite": "src/devtools/vite.ts",
    "expo/index": "src/expo/index.ts",
    "internal/client": "src/client.ts",
    "internal/storage": "src/storage/binding.ts",
    local: "src/local.ts",
    migrations: "src/migrations.ts",
    node: "src/node/index.ts",
    schema: "src/tables.ts",
    server: "src/server/index.ts",
    "internal/text": "src/text/field.ts",
    unplugin: "src/unplugin.ts",
    values: "src/values.ts",
    vite: "src/vite.ts",
  },
  format: "esm",
  dts: true,
  // Clean only the JS/types this config emits plus stale native artifacts from the old root package
  // layout. `dist/wasm` is produced by the separate wasm script and must survive `vp pack`.
  clean: [
    "dist/*.mjs",
    "dist/*.mts",
    "dist/*.d.mts",
    "dist/*.d.ts",
    "dist/*.map",
    "dist/component/*.mjs",
    "dist/component/*.js",
    "dist/component/*.d.mts",
    "dist/component/*.d.ts",
    "dist/component/*.map",
    "dist/component/_generated/*.mjs",
    "dist/component/_generated/*.d.mts",
    "dist/component/_generated/*.map",
    "dist/devtools/*.mjs",
    "dist/devtools/*.d.mts",
    "dist/devtools/*.map",
    "dist/expo/*.mjs",
    "dist/expo/*.d.mts",
    "dist/expo/*.map",
    "dist/internal/*.mjs",
    "dist/internal/*.d.mts",
    "dist/internal/*.map",
  ],
  hooks: {
    "build:done": () => {
      const componentConfig = new URL("./dist/component/convex.config.mjs", import.meta.url);
      if (existsSync(componentConfig)) {
        copyFileSync(
          componentConfig,
          new URL("./dist/component/convex.config.js", import.meta.url),
        );
      }
      const componentSchema = new URL("./dist/component/schema.mjs", import.meta.url);
      if (existsSync(componentSchema)) {
        copyFileSync(componentSchema, new URL("./dist/component/schema.js", import.meta.url));
        unlinkSync(componentSchema);
      }
      for (const file of [
        "crdt",
        "crdt/checkpoint",
        "crdt/field",
        "crdt/payload",
        "file",
        "mutation",
        "protocol",
        "remote/client",
        "rev",
      ]) {
        const source = new URL(`./dist/component/${file}.mjs`, import.meta.url);
        if (!existsSync(source)) continue;
        copyFileSync(source, new URL(`./dist/component/${file}.js`, import.meta.url));
        unlinkSync(source);
      }
      const dist = new URL("./dist/", import.meta.url);
      for (const entry of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
        const path = new URL(entry, dist);
        const source = readFileSync(path, "utf8");
        const rewritten = [
          "schema",
          "crdt",
          "crdt/checkpoint",
          "crdt/field",
          "crdt/payload",
          "file",
          "mutation",
          "protocol",
          "remote/client",
          "rev",
        ].reduce(
          (contents, file) =>
            contents.replaceAll(`./component/${file}.mjs`, `./component/${file}.js`),
          source,
        );
        if (rewritten !== source) writeFileSync(path, rewritten);
      }
      for (const file of ["api.mjs", "api.d.mts"]) {
        const path = new URL(`./dist/component/${file}`, import.meta.url);
        if (!existsSync(path)) continue;
        const source = readFileSync(path, "utf8");
        writeFileSync(path, source.replaceAll("./schema.mjs", "./schema.js"));
      }
    },
  },
  deps: {
    neverBundle: [
      "virtual:convex-embedded",
      "virtual:convex-embedded/identity",
      "expo",
      "expo-crypto",
      "@tanstack/devtools",
      "@tanstack/devtools-vite",
      "solid-js",
      "solid-js/web",
      "solid-js/store",
    ],
  },
});

const metro = defineConfig({
  clean: false,
  dts: true,
  entry: { metro: "src/metro.ts" },
  format: ["esm", "cjs"],
  target: "node20.19",
  deps: { neverBundle: ["unplugin"] },
});

// Config files commonly execute through CommonJS even in ESM applications. Keep the public ESM
// entries in `main`, and emit matching require targets for schemas imported by those configs.
const config = defineConfig({
  clean: false,
  dts: true,
  entry: {
    schema: "src/tables.ts",
    values: "src/values.ts",
  },
  format: "cjs",
  target: "node20.19",
});

const thread = defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
  dts: false,
  entry: { "browser-worker": "src/browser/worker.ts" },
  format: "esm",
  outDir: "dist/thread",
});

export default defineConfig([main, config, metro, thread]);
