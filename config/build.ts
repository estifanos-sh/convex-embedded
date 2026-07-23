import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readFlag, readNumber, readValue, repoRoot } from "./read.ts";

/** Cargo's shared out-of-tree target directory, kept off the package root. */
export function cargoTargetDir(): string {
  const configured = readValue("CARGO_TARGET_DIR");
  return configured ? resolve(repoRoot, configured) : resolve(tmpdir(), "embedded-target");
}

export function skipWasmOpt(): boolean {
  return readFlag("CONVEX_EMBEDDED_SKIP_WASM_OPT");
}

export function sizeBrotliQuality(): number {
  return readNumber("CONVEX_EMBEDDED_SIZE_BROTLI_QUALITY", 1);
}

export function benchSkipNativeBuild(): boolean {
  return readFlag("CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD");
}

/** The pinned Android NDK root, required by the mobile artifact toolchain. */
export function androidNdk(): string {
  const path = readValue("ANDROID_NDK_HOME") ?? readValue("ANDROID_NDK_ROOT");
  if (!path) throw new Error("ANDROID_NDK_HOME must point to the pinned Android NDK.");
  return path;
}
