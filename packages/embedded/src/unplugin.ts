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
 * import schema from "./convex/schema";
 *
 * export default {
 *   plugins: [convexEmbeddedUnplugin.rollup({ schema })],
 * };
 * ```
 *
 * @packageDocumentation
 */
import path from "node:path";

import { createUnplugin, type UnpluginInstance } from "unplugin";

import { generateEmbedded, readLocalExportNames, type EmbeddedBundleInput } from "./bundler";
import { analyzeEmbeddedSchema, type ConvexEmbeddedSchema } from "./schema";
import {
  fromVirtualSourceId,
  renderEmbeddedBundle,
  renderEmbeddedIdentity,
  renderLocalStamp,
  VIRTUAL_IDENTITY_MODULE_ID,
  VIRTUAL_MODULE_ID,
  VIRTUAL_SOURCE_MODULE_PREFIX,
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
export interface ConvexEmbeddedPluginOptions extends Omit<
  EmbeddedBundleInput,
  "analysis" | "root"
> {
  /**
   * Disable the plugin. Useful when composing framework configs conditionally.
   *
   * @defaultValue `false`
   */
  disabled?: boolean;

  /** Schema value imported by the bundler config to generate the literal device contract. */
  schema: ConvexEmbeddedSchema;
}

/**
 * Supported unplugin adapter methods exposed by the embedded Convex plugin.
 *
 * @public
 */
export type ConvexEmbeddedUnplugin = Pick<
  UnpluginInstance<ConvexEmbeddedPluginOptions>,
  "esbuild" | "rollup" | "rolldown" | "rspack" | "vite" | "webpack"
>;

const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const RESOLVED_VIRTUAL_IDENTITY_MODULE_ID = `\0${VIRTUAL_IDENTITY_MODULE_ID}`;
const DEFAULT_CONVEX_DIR = "convex";
const DEFAULT_SCHEMA_PATH = "schema.ts";
const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;
const COMMONJS_EXTENSIONS = /\.c[jt]s$/;

/** Everything the plugin hooks read, resolved once per scan of the Convex and device sources. */
interface EmbeddedGeneration {
  files: Set<string>;
  graphHash: string;
  identity: string;
  localIds: Map<string, string>;
  registry: string;
}

interface EmbeddedProjectRoots {
  convex: string;
  local: string[];
  localPrefixes: string[];
}

/**
 * Vite builds the page and the worker with separate plugin instances created from one options
 * object. Keying the generation by that object gives both instances the same scan and the same
 * lockfile write.
 */
const generations = new WeakMap<
  ConvexEmbeddedPluginOptions,
  { current?: EmbeddedGeneration; root: string; scan?: Promise<EmbeddedGeneration> }
>();

const unplugin = createUnplugin((options: ConvexEmbeddedPluginOptions) => {
  if (options?.schema === undefined) {
    throw new Error(
      "convexEmbedded requires the schema option so its generated contract is current",
    );
  }
  let shared = generations.get(options);
  if (shared === undefined) {
    shared = { root: process.cwd() };
    generations.set(options, shared);
  }
  const state = shared;
  let roots: EmbeddedProjectRoots | undefined;

  const setRoot = (value: string): void => {
    if (state.root === value) return;
    state.root = value;
    state.current = undefined;
    state.scan = undefined;
    roots = undefined;
  };
  const projectRoots = (): EmbeddedProjectRoots => {
    if (roots !== undefined) return roots;
    const local =
      options.local === undefined
        ? []
        : (Array.isArray(options.local) ? options.local : [options.local]).map((dir) =>
            path.resolve(state.root, dir),
          );
    roots = {
      convex: path.resolve(state.root, options.convexDir ?? DEFAULT_CONVEX_DIR),
      local,
      localPrefixes: local.map((dir) => `${dir}${path.sep}`),
    };
    return roots;
  };
  const generation = (): Promise<EmbeddedGeneration> => {
    state.scan ??= generateEmbedded({
      analysis: analyzeEmbeddedSchema(options.schema),
      convexDir: options.convexDir,
      generatedPath: options.generatedPath,
      local: options.local,
      registerSchema: options.registerSchema,
      root: state.root,
      schemaPath: options.schemaPath,
    }).then(({ bundle }) => {
      state.current = {
        files: new Set(
          [bundle.schemaPath, ...bundle.sourceFiles].map((file) => path.normalize(file)),
        ),
        graphHash: bundle.moduleGraphHash,
        identity: renderEmbeddedIdentity(bundle),
        localIds: new Map(
          Object.entries(bundle.localModules).map(([moduleId, module]) => [
            path.normalize(module.file),
            moduleId,
          ]),
        ),
        registry: renderEmbeddedBundle(bundle),
      };
      return state.current;
    });
    return state.scan;
  };
  /** Keeps every hook synchronous once the scan this build already started has landed. */
  const withGeneration = <T>(use: (current: EmbeddedGeneration) => T): T | Promise<T> =>
    state.current === undefined ? generation().then(use) : use(state.current);

  return {
    name: "convex-embedded",
    enforce: "pre" as const,

    /** Scans while the bundler starts so the first device module never waits on it. */
    buildStart() {
      if (options.disabled) return;
      generation().catch(() => {});
    },

    resolveId(id, importer) {
      if (options.disabled) return null;
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
      if (id === VIRTUAL_IDENTITY_MODULE_ID) return RESOLVED_VIRTUAL_IDENTITY_MODULE_ID;
      if (id.startsWith(VIRTUAL_SOURCE_MODULE_PREFIX)) {
        const sourcePath = fromVirtualSourceId(id);
        if (sourcePath === undefined) return null;
        return withGeneration((current) => (current.files.has(sourcePath) ? sourcePath : null));
      }
      if (
        importer !== RESOLVED_VIRTUAL_MODULE_ID &&
        importer !== RESOLVED_VIRTUAL_IDENTITY_MODULE_ID
      ) {
        return null;
      }
      const { convex, local } = projectRoots();
      const directory = path.resolve(id);
      if (directory !== convex && !local.includes(directory)) return null;
      return path.resolve(convex, options.schemaPath ?? DEFAULT_SCHEMA_PATH);
    },

    load(this: { addWatchFile?: (id: string) => void }, id) {
      if (options.disabled) return null;
      if (id !== RESOLVED_VIRTUAL_MODULE_ID && id !== RESOLVED_VIRTUAL_IDENTITY_MODULE_ID) {
        return null;
      }
      const addWatchFile = this.addWatchFile?.bind(this);
      return withGeneration((current) => {
        const { convex, local } = projectRoots();
        addWatchFile?.(convex);
        for (const dir of local) addWatchFile?.(dir);
        for (const file of current.files) addWatchFile?.(file);
        return id === RESOLVED_VIRTUAL_MODULE_ID ? current.registry : current.identity;
      });
    },

    transformInclude(id) {
      if (options.disabled) return false;
      const { localPrefixes } = projectRoots();
      if (localPrefixes.length === 0) return false;
      const file = path.normalize(id.split("?")[0]!);
      if (COMMONJS_EXTENSIONS.test(file)) return false;
      return localPrefixes.some((prefix) => file.startsWith(prefix));
    },

    transform(code, id) {
      const file = path.normalize(id.split("?")[0]!);
      return withGeneration((current) => {
        const moduleId = current.localIds.get(file);
        if (moduleId === undefined) return null;
        const stamp = renderLocalStamp(
          moduleId,
          current.graphHash,
          code,
          readLocalExportNames(code),
        );
        return stamp === "" ? null : { code: `${code}${stamp}`, map: null };
      });
    },

    vite: {
      configResolved(config) {
        setRoot(config.root);
      },
      configureServer(server) {
        if (options.disabled) return;
        const { convex, local } = projectRoots();
        server.watcher.add(convex);
        for (const dir of local) server.watcher.add(dir);
      },
      handleHotUpdate(ctx) {
        const { convex, local } = projectRoots();
        if (
          options.disabled ||
          (!isPluginSource(ctx.file, convex) &&
            !local.some((dir) => isPluginSource(ctx.file, dir)) &&
            state.current?.files.has(path.normalize(ctx.file)) !== true)
        ) {
          return;
        }
        state.current = undefined;
        state.scan = undefined;
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
      setRoot(compiler.context || state.root);
    },

    rspack(compiler) {
      setRoot(compiler.context || state.root);
    },
  };
});

/**
 * Unplugin instance for embedded Convex module discovery.
 *
 * @remarks
 * Call the adapter method for the bundler you are integrating with, such as
 * `convexEmbeddedUnplugin.rollup({ schema })` or
 * `convexEmbeddedUnplugin.webpack({ schema })`.
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

function isPluginSource(file: string, dir: string): boolean {
  const resolved = path.resolve(file);
  if (!isInside(resolved, dir)) return false;
  if (!TS_EXTENSIONS.test(resolved)) return false;
  if (/\.d\.(?:ts|mts|cts)$/.test(resolved)) return false;
  return path
    .relative(dir, resolved)
    .split(path.sep)
    .every((part) => part !== "_generated");
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
