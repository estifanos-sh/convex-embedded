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
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

  /**
   * Convex module IDs mapped to absolute source file paths.
   */
  modules: Record<string, string>;
}

const DEFAULT_CONVEX_DIR = "convex";
const DEFAULT_SCHEMA_PATH = "schema.ts";
const EMBEDDED_ENTRYPOINT_PATH = "embedded.ts";
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SYSTEM_MODULE_RE =
  /^(?:convex\.config|auth\.config|crons|http)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const GENERATED_MODULE_RE = /^embedded\.generated\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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
  const root = path.resolve(input.root ?? process.cwd());
  const convexDir = resolveInputPath(root, input.convexDir ?? DEFAULT_CONVEX_DIR);
  const schemaPath = resolveInputPath(convexDir, input.schemaPath ?? DEFAULT_SCHEMA_PATH);
  const embeddedPath = resolveInputPath(convexDir, EMBEDDED_ENTRYPOINT_PATH);
  await assertSchemaFile(schemaPath);
  await assertEmbeddedEntrypoint(embeddedPath);
  const files = await listConvexFiles(convexDir);
  const modules: Record<string, string> = {};
  const seen = new Map<string, string>();

  for (const file of files) {
    const resolved = path.resolve(file);
    if (resolved === schemaPath || resolved === embeddedPath) continue;
    if (hasUseNodeDirective(await readFile(file, "utf8"))) continue;
    const moduleId = toModuleId(convexDir, file);
    const existing = seen.get(moduleId);
    if (existing !== undefined) {
      throw new Error(`Duplicate Convex module id "${moduleId}" from "${existing}" and "${file}".`);
    }
    seen.set(moduleId, file);
    modules[moduleId] = file;
  }

  return {
    modules,
    schemaPath,
  };
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
