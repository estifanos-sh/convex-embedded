/**
 * Utilities for discovering Convex files for embedded bundler adapters.
 *
 * @remarks
 * Framework adapters use this entrypoint to build the virtual module consumed
 * by the browser runtime. Application code usually uses
 * `@convex-dev/embedded/vite` or `@convex-dev/embedded/unplugin` instead.
 *
 * @packageDocumentation
 */
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EmbeddedSchemaAnalysis } from "../schema";
import {
  EMBEDDED_GENERATED_FORMAT_VERSION,
  renderEmbeddedGenerated as renderGenerated,
} from "./generated";

export {
  EMBEDDED_GENERATED_FORMAT_VERSION,
  renderEmbeddedGenerated,
  type EmbeddedGeneratedInput,
  type EmbeddedGeneratedSchema,
} from "./generated";

/**
 * Input for building the embedded Convex virtual module.
 *
 * @example
 * ```ts
 * const bundle = await createEmbeddedBundle({
 *   root: process.cwd(),
 *   convexDir: "convex",
 * });
 * ```
 *
 * @public
 */
export interface EmbeddedBundleInput {
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

  /** Generated literal device schema, relative to `convexDir`. */
  generatedPath?: string;
}

export interface GenerateEmbeddedInput extends EmbeddedBundleInput {
  analysis: EmbeddedSchemaAnalysis;
}

export interface GenerateEmbeddedResult {
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

  /** Generated literal schema path when generation has completed. */
  generatedPath: string;

  /**
   * Convex module IDs mapped to absolute source file paths.
   */
  modules: Record<string, string>;

  /** Every project source reachable from a device function entrypoint. */
  sourceFiles: string[];

  /** Hash of the current schema source bytes. */
  schemaSourceHash: string;

  /** Hash of the generated, placement-aware schema payload. */
  schemaHash: string;

  /** Hash of the canonical function manifest. */
  manifestHash: string;

  /** Canonical function registrations included in the device artifact. */
  manifest: EmbeddedFunctionManifest;
}

export type FunctionPlacement = "replicated" | "remote" | "local";
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

const DEFAULT_CONVEX_DIR = "convex";
const DEFAULT_SCHEMA_PATH = "schema.ts";
const EMBEDDED_ENTRYPOINT_PATH = "embedded.ts";
const DEFAULT_GENERATED_PATH = "_generated/embedded.ts";
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
const GENERATED_IDENTITY_PREFIX = "// @convex-dev/embedded-generated ";

/**
 * Discovers Convex schema and function module files for embedded bundler adapters.
 *
 * @param input - Optional project root, Convex directory, and schema path.
 * @returns Absolute schema path and Convex module IDs mapped to absolute source files.
 * @throws If the schema file cannot be found or two source files produce the
 * same Convex module ID.
 *
 * @example
 * ```ts
 * const { schemaPath, modules } = await createEmbeddedBundle();
 * ```
 *
 * @public
 */
export async function createEmbeddedBundle(
  input: EmbeddedBundleInput = {},
): Promise<EmbeddedBundleResult> {
  return createEmbeddedBundleInner(input, true);
}

/** Generates the literal schema/function contract consumed by device builds. */
export async function generateEmbedded(
  input: GenerateEmbeddedInput,
): Promise<GenerateEmbeddedResult> {
  const bundle = await createEmbeddedBundleInner(input, false);
  const source = renderGenerated({ analysis: input.analysis, bundle });
  await mkdir(path.dirname(bundle.generatedPath), { recursive: true });
  const temporary = `${bundle.generatedPath}.${process.pid}.tmp`;
  await writeFile(temporary, source, "utf8");
  await rename(temporary, bundle.generatedPath);
  return { path: bundle.generatedPath, source };
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
  await assertSchemaFile(schemaPath);
  await assertEmbeddedEntrypoint(embeddedPath);
  const files = await listConvexFiles(convexDir);
  const modules: Record<string, string> = {};
  const manifest: EmbeddedFunctionManifest = {};
  const seen = new Map<string, string>();
  const sources = new Map(
    await Promise.all(
      files.map(async (file) => [path.resolve(file), await readFile(file, "utf8")] as const),
    ),
  );
  const placementByFile = new Map<string, FunctionPlacement | "node">();

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
    const placements = new Set(Object.values(registrations).map((entry) => entry.placement));
    if (placements.size !== 1) {
      throw new Error(`Convex module ${moduleId} mixes embedded function placements`);
    }
    const [placement] = placements;
    placementByFile.set(resolved, placement!);
    if (placement === "local" && !/\.local\.[^.]+$/.test(file)) {
      throw new Error(
        `local function module ${moduleId} must use the *.local.ts naming convention`,
      );
    }
    seen.set(moduleId, file);
    manifest[moduleId] = registrations;
    if (placement !== "remote") modules[moduleId] = file;
  }

  const resolver = await createProjectResolver(root);
  const sourceFiles = new Set<string>();
  for (const file of Object.values(modules)) {
    const reachable = await readDeviceImportGraph({
      entry: path.resolve(file),
      placementByFile,
      resolver,
      root,
      sources,
    });
    for (const sourceFile of reachable) sourceFiles.add(sourceFile);
  }

  const schemaSourceHash = hashBytes(await readFile(schemaPath));
  const manifestHash = hashJson(manifest);
  let schemaHash = schemaSourceHash;
  if (requireGenerated) {
    schemaHash = (await assertGeneratedFile(generatedPath, { manifestHash, schemaSourceHash }))
      .analysisHash;
  }

  return {
    generatedPath,
    manifest,
    manifestHash,
    modules,
    schemaHash,
    schemaPath,
    schemaSourceHash,
    sourceFiles: [...sourceFiles].sort(),
  };
}

const STATIC_IMPORT =
  /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\()(["'])([^"']+)\1/g;

interface ProjectResolver {
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

async function readDeviceImportGraph(options: {
  entry: string;
  sources: Map<string, string>;
  placementByFile: Map<string, FunctionPlacement | "node">;
  resolver: ProjectResolver;
  root: string;
}): Promise<Set<string>> {
  const { entry, placementByFile, resolver, root, sources } = options;
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readProjectSource(file, sources);
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[2];
      if (!specifier) continue;
      const target = await resolveProjectImport(file, specifier, resolver);
      if (target === undefined) continue;
      let placement = placementByFile.get(target);
      if (placement === undefined) {
        const targetSource = await readProjectSource(target, sources);
        if (hasUseNodeDirective(targetSource)) {
          placement = "node";
        } else {
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
  return visited;
}

async function assertGeneratedFile(
  file: string,
  expected: { manifestHash: string; schemaSourceHash: string },
): Promise<{
  analysisHash: string;
  formatVersion: number;
  manifestHash: string;
  schemaSourceHash: string;
}> {
  let source: string;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    source = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Could not find generated Embedded contract at ${file}. Generate convex/_generated/embedded.ts before building.`,
    );
  }
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith(GENERATED_IDENTITY_PREFIX)) {
    throw new Error(`Generated Embedded contract at ${file} has no verifiable identity`);
  }
  let identity: unknown;
  try {
    identity = JSON.parse(firstLine.slice(GENERATED_IDENTITY_PREFIX.length));
  } catch {
    throw new Error(`Generated Embedded contract at ${file} has an invalid identity`);
  }
  if (!isGeneratedIdentity(identity)) {
    throw new Error(`Generated Embedded contract at ${file} has an invalid identity`);
  }
  if (identity.formatVersion !== EMBEDDED_GENERATED_FORMAT_VERSION) {
    throw new Error(
      `Generated Embedded contract format ${identity.formatVersion} is unsupported; regenerate ${file}`,
    );
  }
  if (identity.schemaSourceHash !== expected.schemaSourceHash) {
    throw new Error(
      `Generated Embedded contract at ${file} is stale for the current schema source`,
    );
  }
  if (identity.manifestHash !== expected.manifestHash) {
    throw new Error(
      `Generated Embedded contract at ${file} is stale for the current function manifest`,
    );
  }
  const embeddedSchemaMatch = /^export const embeddedSchema = (.+) as const;$/m.exec(source);
  if (embeddedSchemaMatch?.[1] === undefined) {
    throw new Error(`Generated Embedded contract at ${file} has no verifiable schema payload`);
  }
  let embeddedSchema: unknown;
  try {
    embeddedSchema = JSON.parse(embeddedSchemaMatch[1]);
  } catch {
    throw new Error(`Generated Embedded contract at ${file} has an invalid schema payload`);
  }
  if (hashJson(embeddedSchema) !== identity.analysisHash) {
    throw new Error(`Generated Embedded contract at ${file} failed its schema integrity check`);
  }
  return identity;
}

function isGeneratedIdentity(value: unknown): value is {
  analysisHash: string;
  formatVersion: number;
  manifestHash: string;
  schemaSourceHash: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.analysisHash === "string" &&
    typeof identity.formatVersion === "number" &&
    typeof identity.manifestHash === "string" &&
    typeof identity.schemaSourceHash === "string"
  );
}

const CANONICAL_REGISTRATION =
  /export\s+const\s+([$A-Z_a-z][$\w]*)\s*=\s*[$A-Z_a-z][$\w]*\.(replicated|remote|local)\.(query|mutation|internalQuery|internalMutation)\s*\(/g;
const EMBEDDED_REGISTRATION_LIKE =
  /export\s+const\s+([$A-Z_a-z][$\w]*)(?:\s*:[^=;\n]+)?\s*=\s*(?:\(\s*)*[$A-Z_a-z][$\w]*(?:\s*\.\s*[A-Za-z_$][\w$]*){0,2}\s*\.\s*(?:query|mutation|internalQuery|internalMutation)(?:\s*\))*\s*\(/g;
const DIRECT_REGISTRATION =
  /export\s+const\s+([$A-Z_a-z][$\w]*)(?:\s*:[^=;\n]+)?\s*=\s*(?:\(\s*)*(?:query|mutation|internalQuery|internalMutation)(?:\s*\))*\s*\(/g;
const PLACEMENT_BUILDER_REFERENCE =
  /\b[$A-Z_a-z][$\w]*\s*\.\s*(?:replicated|remote|local)\s*\.\s*(?:query|mutation|internalQuery|internalMutation)\b/g;

function readCanonicalRegistrations(
  moduleId: string,
  file: string,
  source: string,
): Record<string, EmbeddedFunctionManifestEntry> {
  const code = maskCommentsAndStrings(source);
  const entries: Record<string, EmbeddedFunctionManifestEntry> = {};
  for (const match of code.matchAll(CANONICAL_REGISTRATION)) {
    const [, name, placement, builder] = match;
    if (!name || !placement || !builder) continue;
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
        `function ${moduleId}:${name} in ${file} must use a canonical embedded.<placement>.<builder> registration`,
      );
    }
  }
  for (const match of code.matchAll(DIRECT_REGISTRATION)) {
    const name = match[1];
    throw new Error(
      `function ${moduleId}:${name ?? "unknown"} in ${file} must use a canonical embedded.<placement>.<builder> registration`,
    );
  }
  const placementReferences = [...code.matchAll(PLACEMENT_BUILDER_REFERENCE)].length;
  if (placementReferences !== canonicalNames.size) {
    throw new Error(
      `function module ${moduleId} in ${file} must call each embedded.<placement>.<builder> directly from its exported canonical registration`,
    );
  }
  return entries;
}

function maskCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "string" = "code";
  let quote = "";
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
      } else if (character === '"' || character === "'" || character === "`") {
        output += " ";
        quote = character;
        state = "string";
      } else {
        output += character;
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
    if (character === "\\") {
      output += " ";
      if (next !== undefined) {
        output += next === "\n" || next === "\r" ? next : " ";
        index += 1;
      }
    } else if (character === quote) {
      output += " ";
      state = "code";
    } else {
      output += character === "\n" || character === "\r" ? character : " ";
    }
  }
  return output;
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

async function listConvexFiles(root: string): Promise<string[]> {
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
        return listConvexFiles(next);
      }
      if (!entry.isFile()) return [] as string[];
      if (!SOURCE_EXTENSIONS.test(entry.name)) return [] as string[];
      if (isDeclarationFile(entry.name)) return [] as string[];
      if (SYSTEM_MODULE_RE.test(entry.name)) return [] as string[];
      if (GENERATED_MODULE_RE.test(entry.name)) return [] as string[];
      return [next];
    }),
  );
  return files.flat().sort();
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
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
    return { paths: [] };
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
  return { baseUrl, paths };
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
      if (await resolveSourcePath(baseUrlTarget)) bases.push(baseUrlTarget);
    }
  }
  for (const base of bases) {
    const resolved = await resolveSourcePath(base);
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

async function resolveSourcePath(base: string): Promise<string | undefined> {
  const candidates: string[] = [base];
  const extension = path.extname(base);
  if (extension === "") {
    for (const sourceExtension of PROJECT_SOURCE_EXTENSIONS) {
      candidates.push(`${base}${sourceExtension}`, path.join(base, `index${sourceExtension}`));
    }
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts"] as const) {
      candidates.push(`${stem}${sourceExtension}`);
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
