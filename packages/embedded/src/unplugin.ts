/**
 * Unplugin adapter for embedded Convex browser builds.
 *
 * @remarks
 * Use this entrypoint when integrating with bundlers through unplugin directly.
 * Vite/Vite+ users should prefer `@convex-dev/embedded/vite`, which also
 * installs the headers required by the browser WASM storage backend.
 *
 * @example
 * ```ts
 * import { convexEmbeddedUnplugin } from "@convex-dev/embedded/unplugin";
 *
 * export default {
 *   plugins: [convexEmbeddedUnplugin.rollup()],
 * };
 * ```
 *
 * @packageDocumentation
 */
import path from "node:path";

import { createUnplugin, type UnpluginInstance } from "unplugin";

import {
  createEmbeddedBundle,
  type EmbeddedBundleInput,
  type EmbeddedBundleResult,
} from "./bundler";
import {
  fromVirtualSourceId,
  renderEmbeddedBundle,
  renderEmbeddedIdentity,
  VIRTUAL_IDENTITY_MODULE_ID,
  VIRTUAL_MODULE_ID,
} from "./bundler/virtual";

/**
 * Options for embedded Convex bundler adapters.
 *
 * @remarks
 * `convexDir` and `schemaPath` are resolved by the bundler adapter relative to
 * the bundler project root.
 *
 * @public
 */
export interface ConvexEmbeddedPluginOptions extends Omit<EmbeddedBundleInput, "root"> {
  /**
   * Disable the plugin. Useful when composing framework configs conditionally.
   *
   * @defaultValue `false`
   */
  disabled?: boolean;
}

/**
 * Supported unplugin adapter methods exposed by the embedded Convex plugin.
 *
 * @public
 */
export type ConvexEmbeddedUnplugin = Pick<
  UnpluginInstance<ConvexEmbeddedPluginOptions | undefined>,
  "esbuild" | "rollup" | "rolldown" | "rspack" | "vite" | "webpack"
>;

const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const RESOLVED_VIRTUAL_IDENTITY_MODULE_ID = `\0${VIRTUAL_IDENTITY_MODULE_ID}`;
const DEFAULT_CONVEX_DIR = "convex";
const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;

const unplugin = createUnplugin((rawOptions?: ConvexEmbeddedPluginOptions) => {
  const options = rawOptions ?? {};
  let root = process.cwd();

  const convexRoot = (): string => path.resolve(root, options.convexDir ?? DEFAULT_CONVEX_DIR);

  return {
    name: "convex-embedded",
    enforce: "pre" as const,

    async resolveId(id, importer) {
      if (options.disabled) return null;
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
      if (id === VIRTUAL_IDENTITY_MODULE_ID) return RESOLVED_VIRTUAL_IDENTITY_MODULE_ID;
      const sourcePath = fromVirtualSourceId(id);
      if (sourcePath !== undefined) {
        const allowed = await sourceFiles({
          convexDir: options.convexDir,
          root,
          schemaPath: options.schemaPath,
        });
        return allowed.has(sourcePath) ? sourcePath : null;
      }
      if (
        (importer === RESOLVED_VIRTUAL_MODULE_ID ||
          importer === RESOLVED_VIRTUAL_IDENTITY_MODULE_ID) &&
        path.resolve(id) === convexRoot()
      ) {
        return path.resolve(convexRoot(), options.schemaPath ?? "schema.ts");
      }
      return null;
    },

    async load(this: { addWatchFile?: (id: string) => void }, id) {
      if (options.disabled) return null;
      if (id !== RESOLVED_VIRTUAL_MODULE_ID && id !== RESOLVED_VIRTUAL_IDENTITY_MODULE_ID) {
        return null;
      }
      const bundle = await createEmbeddedBundle({
        convexDir: options.convexDir,
        root,
        schemaPath: options.schemaPath,
      });
      this.addWatchFile?.(convexRoot());
      for (const file of watchFiles(bundle)) this.addWatchFile?.(file);
      if (id === RESOLVED_VIRTUAL_MODULE_ID) return renderEmbeddedBundle(bundle);
      if (id === RESOLVED_VIRTUAL_IDENTITY_MODULE_ID) return renderEmbeddedIdentity(bundle);
      return null;
    },

    vite: {
      configResolved(config) {
        root = config.root;
      },
      configureServer(server) {
        if (!options.disabled) server.watcher.add(convexRoot());
      },
      handleHotUpdate(ctx) {
        if (options.disabled || !isConvexSource(ctx.file, convexRoot())) return;
        const virtualModule = ctx.server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
        const identityModule = ctx.server.moduleGraph.getModuleById(
          RESOLVED_VIRTUAL_IDENTITY_MODULE_ID,
        );
        const invalidated = [virtualModule, identityModule].filter(
          (module) => module !== undefined,
        );
        for (const module of invalidated) ctx.server.moduleGraph.invalidateModule(module);
        return invalidated.length ? [...ctx.modules, ...invalidated] : undefined;
      },
    },

    webpack(compiler) {
      root = compiler.context || root;
    },

    rspack(compiler) {
      root = compiler.context || root;
    },
  };
});

/**
 * Unplugin instance for embedded Convex module discovery.
 *
 * @remarks
 * Call the adapter method for the bundler you are integrating with, such as
 * `convexEmbeddedUnplugin.rollup()` or `convexEmbeddedUnplugin.webpack()`.
 *
 * @public
 */
export const convexEmbeddedUnplugin = unplugin as ConvexEmbeddedUnplugin;

/**
 * Alias for {@link convexEmbeddedUnplugin}.
 *
 * @public
 */
export const convexEmbedded = convexEmbeddedUnplugin;
export default convexEmbeddedUnplugin;

function watchFiles(bundle: EmbeddedBundleResult): string[] {
  return [bundle.schemaPath, ...Object.values(bundle.modules)];
}

async function sourceFiles(input: EmbeddedBundleInput): Promise<Set<string>> {
  const bundle = await createEmbeddedBundle(input);
  return new Set(watchFiles(bundle).map((file) => path.normalize(file)));
}

function isConvexSource(file: string, convexDir: string): boolean {
  const resolved = path.resolve(file);
  if (!isInside(resolved, convexDir)) return false;
  if (!TS_EXTENSIONS.test(resolved)) return false;
  if (/\.d\.(?:ts|mts|cts)$/.test(resolved)) return false;
  return path
    .relative(convexDir, resolved)
    .split(path.sep)
    .every((part) => part !== "_generated");
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
