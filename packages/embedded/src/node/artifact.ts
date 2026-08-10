import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../error";
import { CURRENT_WIRE_CONTRACT_ID } from "../protocol";
import { CURRENT_STORAGE_BINDING_CONTRACT_ID } from "../storage/contract";

/**
 * Loaded NAPI module shape expected by the Node adapter.
 *
 * @internal
 */
export interface NativeModule {
  bindingContractId(): string;
  contractId(): string;
  Store: {
    open(path: string, selectorKey?: string, defaultIdentityKey?: string): unknown;
  };
}

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Loads and validates the platform native storage artifact.
 *
 * @internal
 */
export function loadNativeModule(): NativeModule {
  const explicit = process.env.CONVEX_EMBEDDED_NATIVE;
  const unsupported = nativePlatformUnsupported();
  if (!explicit && unsupported) throw new Error(unsupported);
  const candidates = nativeArtifactCandidates();
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded = validateNativeModule(require(loadableArtifactPath(candidate)), candidate);
      if (process.env.CONVEX_EMBEDDED_NATIVE_TRACE === "1") {
        console.error(`Loaded native artifact: ${candidate}`);
      }
      return loaded;
    } catch (error) {
      failures.push(`${candidate}: ${errorMessage(error)}`);
      if (process.env.CONVEX_EMBEDDED_NATIVE_TRACE === "1") {
        console.error(`Failed native artifact: ${candidate}: ${errorMessage(error)}`);
      }
    }
  }

  throw new Error(nativeArtifactError(candidates, failures));
}

export function validateNativeModule(value: unknown, path: string): NativeModule {
  const module = value as Partial<NativeModule>;
  if (typeof module.bindingContractId !== "function") {
    throw new Error(`native artifact did not export bindingContractId: ${path}`);
  }
  const bindingContractId = module.bindingContractId();
  if (bindingContractId !== CURRENT_STORAGE_BINDING_CONTRACT_ID) {
    throw new Error(
      `native artifact binding contract mismatch at ${path}: expected ${CURRENT_STORAGE_BINDING_CONTRACT_ID}, got ${bindingContractId}`,
    );
  }
  if (typeof module.contractId !== "function") {
    throw new Error(`native artifact did not export contractId: ${path}`);
  }
  const contractId = module.contractId();
  if (contractId !== CURRENT_WIRE_CONTRACT_ID) {
    throw new Error(
      `native artifact wire contract mismatch at ${path}: expected ${CURRENT_WIRE_CONTRACT_ID}, got ${contractId}`,
    );
  }
  if (typeof module.Store?.open !== "function") {
    throw new Error(`native artifact did not export Store.open: ${path}`);
  }
  return module as NativeModule;
}

function loadableArtifactPath(path: string): string {
  const stat = statSync(path);
  const key = createHash("sha256")
    .update(path)
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest("hex")
    .slice(0, 16);
  const name = `convex-embedded-${key}-${basename(path)}.node`;
  const copy = join(tmpdir(), name);
  artifactCopyDelete(basename(path), name);
  copyFileSync(path, copy);
  return copy;
}

/** Every rebuild changes the copy key, so a load deletes this artifact's stale siblings. */
function artifactCopyDelete(sourceName: string, keep: string): void {
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
  const cwd = process.cwd();
  const roots = unique([
    resolve(here, "../../.."),
    resolve(here, "../../../.."),
    cwd,
    resolve(cwd, ".."),
    resolve(cwd, "../.."),
  ]);
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

  return unique([...(explicit ? [explicit] : []), ...devCandidates, ...packageCandidates]);
}

/** Return the actionable reason a Node target lacks a package-owned native artifact. @internal */
export function nativePlatformUnsupported(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  if (platform === "darwin" && arch === "x64") {
    return [
      "Convex Embedded does not ship a prebuilt Node artifact for Intel macOS (darwin-x64).",
      "Use an Apple Silicon Mac, or build a compatible .node artifact from source and set CONVEX_EMBEDDED_NATIVE to its absolute path.",
    ].join(" ");
  }
  return undefined;
}

function nativeTarget(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "win32") return `win32-${arch}`;
  if (platform === "linux") {
    return `linux-${arch}-${hasGlibc() ? "gnu" : "musl"}`;
  }
  return `${platform}-${arch}`;
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
    "Set CONVEX_EMBEDDED_NATIVE to an absolute .node artifact path, or run `vp run @estifanos-sh/convex-embedded#build` to package the Node artifact.",
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
