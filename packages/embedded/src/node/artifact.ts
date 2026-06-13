import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loaded NAPI module shape expected by the Node adapter.
 *
 * @internal
 */
export interface NativeModule {
  apiVersion(): number;
  Store: {
    open(path: string, identityKey?: string): unknown;
  };
}

const NATIVE_API_VERSION = 6;
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Loads and validates the platform native storage artifact.
 *
 * @internal
 * @todo Replace dev artifact probing with packaged per-platform optional dependencies once the
 * native release layout is stable.
 */
export function loadNativeModule(): NativeModule {
  const candidates = nativeArtifactCandidates();
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return validateNativeModule(require(loadableArtifactPath(candidate)), candidate);
    } catch (error) {
      failures.push(`${candidate}: ${errorMessage(error)}`);
    }
  }

  throw new Error(nativeArtifactError(candidates, failures));
}

function validateNativeModule(value: unknown, path: string): NativeModule {
  const module = value as Partial<NativeModule>;
  if (typeof module.apiVersion !== "function") {
    throw new Error(`native artifact did not export apiVersion: ${path}`);
  }
  const version = module.apiVersion();
  if (version !== NATIVE_API_VERSION) {
    throw new Error(
      `native artifact API version mismatch at ${path}: expected ${NATIVE_API_VERSION}, got ${version}`,
    );
  }
  if (typeof module.Store?.open !== "function") {
    throw new Error(`native artifact did not export Store.open: ${path}`);
  }
  return module as NativeModule;
}

function loadableArtifactPath(path: string): string {
  if (extname(path) === ".node") return path;
  const stat = statSync(path);
  const key = createHash("sha256")
    .update(path)
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest("hex")
    .slice(0, 16);
  const name = `convex-embedded-${key}-${basename(path)}.node`;
  const copy = join(tmpdir(), name);
  pruneArtifactCopies(basename(path), name);
  copyFileSync(path, copy);
  return copy;
}

/** Every rebuild changes the copy key, so a load prunes this artifact's stale siblings. */
function pruneArtifactCopies(sourceName: string, keep: string): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keep) continue;
    if (!entry.startsWith("convex-embedded-") || !entry.endsWith(`-${sourceName}.node`)) continue;
    try {
      unlinkSync(join(tmpdir(), entry));
    } catch {
      // Best-effort: the copy may be loaded by another live process.
    }
  }
}

function nativeArtifactCandidates(): string[] {
  const explicit = process.env.CONVEX_EMBEDDED_NATIVE;
  if (explicit && (!isAbsolute(explicit) || extname(explicit) !== ".node")) {
    throw new Error("CONVEX_EMBEDDED_NATIVE must be an absolute path to a .node artifact");
  }
  const target = nativeTarget();
  const packageCandidates = [
    resolve(here, "native", target, "convex-embedded.node"),
    resolve(here, "..", "native", target, "convex-embedded.node"),
    resolve(here, "../../dist/native", target, "convex-embedded.node"),
  ];
  if (process.env.CONVEX_EMBEDDED_DEV_NATIVE !== "1") {
    return unique([...(explicit ? [explicit] : []), ...packageCandidates]);
  }
  const roots = [resolve(here, "../../.."), resolve(here, "../../../..")];
  const devCandidates = roots.flatMap((root) => [
    resolve(root, "target/release/convex-embedded.node"),
    resolve(root, "target/debug/convex-embedded.node"),
    resolve(root, "target/release/node.node"),
    resolve(root, "target/debug/node.node"),
    resolve(root, "target/release/libnode.dylib"),
    resolve(root, "target/debug/libnode.dylib"),
    resolve(root, "target/release/libnode.so"),
    resolve(root, "target/debug/libnode.so"),
    resolve(root, "target/release/node.dll"),
    resolve(root, "target/debug/node.dll"),
  ]);

  return unique([...(explicit ? [explicit] : []), ...packageCandidates, ...devCandidates]);
}

function nativeTarget(): string {
  const arch = process.arch;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "linux") {
    return `linux-${arch}-${hasGlibc() ? "gnu" : "musl"}`;
  }
  return `${process.platform}-${arch}`;
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return Boolean(report?.header?.glibcVersionRuntime);
}

function nativeArtifactError(candidates: string[], failures: string[]): string {
  const lines = [
    "ConvexEmbeddedClient could not load the native storage artifact.",
    "Set CONVEX_EMBEDDED_NATIVE to an absolute .node artifact path, or build/package the Node artifact.",
    "Checked:",
    ...candidates.map((candidate) => `  - ${candidate}`),
  ];
  if (failures.length) {
    lines.push("Load failures:", ...failures.map((failure) => `  - ${failure}`));
  }
  return lines.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
