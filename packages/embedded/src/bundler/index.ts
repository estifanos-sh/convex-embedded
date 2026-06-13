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
import { readdir, stat } from "node:fs/promises";
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
const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;

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
  await assertSchemaFile(schemaPath);
  const files = await listConvexFiles(convexDir);
  const modules: Record<string, string> = {};
  const seen = new Map<string, string>();

  for (const file of files) {
    if (path.resolve(file) === schemaPath) continue;
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

/**
 * Converts a file path under `convexDir` into a canonical Convex module ID.
 *
 * @param convexDir - Absolute or relative Convex source directory.
 * @param filePath - Source file path inside `convexDir`.
 * @returns Convex module ID without the TypeScript extension.
 *
 * @internal
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
      if (!TS_EXTENSIONS.test(entry.name)) return [] as string[];
      if (isDeclarationFile(entry.name)) return [] as string[];
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

function isDeclarationFile(name: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/.test(name);
}
