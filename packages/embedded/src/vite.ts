/**
 * Vite and Vite+ adapter for embedded Convex browser builds.
 *
 * @remarks
 * The adapter registers generated Convex virtual modules and configures the
 * cross-origin isolation headers required by the browser WASM storage backend.
 *
 * @example
 * ```ts
 * import { defineConfig } from "vite";
 * import convexEmbedded from "@estifanos-sh/convex-embedded/vite";
 * import schema from "./convex/schema";
 *
 * export default defineConfig({
 *   plugins: [convexEmbedded({ schema })],
 * });
 * ```
 *
 * @packageDocumentation
 */
import { convexEmbeddedUnplugin } from "./unplugin";
import type { ConvexEmbeddedPluginOptions } from "./unplugin";

export type { ConvexEmbeddedPluginOptions };

type VitePlugin = {
  config?: () => Record<string, unknown>;
  name: string;
  transformIndexHtml?: {
    handler: () => Array<{
      children: string;
      injectTo: "head-prepend";
      tag: "script";
    }>;
    order: "pre";
  };
};

/**
 * Vite/Vite+ adapter for embedded Convex module discovery.
 *
 * @param options - Embedded schema plus optional Convex paths and disable flag.
 * @returns Vite plugins/config entries for the main build and worker build.
 *
 * @public
 */
export function convexEmbedded(options: ConvexEmbeddedPluginOptions): VitePlugin[] {
  return [
    convexEmbeddedViteConfig(options),
    convexEmbeddedUnplugin.vite(options) as unknown as VitePlugin,
  ];
}

export default convexEmbedded;

function convexEmbeddedViteConfig(options: ConvexEmbeddedPluginOptions): VitePlugin {
  return {
    name: "convex-embedded:vite-config",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          children: "window.__convexAllowFunctionsInBrowser = true;",
          injectTo: "head-prepend",
          tag: "script",
        },
      ],
    },
    config() {
      return {
        optimizeDeps: {
          exclude: ["@estifanos-sh/convex-embedded", "@estifanos-sh/convex-embedded/browser"],
          include: ["@napi-rs/wasm-runtime", "convex", "convex/server", "convex/values"],
        },
        worker: {
          plugins: () => [convexEmbeddedUnplugin.vite(options)],
        },
        server: {
          headers: crossOriginIsolationHeaders(),
        },
        preview: {
          headers: crossOriginIsolationHeaders(),
        },
      };
    },
  };
}

function crossOriginIsolationHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
