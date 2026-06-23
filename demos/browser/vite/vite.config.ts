import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { embeddedDevtools } from "@convex-dev/embedded/devtools/vite";
import { convexEmbedded } from "@convex-dev/embedded/vite";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const convexDir = fileURLToPath(new URL("../../../convex", import.meta.url));

const COMPRESSIBLE = /\.(?:js|mjs|css|html|json|wasm|svg|txt|map|xml|webmanifest)$/i;
const COMPRESSION_FLOOR = 1024;

function precompressAssets(): Plugin {
  return {
    name: "convex-embedded-demo:precompress",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      for (const file of walk(dir)) {
        if (!COMPRESSIBLE.test(file)) continue;
        const raw = readFileSync(file);
        if (raw.byteLength < COMPRESSION_FLOOR) continue;
        const brotli = brotliCompressSync(raw, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
          },
        });
        writeFileSync(`${file}.br`, brotli);
        writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
      }
    },
  };
}

function preloadRuntimeAssets(): Plugin {
  return {
    name: "convex-embedded-demo:preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const keys = Object.keys(bundle);
        const worker = keys.find((key) => /(?:^|\/)browser-worker-[^/]*\.mjs$/.test(key));
        const wasm = keys.find((key) => /(?:^|\/)index-[^/]*\.wasm$/.test(key));
        const tags = [];
        if (worker) {
          tags.push({
            tag: "link",
            attrs: { rel: "modulepreload", href: `/${worker}` },
            injectTo: "head" as const,
          });
        }
        if (wasm) {
          tags.push({
            tag: "link",
            attrs: {
              rel: "preload",
              as: "fetch",
              crossorigin: "",
              href: `/${wasm}`,
            },
            injectTo: "head" as const,
          });
        }
        return { html, tags };
      },
    },
  };
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, ["CONVEX_URL", "VITE_CONVEX_URL"]);
  const convexUrl = command === "serve" ? (env.VITE_CONVEX_URL || env.CONVEX_URL || "").trim() : "";

  return {
    define: {
      __CONVEX_EMBEDDED_CONVEX_URL__: JSON.stringify(convexUrl || null),
    },
    optimizeDeps: {
      exclude: [
        "@convex-dev/embedded/browser",
        "@convex-dev/embedded/devtools",
        "@convex-dev/embedded/devtools/vite",
        "@convex-dev/embedded/vite",
      ],
    },
    resolve: {
      alias: {
        "~convex": convexDir,
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      convexEmbedded({ convexDir }),
      embeddedDevtools(),
      preloadRuntimeAssets(),
      precompressAssets(),
    ],
  };
});
