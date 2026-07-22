import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { embeddedDevtools } from "@convex-dev/embedded/devtools/vite";
import schema from "../../../convex/schema";
import {
  embeddedCompatiblePriorRuntimes,
  embeddedGeneratedPath,
  requireDeploymentUrl,
} from "../../deployment";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const convexDir = fileURLToPath(new URL("../../../convex", import.meta.url));
const embeddedViteEntry = fileURLToPath(
  new URL("../../../packages/embedded/dist/vite.mjs", import.meta.url),
);
const embeddedDistDir = fileURLToPath(new URL("../../../packages/embedded/dist/", import.meta.url));
const embeddedDistPrefix = `${resolve(embeddedDistDir)}${sep}`;

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

/** Restart Vite when this monorepo's package watcher replaces the loaded plugin implementation. */
function watchEmbeddedWorkspaceBuild(): Plugin {
  return {
    name: "convex-embedded-demo:watch-package",
    apply: "serve",
    configureServer(server) {
      let restarting = false;
      const restartForPackageBuild = (file: string) => {
        const resolved = resolve(file);
        if (
          restarting ||
          (resolved !== resolve(embeddedViteEntry) &&
            (!resolved.startsWith(embeddedDistPrefix) || !resolved.endsWith(".mjs")))
        ) {
          return;
        }
        restarting = true;
        queueMicrotask(() => void server.restart());
      };
      server.watcher.add([embeddedViteEntry, embeddedDistDir]);
      server.watcher.on("change", restartForPackageBuild);
      server.httpServer?.once("close", () => {
        server.watcher.off("change", restartForPackageBuild);
      });
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

export default defineConfig(async () => {
  const convexUrl = requireDeploymentUrl(repoRoot);
  // Vite externalizes workspace packages while loading config. A plain package
  // import therefore remains in Node's ESM cache across an in-process server
  // restart, even after the package watcher replaces its hashed chunks. The
  // build timestamp makes each config reload import the current package entry.
  const embeddedViteUrl = pathToFileURL(embeddedViteEntry);
  embeddedViteUrl.searchParams.set("build", String(statSync(embeddedViteEntry).mtimeMs));
  const { convexEmbedded } = (await import(
    embeddedViteUrl.href
  )) as typeof import("@convex-dev/embedded/vite");

  return {
    define: {
      __CONVEX_EMBEDDED_CONVEX_URL__: JSON.stringify(convexUrl),
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
    server: {
      watch: {
        // This file is an output of the Embedded plugin. Schema and function
        // sources already invalidate the virtual modules that consume it.
        ignored: [resolve(convexDir, embeddedGeneratedPath)],
      },
    },
    plugins: [
      watchEmbeddedWorkspaceBuild(),
      react(),
      tailwindcss(),
      convexEmbedded({
        compatiblePriorRuntimes: embeddedCompatiblePriorRuntimes,
        convexDir,
        generatedPath: embeddedGeneratedPath,
        schema,
      }),
      embeddedDevtools(),
      preloadRuntimeAssets(),
      precompressAssets(),
    ],
  };
});
