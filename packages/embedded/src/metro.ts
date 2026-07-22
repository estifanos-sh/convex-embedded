/**
 * Metro adapter for embedded Convex application modules.
 *
 * @remarks
 * Metro does not expose virtual modules, so this adapter materializes the
 * generated registry in its project cache and resolves the virtual imports to
 * those files. The returned promise can be exported directly from
 * `metro.config.js`.
 *
 * @example
 * ```js
 * const { getDefaultConfig } = require("expo/metro-config");
 * const { withConvexEmbedded } = require("@convex-dev/embedded/metro");
 *
 * module.exports = withConvexEmbedded(getDefaultConfig(__dirname));
 * ```
 *
 * @packageDocumentation
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createEmbeddedBundle,
  generateEmbedded,
  type EmbeddedBundleInput,
  type EmbeddedCompatibleRuntimeIdentity,
} from "./bundler";
import {
  fromVirtualSourceId,
  renderEmbeddedBundle,
  renderEmbeddedIdentity,
  VIRTUAL_IDENTITY_MODULE_ID,
  VIRTUAL_MODULE_ID,
  VIRTUAL_SOURCE_MODULE_PREFIX,
} from "./bundler/virtual";
import { analyzeEmbeddedSchema, type ConvexEmbeddedSchema } from "./schema";

/** Options for {@link withConvexEmbedded}. @public */
export interface ConvexEmbeddedMetroOptions extends Omit<EmbeddedBundleInput, "root"> {
  /** Exact reviewed prior runtime identities whose durable mutations this build may replay. */
  compatiblePriorRuntimes?: readonly EmbeddedCompatibleRuntimeIdentity[];
  /** Disable generation and return the original Metro configuration unchanged. */
  disabled?: boolean;
  /** Project root. Defaults to Metro's `projectRoot`, then `process.cwd()`. */
  root?: string;
  /** Live schema used to generate and validate the literal device contract. */
  schema?: ConvexEmbeddedSchema;
}

interface MetroResolverContext {
  resolveRequest(
    context: MetroResolverContext,
    moduleName: string,
    platform: string | null,
  ): unknown;
}

type MetroResolveRequest = (
  context: MetroResolverContext,
  moduleName: string,
  platform: string | null,
) => unknown;

interface MetroConfigShape {
  projectRoot?: string;
  resolver?: {
    resolveRequest?: MetroResolveRequest;
    [key: string]: unknown;
  };
}

/**
 * Adds embedded Convex module generation and resolution to a Metro config.
 *
 * @remarks
 * Existing resolver customizations are preserved and receive every unrelated
 * request. Encoded source requests are limited to the files discovered in the
 * Convex module graph. Passing `schema` regenerates the device contract before
 * validation; otherwise a current generated contract must already exist. Restart
 * Metro after changing the schema or any device function source so its registry
 * and identity are regenerated.
 *
 * @public
 */
export async function withConvexEmbedded<Config extends object>(
  config: Config,
  options: ConvexEmbeddedMetroOptions = {},
): Promise<Config> {
  if (options.disabled) return config;

  const current = config as Config & MetroConfigShape;
  const root = path.resolve(options.root ?? current.projectRoot ?? process.cwd());
  if (options.schema !== undefined) {
    await generateEmbedded({
      analysis: analyzeEmbeddedSchema(options.schema),
      convexDir: options.convexDir,
      generatedPath: options.generatedPath,
      root,
      schemaPath: options.schemaPath,
    });
  }
  const bundle = await createEmbeddedBundle({
    convexDir: options.convexDir,
    generatedPath: options.generatedPath,
    root,
    schemaPath: options.schemaPath,
  });
  const cacheDir = path.join(root, "node_modules", ".cache", "convex-embedded");
  const registryPath = path.join(cacheDir, "registry.js");
  const identityPath = path.join(cacheDir, "identity.js");
  await mkdir(cacheDir, { recursive: true });
  await Promise.all([
    writeIfChanged(registryPath, renderEmbeddedBundle(bundle)),
    renderEmbeddedIdentity(bundle, options.compatiblePriorRuntimes).then((source) =>
      writeIfChanged(identityPath, source),
    ),
  ]);

  const sourceFiles = new Set(
    [
      bundle.generatedPath,
      bundle.schemaPath,
      ...bundle.sourceFiles,
      ...Object.values(bundle.modules),
    ].map((file) => path.normalize(file)),
  );
  const generated = new Map([
    [VIRTUAL_MODULE_ID, registryPath],
    [VIRTUAL_IDENTITY_MODULE_ID, identityPath],
  ]);
  const previous = current.resolver?.resolveRequest;
  const resolveMapped = (
    context: MetroResolverContext,
    moduleName: string,
    platform: string | null,
  ): unknown =>
    previous
      ? previous(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  const resolveRequest: MetroResolveRequest = (context, moduleName, platform) => {
    const generatedPath = generated.get(moduleName);
    if (generatedPath !== undefined) {
      return resolveMapped(context, generatedPath, platform);
    }
    if (moduleName.startsWith(VIRTUAL_SOURCE_MODULE_PREFIX)) {
      const sourcePath = fromVirtualSourceId(moduleName);
      if (sourcePath === undefined || !sourceFiles.has(path.normalize(sourcePath))) {
        throw new Error(`Rejected an embedded Convex source outside the generated module graph.`);
      }
      return resolveMapped(context, sourcePath, platform);
    }
    return previous
      ? previous(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };

  return {
    ...current,
    resolver: {
      ...current.resolver,
      resolveRequest,
    },
  } as Config;
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  try {
    if ((await readFile(file, "utf8")) === contents) return;
  } catch {}
  await writeFile(file, contents);
}
