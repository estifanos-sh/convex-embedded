/**
 * Utilities for discovering Convex files for embedded bundler adapters.
 *
 * @remarks
 * Framework adapters use this entrypoint to build the virtual module consumed
 * by the browser runtime. Application code usually uses
 * `@estifanos-sh/convex-embedded/vite` or `@estifanos-sh/convex-embedded/unplugin` instead.
 *
 * @packageDocumentation
 */
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { EMBEDDED_STORAGE_ABI_VERSION } from "../abi";
import type { EmbeddedSchemaAnalysis } from "../schema";
import {
  EMBEDDED_GENERATED_FORMAT_VERSION,
  toEmbeddedGeneratedSchema,
  renderEmbeddedGenerated as renderGenerated,
  type EmbeddedGeneratedIdentity,
  type EmbeddedGeneratedSchema,
} from "./generated";

export {
  EMBEDDED_GENERATED_FORMAT_VERSION,
  renderEmbeddedGenerated,
  type EmbeddedGeneratedIdentity,
  type EmbeddedGeneratedSchema,
} from "./generated";

/**
 * Input for building the embedded Convex virtual module.
 *
 * @example
 * ```ts
 * const bundle = await createEmbeddedBundle({
 *   analysis: analyzeEmbeddedSchema(schema),
 *   root: process.cwd(),
 *   convexDir: "convex",
 * });
 * ```
 *
 * @public
 */
export interface EmbeddedBundleInput {
  /** Placement analysis of the live Convex schema the build is compiled against. */
  analysis: EmbeddedSchemaAnalysis;

  /**
   * Project root used to resolve `convexDir`.
   *
   * @defaultValue `process.cwd()`
   */
  root?: string;

  /**
   * Convex source directory, relative to `root` unless absolute.
   *
   * @defaultValue `"convex"`
   */
  convexDir?: string;

  /**
   * Schema file path, relative to `convexDir` unless absolute.
   *
   * @defaultValue `"schema.ts"`
   */
  schemaPath?: string;

  /**
   * Device-only function directories, relative to `root` unless absolute.
   *
   * Modules under these roots never reach the deployment: the device runtime
   * imports them through the virtual registry, and application graphs import
   * the same sources directly.
   */
  local?: string | string[];

  /**
   * Checked-in generated Embedded contract, relative to `convexDir`.
   *
   * The default lives under Convex's `_generated` directory, so deployment
   * discovery does not treat it as a hosted function module.
   *
   * @defaultValue `"_generated/embedded.ts"`
   */
  generatedPath?: string;
}

export interface GenerateEmbeddedResult {
  bundle: EmbeddedBundleResult;
  path: string;
  source: string;
}

/**
 * Rendered embedded bundle consumed by bundler adapters.
 *
 * @remarks
 * `modules` excludes the schema file and generated Convex files.
 *
 * @public
 */
export interface EmbeddedBundleResult {
  /**
   * Absolute path to the Convex schema file.
   */
  schemaPath: string;

  /** Checked-in generated Embedded contract path. */
  generatedPath: string;

  /**
   * Convex module IDs mapped to absolute source file paths.
   */
  modules: Record<string, string>;

  /**
   * Namespaced device-only module IDs mapped to their source files.
   */
  localModules: Record<string, { file: string }>;

  /** Every project source reachable from a device function entrypoint. */
  sourceFiles: string[];

  /** Placement-aware device schema inlined into the virtual registry. */
  embeddedSchema: EmbeddedGeneratedSchema;

  /** Hash of the current schema source bytes. */
  schemaSourceHash: string;

  /** Hash of the canonical function manifest. */
  manifestHash: string;

  /** Hash of the manifest plus every device source, used by the runtime identity. */
  moduleGraphHash: string;

  /**
   * Deterministic application artifact consumed by every runtime adapter.
   *
   * This is deliberately separate from the generated Convex contract: it describes executable
   * application code, not the package's durable store contract.
   */
  artifact: AppArtifactV1;

  /** Named exports that the generated immutable facade replaces for each local module. */
  localExports: Record<string, string[]>;

  /** Canonical function registrations included in the device artifact. */
  manifest: EmbeddedFunctionManifest;
}

export type FunctionPlacement = "replicated" | "remote";
export type EmbeddedFunctionKind = "query" | "mutation";
export type EmbeddedFunctionVisibility = "public" | "internal";

export interface EmbeddedFunctionManifestEntry {
  kind: EmbeddedFunctionKind;
  placement: FunctionPlacement;
  visibility: EmbeddedFunctionVisibility;
}

export type EmbeddedFunctionManifest = Record<
  string,
  Record<string, EmbeddedFunctionManifestEntry>
>;

export interface LocalExportDescriptor {
  name: string;
  reference: string;
}

/**
 * One candidate setup entrypoint discovered from a real local registration.
 *
 * `closureHash` is the generated local module-graph identity the runtime stamps onto the exported
 * registration, while `setupOnly` mirrors the generated compatibility marker. Neither property
 * is inferred from the export's spelling.
 */
export interface LocalSetupDescriptor extends LocalExportDescriptor {
  closureHash: string;
  setupOnly: boolean;
}

export interface AppArtifactModule {
  contentHash: string;
  exports: LocalExportDescriptor[];
  id: string;
}

/**
 * The adapter-neutral description of application code that can run on a device.
 *
 * Every field is content addressed and canonically ordered. It intentionally has no checkout
 * path, timestamp, package version, or object identity, so Vite, Metro, the worker, and Expo can
 * all consume the same contract.
 */
export interface AppArtifactV1 {
  artifactHash: string;
  executionHash: string;
  expectedBinding: { mobileAbi: number; storageAbi: number };
  format: 1;
  modules: AppArtifactModule[];
  replicationHash: string;
  schemaHash: string;
  setups: LocalSetupDescriptor[];
}

const DEFAULT_CONVEX_DIR = "convex";
const DEFAULT_SCHEMA_PATH = "schema.ts";
const EMBEDDED_ENTRYPOINT_PATH = "embedded.ts";
const DEFAULT_GENERATED_PATH = "_generated/embedded.ts";
const LOCAL_ENTRYPOINT = "@estifanos-sh/convex-embedded/local";
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SYSTEM_MODULE_RE =
  /^(?:convex\.config|auth\.config|crons|http)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const GENERATED_MODULE_RE = /^embedded\.generated\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PROJECT_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;
const GENERATED_IDENTITY_PREFIX = "// @estifanos-sh/convex-embedded-generated ";

/**
 * Discovers Convex schema and function module files for embedded bundler adapters.
 *
 * @param input - Schema analysis plus optional project root, Convex directory, and schema path.
 * @returns Absolute schema path and Convex module IDs mapped to absolute source files.
 * @throws If the schema file cannot be found, the checked-in generated contract is stale,
 * or two source files produce the same Convex module ID.
 *
 * @example
 * ```ts
 * const { schemaPath, modules } = await createEmbeddedBundle({ analysis });
 * ```
 *
 * @public
 */
export async function createEmbeddedBundle(
  input: EmbeddedBundleInput,
): Promise<EmbeddedBundleResult> {
  return createEmbeddedBundleInner(input, true);
}

/** Writes the checked-in generated contract and returns the bundle it was rendered from. */
export async function generateEmbedded(
  input: EmbeddedBundleInput,
): Promise<GenerateEmbeddedResult> {
  const bundle = await createEmbeddedBundleInner(input, false);
  const source = renderGenerated(bundle);
  await mkdir(path.dirname(bundle.generatedPath), { recursive: true });
  try {
    if ((await readFile(bundle.generatedPath, "utf8")) === source) {
      return { bundle, path: bundle.generatedPath, source };
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const temporary = `${bundle.generatedPath}.${process.pid}.tmp`;
  await writeFile(temporary, source, "utf8");
  await rename(temporary, bundle.generatedPath);
  return { bundle, path: bundle.generatedPath, source };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function createEmbeddedBundleInner(
  input: EmbeddedBundleInput,
  requireGenerated: boolean,
): Promise<EmbeddedBundleResult> {
  const root = path.resolve(input.root ?? process.cwd());
  const convexDir = resolveInputPath(root, input.convexDir ?? DEFAULT_CONVEX_DIR);
  const schemaPath = resolveInputPath(convexDir, input.schemaPath ?? DEFAULT_SCHEMA_PATH);
  const embeddedPath = resolveInputPath(convexDir, EMBEDDED_ENTRYPOINT_PATH);
  const generatedPath = resolveInputPath(convexDir, input.generatedPath ?? DEFAULT_GENERATED_PATH);
  const localDirs =
    input.local === undefined
      ? []
      : (Array.isArray(input.local) ? input.local : [input.local]).map((dir) =>
          resolveInputPath(root, dir),
        );
  for (const [index, localDir] of localDirs.entries()) {
    if (isInside(localDir, convexDir) || isInside(convexDir, localDir)) {
      throw new Error(
        `local function directory ${localDir} must live outside the Convex directory ${convexDir}`,
      );
    }
    for (const other of localDirs.slice(index + 1)) {
      if (isInside(localDir, other) || isInside(other, localDir)) {
        throw new Error(`local function directories ${localDir} and ${other} must not overlap`);
      }
    }
  }
  await assertSchemaFile(schemaPath);
  await assertEmbeddedEntrypoint(embeddedPath);
  const convexFiles = await listSourceFiles(convexDir);
  const sources = new Map(
    await Promise.all(
      convexFiles.map(async (file) => [path.resolve(file), await readFile(file, "utf8")] as const),
    ),
  );
  const files = convexFiles.filter((file) => {
    const name = path.basename(file);
    return (
      path.resolve(file) !== generatedPath &&
      !SYSTEM_MODULE_RE.test(name) &&
      !GENERATED_MODULE_RE.test(name)
    );
  });
  const modules: Record<string, string> = {};
  const manifest: EmbeddedFunctionManifest = {};
  const seen = new Map<string, string>();
  const placementByFile = new Map<string, FunctionPlacement | "local" | "node">();
  const localModules = await readLocalModules(localDirs, sources, placementByFile);

  const resolver = await createProjectResolver(root);
  for (const file of convexFiles) {
    const resolved = path.resolve(file);
    const source = sources.get(resolved)!;
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[2]!;
      if (/^(?:import|export)\s+type\b/.test(match[0]!)) continue;
      if (specifier === LOCAL_ENTRYPOINT) {
        throw new Error(
          `Convex module ${file} must not import ${LOCAL_ENTRYPOINT}; device-only functions live under the bundler local directories`,
        );
      }
      if (localDirs.length === 0) continue;
      let target: string | undefined;
      try {
        target = await resolveProjectImport(resolved, specifier, resolver);
      } catch {
        continue;
      }
      const normalized = target === undefined ? undefined : path.normalize(target);
      if (normalized !== undefined && localDirs.some((dir) => isInside(normalized, dir))) {
        throw new Error(
          `Convex module ${file} must not import device-only module ${target}; device-only code never deploys`,
        );
      }
    }
  }

  for (const file of files) {
    const resolved = path.resolve(file);
    if (resolved === schemaPath || resolved === embeddedPath) continue;
    const source = sources.get(resolved)!;
    if (hasUseNodeDirective(source)) {
      placementByFile.set(resolved, "node");
      continue;
    }
    const moduleId = toModuleId(convexDir, file);
    const existing = seen.get(moduleId);
    if (existing !== undefined) {
      throw new Error(`Duplicate Convex module id "${moduleId}" from "${existing}" and "${file}".`);
    }
    const registrations = readCanonicalRegistrations(moduleId, file, source);
    if (Object.keys(registrations).length === 0) continue;
    if (moduleId === "local" || moduleId.startsWith("local/")) {
      throw new Error(
        `Convex module ${moduleId} uses the reserved local/ function namespace; move it outside convex/local`,
      );
    }
    if ((path.basename(file).match(/\./g) ?? []).length > 1) {
      throw new Error(
        `Convex module ${moduleId} in ${file} contains multiple dots, which the Convex CLI silently skips; rename the module`,
      );
    }
    const placements = new Set(Object.values(registrations).map((entry) => entry.placement));
    if (placements.size !== 1) {
      throw new Error(`Convex module ${moduleId} mixes embedded function placements`);
    }
    const [placement] = placements;
    placementByFile.set(resolved, placement!);
    seen.set(moduleId, file);
    manifest[moduleId] = registrations;
    if (placement !== "remote") modules[moduleId] = file;
  }

  const sourceFiles = new Set<string>();
  const entrypoints = [
    ...Object.values(modules),
    ...Object.values(localModules).map((module) => module.file),
  ];
  for (const file of entrypoints) {
    await readDeviceImportGraph({
      convexDir,
      entry: path.resolve(file),
      generatedPath,
      placementByFile,
      resolver,
      root,
      sources,
      visited: sourceFiles,
    });
  }

  const schemaSourceHash = hashBytes(
    sources.get(schemaPath) ?? (await readFile(schemaPath, "utf8")),
  );
  const manifestHash = hashJson(manifest);
  if (requireGenerated) {
    await assertGeneratedFile(generatedPath, { manifestHash, schemaSourceHash });
  }
  const graph = [...sourceFiles].sort();
  const localModuleByFile = new Map(
    Object.entries(localModules).map(([moduleId, module]) => [
      path.normalize(module.file),
      moduleId,
    ]),
  );
  const localExports: Record<string, string[]> = Object.fromEntries(
    Object.entries(localModules)
      .map(([moduleId, module]) => [
        moduleId,
        readLocalExportNames(sources.get(path.normalize(module.file)) ?? "").map(([name]) => name),
      ])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ) as Record<string, string[]>;
  const localSetups = readLocalSetupDescriptors(localModules, sources);
  const artifactModules = graph.map((file) => {
    const normalized = path.normalize(file);
    const localModuleId = localModuleByFile.get(normalized);
    const id =
      localModuleId === undefined
        ? `app/${normalizePath(path.relative(root, normalized))}`
        : localModuleId;
    const exports = (localModuleId === undefined ? [] : (localExports[localModuleId] ?? [])).map(
      (name) => ({ name, reference: `${localModuleId}:${name}` }),
    );
    return { contentHash: hashBytes(sources.get(normalized)!), exports, id };
  });
  const executionHash = hashJson({ manifest, modules: artifactModules });
  const schemaHash = toEmbeddedGeneratedSchema(input.analysis).runtimeStoreSchema.hash;
  if (schemaHash === undefined) {
    throw new Error("Embedded application artifact requires a generated runtime schema hash");
  }
  const setups = [...localSetups]
    .flatMap(([moduleId, exports]) =>
      [...exports].map(([name, setupOnly]) => ({
        closureHash: executionHash,
        name,
        reference: `${moduleId}:${name}`,
        setupOnly,
      })),
    )
    .sort((left, right) =>
      left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0,
    );
  const artifactWithoutHash = {
    executionHash,
    expectedBinding: {
      // The Expo bridge is versioned independently from the Node/WASM storage ABI. Keep this
      // paired with `EXPO_NATIVE_API_VERSION` in `src/expo/module.ts`.
      mobileAbi: 10,
      storageAbi: EMBEDDED_STORAGE_ABI_VERSION,
    },
    format: 1 as const,
    modules: artifactModules,
    replicationHash: manifestHash,
    schemaHash,
    setups,
  };
  const artifact: AppArtifactV1 = {
    ...artifactWithoutHash,
    artifactHash: hashJson(artifactWithoutHash),
  };

  return {
    embeddedSchema: toEmbeddedGeneratedSchema(input.analysis),
    generatedPath,
    localModules,
    manifest,
    manifestHash,
    artifact,
    localExports,
    moduleGraphHash: executionHash,
    modules,
    schemaPath,
    schemaSourceHash,
    sourceFiles: graph,
  };
}

const LOCAL_NAMED_EXPORT = /export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([$A-Z_a-z][$\w]*)/g;
const LOCAL_VARIABLE_EXPORT = /export\s+(?:const|let|var)\s+/g;
const LOCAL_EXPORT_LIST = /export\s+(type\s+)?\{([^}]*)\}(\s*from\b)?/g;
const LOCAL_STAR_EXPORT = /\bexport\s*\*(?:\s+as\s+[$A-Z_a-z][$\w]*)?\s+from\b/;
const LOCAL_EXPORT_ALIAS = /^([$A-Z_a-z][$\w]*)\s+as\s+([$A-Z_a-z][$\w]*)$/;
const LOCAL_COMPATIBILITY_BINDING =
  /\b(?:const|let|var)\s+([$A-Z_a-z][$\w]*)(?:\s*:[^=;\n]+)?\s*=\s*local\s*\.\s*compatibility\s*\(/g;
const LOCAL_NAMED_REEXPORT = /export\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
const AMBIENT_DECLARATION = /\bdeclare\b/g;
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/;
const RESERVED_BINDINGS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

async function readLocalModules(
  localDirs: string[],
  sources: Map<string, string>,
  placementByFile: Map<string, FunctionPlacement | "local" | "node">,
): Promise<EmbeddedBundleResult["localModules"]> {
  const localModules: EmbeddedBundleResult["localModules"] = {};
  for (const localDir of localDirs) {
    for (const file of await listSourceFiles(localDir)) {
      const resolved = path.resolve(file);
      sources.set(resolved, await readFile(file, "utf8"));
      placementByFile.set(resolved, "local");
      const moduleId = `local/${toModuleId(localDir, file)}`;
      assertLocalFacadeExports(moduleId, sources.get(resolved) ?? "");
      const existing = localModules[moduleId];
      if (existing !== undefined) {
        throw new Error(
          `Duplicate local module id "${moduleId}" from "${existing.file}" and "${resolved}".`,
        );
      }
      localModules[moduleId] = { file: resolved };
    }
  }
  return localModules;
}

function assertLocalFacadeExports(moduleId: string, source: string): void {
  if (LOCAL_STAR_EXPORT.test(maskCommentsAndStrings(source))) {
    throw new Error(
      `device-only module ${moduleId} uses export *; generated local facades require named re-exports so setup references remain immutable`,
    );
  }
}

/**
 * Named exports of a device module as `[exported, binding]` pairs, in the order the appended stamp
 * call lists them. Anything that is not an identifier-named local binding is skipped: the worker
 * registry stamps whatever it loads, so a missed name never becomes an error.
 *
 * @internal
 */
export function readLocalExportNames(source: string): Array<[string, string]> {
  const code = maskAmbientDeclarations(maskCommentsAndStrings(source));
  const names = new Map<string, string>();
  for (const match of code.matchAll(LOCAL_NAMED_EXPORT)) {
    const name = match[1]!;
    if (!RESERVED_BINDINGS.has(name)) names.set(name, name);
  }
  for (const match of code.matchAll(LOCAL_VARIABLE_EXPORT)) {
    const declarators = code.slice(match.index + match[0].length);
    const end = indexOfTopLevel(declarators, ";}");
    for (const declarator of splitTopLevel(end === -1 ? declarators : declarators.slice(0, end))) {
      const boundary = indexOfTopLevel(declarator, "=:");
      const target = (boundary === -1 ? declarator : declarator.slice(0, boundary)).trim();
      for (const name of readBoundNames(target)) names.set(name, name);
    }
  }
  for (const match of code.matchAll(LOCAL_EXPORT_LIST)) {
    if (match[1] !== undefined) continue;
    for (const clause of match[2]!.split(",")) {
      const trimmed = clause.trim();
      if (trimmed === "" || /^type\s/.test(trimmed)) continue;
      const alias = LOCAL_EXPORT_ALIAS.exec(trimmed);
      const exported = alias?.[2] ?? trimmed;
      // A named re-export is read from the source module namespace by the generated facade, so
      // its public name is the only stable binding available at this stage.
      const binding = match[3] === undefined ? (alias?.[1] ?? trimmed) : exported;
      if (exported === "default" || !IDENTIFIER.test(exported) || !IDENTIFIER.test(binding)) {
        continue;
      }
      if (RESERVED_BINDINGS.has(binding)) continue;
      names.set(exported, binding);
    }
  }
  return [...names].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Reads setup candidates from local-builder semantics, not an export-name convention.
 *
 * A lifecycle setup must be an internal local action. Compatibility-bound actions retain their
 * generated setup-only marker; ordinary internal actions remain valid explicit `open(action)`
 * candidates and are marked `setupOnly: false` for consumers that need to distinguish them.
 */
function readLocalSetupDescriptors(
  localModules: EmbeddedBundleResult["localModules"],
  sources: ReadonlyMap<string, string>,
): Map<string, Map<string, boolean>> {
  const modules = new Map(
    Object.entries(localModules).map(([moduleId, module]) => [
      moduleId,
      { file: path.normalize(module.file), source: sources.get(path.normalize(module.file)) ?? "" },
    ]),
  );
  const moduleByFile = new Map([...modules].map(([moduleId, module]) => [module.file, moduleId]));
  const cache = new Map<string, Map<string, boolean>>();
  const reading = new Set<string>();
  const readModule = (moduleId: string): Map<string, boolean> => {
    const cached = cache.get(moduleId);
    if (cached !== undefined) return cached;
    if (reading.has(moduleId)) {
      throw new Error(`device-only setup exports contain a cycle at ${moduleId}`);
    }
    const module = modules.get(moduleId);
    if (module === undefined) return new Map();
    reading.add(moduleId);
    const exported = new Map<string, boolean>();
    const setupBindings = readLocalSetupBindings(module.source);
    for (const [name, binding] of readLocalExportNames(module.source)) {
      const setupOnly = setupBindings.get(binding);
      if (setupOnly !== undefined) exported.set(name, setupOnly);
    }
    for (const reexport of readLocalNamedReexports(module.source)) {
      const target = resolveLocalReexport(module.file, reexport.specifier, moduleByFile);
      if (target === undefined) continue;
      const targetExports = readModule(target);
      for (const [sourceName, exportedName] of reexport.names) {
        const setupOnly = targetExports.get(sourceName);
        if (setupOnly !== undefined) exported.set(exportedName, setupOnly);
      }
    }
    reading.delete(moduleId);
    cache.set(moduleId, exported);
    return exported;
  };
  return new Map([...modules.keys()].sort().map((moduleId) => [moduleId, readModule(moduleId)]));
}

function readLocalSetupBindings(source: string): Map<string, boolean> {
  const code = maskAmbientDeclarations(maskCommentsAndStrings(source));
  const compatibilityBindings = new Set<string>();
  for (const match of code.matchAll(LOCAL_COMPATIBILITY_BINDING)) {
    compatibilityBindings.add(match[1]!);
  }
  const bindings = new Map<string, boolean>();
  for (const match of code.matchAll(LOCAL_VARIABLE_EXPORT)) {
    const declarators = code.slice(match.index + match[0].length);
    const end = indexOfTopLevel(declarators, ";");
    for (const declarator of splitTopLevel(end === -1 ? declarators : declarators.slice(0, end))) {
      const equals = indexOfTopLevel(declarator, "=");
      if (equals === -1) continue;
      const name = declarator.slice(0, equals).trim();
      if (!IDENTIFIER.test(name)) continue;
      const setupOnly = localInternalActionSetupOnly(
        declarator.slice(equals + 1),
        compatibilityBindings,
      );
      if (setupOnly !== undefined) bindings.set(name, setupOnly);
    }
  }
  return bindings;
}

function localInternalActionSetupOnly(
  expression: string,
  compatibilityBindings: ReadonlySet<string>,
): boolean | undefined {
  const marker = ".internalAction";
  const markerIndex = expression.indexOf(marker);
  if (markerIndex === -1 || !/\.\s*internalAction\s*\(/.test(expression)) return undefined;
  const receiver = expression.slice(0, markerIndex).replaceAll(/\s/g, "");
  if (receiver === "local") return false;
  if (compatibilityBindings.has(receiver)) return true;
  return receiver.startsWith("local.compatibility(") ? true : undefined;
}

function readLocalNamedReexports(
  source: string,
): Array<{ names: Array<[source: string, exported: string]>; specifier: string }> {
  const code = maskCommentsAndStrings(source);
  const reexports = [];
  for (const match of source.matchAll(LOCAL_NAMED_REEXPORT)) {
    if (match.index === undefined || !code.startsWith("export", match.index)) continue;
    const names: Array<[string, string]> = [];
    for (const clause of match[1]!.split(",")) {
      const trimmed = clause.trim();
      const alias = LOCAL_EXPORT_ALIAS.exec(trimmed);
      const sourceName = alias?.[1] ?? trimmed;
      const exportedName = alias?.[2] ?? trimmed;
      if (!IDENTIFIER.test(sourceName) || !IDENTIFIER.test(exportedName)) continue;
      names.push([sourceName, exportedName]);
    }
    reexports.push({ names, specifier: match[3]! });
  }
  return reexports;
}

function resolveLocalReexport(
  importer: string,
  specifier: string,
  moduleByFile: ReadonlyMap<string, string>,
): string | undefined {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...PROJECT_SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...PROJECT_SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const moduleId = moduleByFile.get(path.normalize(candidate));
    if (moduleId !== undefined) return moduleId;
  }
  return undefined;
}

/** Bindings introduced by one declarator target: an identifier or a destructuring pattern. */
function readBoundNames(target: string): string[] {
  if (IDENTIFIER.test(target)) return RESERVED_BINDINGS.has(target) ? [] : [target];
  if (!target.startsWith("{") && !target.startsWith("[")) return [];
  const names: string[] = [];
  for (const element of splitTopLevel(target.slice(1, -1))) {
    let text = element.trim();
    if (text.startsWith("...")) text = text.slice(3).trim();
    const initializer = indexOfTopLevel(text, "=");
    if (initializer !== -1) text = text.slice(0, initializer).trim();
    const key = indexOfTopLevel(text, ":");
    if (key !== -1) text = text.slice(key + 1).trim();
    names.push(...readBoundNames(text));
  }
  return names;
}

function indexOfTopLevel(text: string, characters: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (depth === 0 && characters.includes(character)) return index;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Blanks `declare` blocks and statements, whose bindings never exist at runtime. */
function maskAmbientDeclarations(code: string): string {
  let output = code;
  for (const match of code.matchAll(AMBIENT_DECLARATION)) {
    let end = match.index;
    let depth = 0;
    while (end < code.length) {
      const character = code[end]!;
      end += 1;
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth <= 0) break;
      } else if (character === ";" && depth === 0) break;
    }
    output = `${output.slice(0, match.index)}${code
      .slice(match.index, end)
      .replaceAll(/[^\n\r]/g, " ")}${output.slice(end)}`;
  }
  return output;
}

const STATIC_IMPORT =
  /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\()(["'])([^"']+)\1/g;

interface ProjectResolver {
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
  /** Candidate path to source file for the lifetime of one scan. */
  resolved: Map<string, string | undefined>;
}

async function readDeviceImportGraph(options: {
  convexDir: string;
  entry: string;
  generatedPath: string;
  sources: Map<string, string>;
  placementByFile: Map<string, FunctionPlacement | "local" | "node">;
  resolver: ProjectResolver;
  root: string;
  visited: Set<string>;
}): Promise<void> {
  const { convexDir, entry, generatedPath, placementByFile, resolver, root, sources, visited } =
    options;
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readProjectSource(file, sources);
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[2];
      if (!specifier) continue;
      if (isGeneratedImport(file, specifier, generatedPath)) continue;
      const target = await resolveProjectImport(file, specifier, resolver);
      if (target === undefined) continue;
      if (target === generatedPath) continue;
      let placement = placementByFile.get(target);
      if (placement === undefined) {
        const targetSource = await readProjectSource(target, sources);
        if (hasUseNodeDirective(targetSource)) {
          placement = "node";
        } else if (isInside(target, convexDir)) {
          const moduleId = normalizePath(path.relative(root, target)).replace(/\.[^.]+$/, "");
          const registrations = readCanonicalRegistrations(moduleId, target, targetSource);
          const placements = new Set(Object.values(registrations).map((entry) => entry.placement));
          if (placements.size > 1) {
            throw new Error(`Convex module ${moduleId} mixes embedded function placements`);
          }
          placement = placements.values().next().value;
        }
        if (placement !== undefined) placementByFile.set(target, placement);
      }
      if (placement === "remote" || placement === "node") {
        throw new Error(
          `device function ${normalizePath(path.relative(root, entry))} imports ${
            placement === "node" ? "a Node-only" : "a remote"
          } module: ${target}`,
        );
      }
      await visit(target);
    }
  };
  await visit(entry);
}

function isGeneratedImport(importer: string, specifier: string, generatedPath: string): boolean {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return false;
  const base = path.resolve(path.dirname(importer), specifier);
  if (base === generatedPath) return true;
  return PROJECT_SOURCE_EXTENSIONS.some((extension) => `${base}${extension}` === generatedPath);
}

async function assertGeneratedFile(
  file: string,
  expected: { manifestHash: string; schemaSourceHash: string },
): Promise<void> {
  let source: string;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    source = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Could not find generated Embedded contract at ${file}. Regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter before building.`,
    );
  }
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith(GENERATED_IDENTITY_PREFIX)) {
    throw new Error(
      `Generated Embedded contract at ${file} has no verifiable identity; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter.`,
    );
  }
  let identity: unknown;
  try {
    identity = JSON.parse(firstLine.slice(GENERATED_IDENTITY_PREFIX.length));
  } catch {
    throw new Error(
      `Generated Embedded contract at ${file} has an invalid identity; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter.`,
    );
  }
  if (!isGeneratedIdentity(identity)) {
    throw new Error(
      `Generated Embedded contract at ${file} has an invalid identity; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter.`,
    );
  }
  if (identity.formatVersion !== EMBEDDED_GENERATED_FORMAT_VERSION) {
    throw new Error(
      `Generated Embedded contract format ${identity.formatVersion} is unsupported; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter: ${file}`,
    );
  }
  if (identity.schemaSourceHash !== expected.schemaSourceHash) {
    throw new Error(
      `Generated Embedded contract at ${file} is stale for the current schema source; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter.`,
    );
  }
  if (identity.manifestHash !== expected.manifestHash) {
    throw new Error(
      `Generated Embedded contract at ${file} is stale for the current function manifest; regenerate it with your configured @estifanos-sh/convex-embedded bundler adapter.`,
    );
  }
}

function isGeneratedIdentity(value: unknown): value is EmbeddedGeneratedIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.formatVersion === "number" &&
    typeof identity.manifestHash === "string" &&
    typeof identity.schemaSourceHash === "string"
  );
}

const CANONICAL_REGISTRATION =
  /export\s+const\s+([$A-Z_a-z][$\w]*)\s*=\s*(replicated|remote)\.(query|mutation|internalQuery|internalMutation)\s*\(/g;
const EMBEDDED_REGISTRATION_LIKE =
  /export\s+const\s+([$A-Z_a-z][$\w]*)(?:\s*:[^=;\n]+)?\s*=\s*(?:\(\s*)*[$A-Z_a-z][$\w]*(?:\s*\.\s*[A-Za-z_$][\w$]*){0,2}\s*\.\s*(?:query|mutation|internalQuery|internalMutation)(?:\s*\))*\s*\(/g;
const DIRECT_REGISTRATION =
  /export\s+const\s+([$A-Z_a-z][$\w]*)(?:\s*:[^=;\n]+)?\s*=\s*(?:\(\s*)*(?:query|mutation|internalQuery|internalMutation)(?:\s*\))*\s*\(/g;
const PLACEMENT_BUILDER_REFERENCE =
  /\b(?:replicated|remote)\s*\.\s*(?:query|mutation|internalQuery|internalMutation)\b/g;
const LOCAL_BUILDER_REFERENCE =
  /\bembedded\s*\.\s*local\s*\.\s*(?:query|mutation|internalQuery|internalMutation)\b/;
const PLACEMENT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
const PLACEMENT_MODULE = /\/embedded(?:\.[cm]?[jt]s)?$/;

function readCanonicalRegistrations(
  moduleId: string,
  file: string,
  source: string,
): Record<string, EmbeddedFunctionManifestEntry> {
  const code = maskCommentsAndStrings(source);
  if (LOCAL_BUILDER_REFERENCE.test(code)) {
    throw new Error(
      "embedded.local builders were removed; define device-only functions under one of the plugin's configured local roots and import local from the generated Embedded contract",
    );
  }
  const imported = readPlacementImports(source, code);
  const entries: Record<string, EmbeddedFunctionManifestEntry> = {};
  for (const match of code.matchAll(CANONICAL_REGISTRATION)) {
    const [, name, placement, builder] = match;
    if (!name || !placement || !builder || !imported.has(placement)) continue;
    entries[name] = {
      kind: builder.endsWith("Query") || builder === "query" ? "query" : "mutation",
      placement: placement as FunctionPlacement,
      visibility: builder.startsWith("internal") ? "internal" : "public",
    };
  }
  const canonicalNames = new Set(Object.keys(entries));
  for (const match of code.matchAll(EMBEDDED_REGISTRATION_LIKE)) {
    const name = match[1];
    if (name && !canonicalNames.has(name)) {
      throw new Error(
        `function ${moduleId}:${name} in ${file} must use a canonical replicated.<builder> or remote.<builder> registration imported from the Convex embedded module`,
      );
    }
  }
  for (const match of code.matchAll(DIRECT_REGISTRATION)) {
    const name = match[1];
    throw new Error(
      `function ${moduleId}:${name ?? "unknown"} in ${file} must use a canonical replicated.<builder> or remote.<builder> registration imported from the Convex embedded module`,
    );
  }
  const placementReferences = [...code.matchAll(PLACEMENT_BUILDER_REFERENCE)].length;
  if (placementReferences !== canonicalNames.size) {
    throw new Error(
      `function module ${moduleId} in ${file} must call each <placement>.<builder> directly from its exported canonical registration`,
    );
  }
  return entries;
}

function readPlacementImports(source: string, code: string): Set<string> {
  const placements = new Set<string>();
  for (const match of source.matchAll(PLACEMENT_IMPORT)) {
    if (!code.startsWith("import", match.index)) continue;
    if (!PLACEMENT_MODULE.test(match[3]!)) continue;
    for (const clause of match[1]!.split(",")) {
      const name = clause.trim();
      if (name === "replicated" || name === "remote") placements.add(name);
    }
  }
  return placements;
}

const REGEX_PRECEDING_OPERATORS = "(,=:[!&|?{;+-*%~^>";
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function maskCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "string" | "regex" = "code";
  let quote = "";
  let previous = "";
  let word = "";
  let characterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line";
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block";
      } else if (character === "/" && startsRegexLiteral(previous, word)) {
        output += " ";
        characterClass = false;
        state = "regex";
      } else if (character === '"' || character === "'" || character === "`") {
        output += " ";
        quote = character;
        state = "string";
      } else {
        output += character;
        if (!/\s/.test(character)) {
          word = /[$\w]/.test(character) ? `${word}${character}` : "";
          previous = character;
        }
      }
      continue;
    }
    if (state === "line") {
      output += character === "\n" || character === "\r" ? character : " ";
      if (character === "\n" || character === "\r") state = "code";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (state === "regex") {
      output += character === "\n" || character === "\r" ? character : " ";
      if (character === "\\") {
        if (next !== undefined) {
          output += next === "\n" || next === "\r" ? next : " ";
          index += 1;
        }
      } else if (character === "[") {
        characterClass = true;
      } else if (character === "]") {
        characterClass = false;
      } else if (
        (character === "/" && !characterClass) ||
        character === "\n" ||
        character === "\r"
      ) {
        previous = "/";
        word = "";
        state = "code";
      }
      continue;
    }
    if (character === "\\") {
      output += " ";
      if (next !== undefined) {
        output += next === "\n" || next === "\r" ? next : " ";
        index += 1;
      }
    } else if (character === quote) {
      output += " ";
      previous = quote;
      word = "";
      state = "code";
    } else {
      output += character === "\n" || character === "\r" ? character : " ";
    }
  }
  return output;
}

/**
 * Whether a `/` opens a regex literal rather than a division, from the last significant token.
 * JSX closes (`</`, `/>`) keep `<` and `}` out of the operand-position set.
 */
function startsRegexLiteral(previous: string, word: string): boolean {
  if (word !== "") return REGEX_PRECEDING_KEYWORDS.has(word);
  return previous === "" || REGEX_PRECEDING_OPERATORS.includes(previous);
}

function hasUseNodeDirective(source: string): boolean {
  let offset = skipTrivia(source, 0);
  while (source[offset] === '"' || source[offset] === "'") {
    const quote = source[offset];
    let value = "";
    let index = offset + 1;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") {
        index += 1;
        if (index >= source.length) return false;
      }
      value += source[index];
      index += 1;
    }
    if (source[index] !== quote) return false;
    index += 1;
    while (source[index] === " " || source[index] === "\t") index += 1;
    if (source[index] === ";") index += 1;
    else if (source[index] !== "\n" && source[index] !== "\r" && index < source.length) {
      return false;
    }
    if (value === "use node") return true;
    offset = skipTrivia(source, index);
  }
  return false;
}

function skipTrivia(source: string, start: number): number {
  let offset = start;
  if (offset === 0 && source.charCodeAt(0) === 0xfeff) offset += 1;
  if (offset === 0 && source.startsWith("#!")) {
    offset = source.indexOf("\n");
    if (offset === -1) return source.length;
  }
  while (offset < source.length) {
    if (/\s/.test(source[offset] ?? "")) {
      offset += 1;
      continue;
    }
    if (source.startsWith("//", offset)) {
      const next = source.indexOf("\n", offset + 2);
      return next === -1 ? source.length : skipTrivia(source, next + 1);
    }
    if (source.startsWith("/*", offset)) {
      const next = source.indexOf("*/", offset + 2);
      return next === -1 ? source.length : skipTrivia(source, next + 2);
    }
    break;
  }
  return offset;
}

/**
 * Converts a file path under `convexDir` into a canonical Convex module ID.
 *
 * @param convexDir - Absolute or relative Convex source directory.
 * @param filePath - Source file path inside `convexDir`.
 * @returns Convex module ID without the TypeScript extension.
 *
 * @public
 */
export function toModuleId(convexDir: string, filePath: string): string {
  return normalizePath(path.relative(convexDir, filePath)).replace(/\.[^.]+$/, "");
}

/**
 * Resolves a possibly-relative input path against the project root.
 *
 * @internal
 */
function resolveInputPath(root: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(root, value));
}

async function listSourceFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const next = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_generated") return [] as string[];
        return listSourceFiles(next);
      }
      if (!entry.isFile()) return [] as string[];
      if (!SOURCE_EXTENSIONS.test(entry.name)) return [] as string[];
      if (isDeclarationFile(entry.name)) return [] as string[];
      return [next];
    }),
  );
  return files.flat().sort();
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertSchemaFile(schemaPath: string): Promise<void> {
  try {
    const schema = await stat(schemaPath);
    if (schema.isFile()) return;
  } catch {}
  throw new Error(`Could not find Convex schema at ${schemaPath}`);
}

async function assertEmbeddedEntrypoint(embeddedPath: string): Promise<void> {
  try {
    const entrypoint = await stat(embeddedPath);
    if (entrypoint.isFile()) return;
  } catch {}
  throw new Error(
    `Could not find Convex embedded entrypoint at ${embeddedPath}. Create convex/embedded.ts and export pull and push.`,
  );
}

function isDeclarationFile(name: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/.test(name);
}

async function createProjectResolver(root: string): Promise<ProjectResolver> {
  const configPath = path.join(root, "tsconfig.json");
  let config: {
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  };
  try {
    config = JSON.parse(stripJsonComments(await readFile(configPath, "utf8"))) as typeof config;
  } catch {
    return { paths: [], resolved: new Map() };
  }
  const compilerOptions = config.compilerOptions ?? {};
  const baseUrl =
    typeof compilerOptions.baseUrl === "string"
      ? path.resolve(path.dirname(configPath), compilerOptions.baseUrl)
      : path.dirname(configPath);
  const paths =
    typeof compilerOptions.paths === "object" && compilerOptions.paths !== null
      ? Object.entries(compilerOptions.paths).flatMap(([pattern, targets]) =>
          Array.isArray(targets) && targets.every((target) => typeof target === "string")
            ? [{ pattern, targets: targets.map((target) => path.resolve(baseUrl, target)) }]
            : [],
        )
      : [];
  return { baseUrl, paths, resolved: new Map() };
}

async function resolveProjectImport(
  importer: string,
  specifier: string,
  resolver: ProjectResolver,
): Promise<string | undefined> {
  if (specifier.startsWith("node:") || specifier.startsWith("data:")) return undefined;
  const bases: string[] = [];
  let matchedAlias = false;
  if (specifier.startsWith(".")) {
    bases.push(path.resolve(path.dirname(importer), specifier));
  } else if (path.isAbsolute(specifier)) {
    bases.push(path.resolve(specifier));
  } else {
    for (const alias of resolver.paths) {
      const wildcard = matchPathPattern(alias.pattern, specifier);
      if (wildcard === undefined) continue;
      matchedAlias = true;
      for (const target of alias.targets) bases.push(target.replaceAll("*", wildcard));
    }
    if (!matchedAlias && resolver.baseUrl !== undefined) {
      const baseUrlTarget = path.resolve(resolver.baseUrl, specifier);
      if (await resolveSourcePath(baseUrlTarget, resolver)) bases.push(baseUrlTarget);
    }
  }
  for (const base of bases) {
    const resolved = await resolveSourcePath(base, resolver);
    if (resolved !== undefined) return resolved;
  }
  if (matchedAlias || specifier.startsWith(".") || path.isAbsolute(specifier)) {
    throw new Error(
      `Could not resolve project import ${JSON.stringify(specifier)} from ${importer}`,
    );
  }
  return undefined;
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

async function resolveSourcePath(
  base: string,
  resolver: ProjectResolver,
): Promise<string | undefined> {
  const memoized = resolver.resolved.get(base);
  if (memoized !== undefined || resolver.resolved.has(base)) return memoized;
  const resolved = await readSourcePath(base);
  resolver.resolved.set(base, resolved);
  return resolved;
}

async function readSourcePath(base: string): Promise<string | undefined> {
  const candidates: string[] = [base];
  const extension = path.extname(base);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts"] as const) {
      candidates.push(`${stem}${sourceExtension}`);
    }
  } else if (!(PROJECT_SOURCE_EXTENSIONS as readonly string[]).includes(extension)) {
    for (const sourceExtension of PROJECT_SOURCE_EXTENSIONS) {
      candidates.push(`${base}${sourceExtension}`, path.join(base, `index${sourceExtension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return path.resolve(candidate);
    } catch {}
  }
  return undefined;
}

async function readProjectSource(file: string, sources: Map<string, string>): Promise<string> {
  const existing = sources.get(file);
  if (existing !== undefined) return existing;
  const source = await readFile(file, "utf8");
  sources.set(file, source);
  return source;
}

function stripJsonComments(source: string): string {
  let output = "";
  let quote: '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (quote !== undefined) {
      output += character;
      if (character === "\\") {
        index += 1;
        output += source[index] ?? "";
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function hashBytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function hashJson(value: unknown): string {
  return hashBytes(JSON.stringify(value));
}
