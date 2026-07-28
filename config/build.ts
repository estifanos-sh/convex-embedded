import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readFlag, readValue, repoRoot } from "./read.ts";

/** Cargo's shared out-of-tree target directory, kept off the package root. */
export function cargoTargetDir(): string {
  const configured = readValue("CARGO_TARGET_DIR");
  return configured ? resolve(repoRoot, configured) : resolve(tmpdir(), "embedded-target");
}

export function skipWasmOpt(): boolean {
  return readFlag("CONVEX_EMBEDDED_SKIP_WASM_OPT");
}

/** The pinned Android NDK root, required by the mobile artifact toolchain. */
export function androidNdk(): string {
  const path = readValue("ANDROID_NDK_HOME") ?? readValue("ANDROID_NDK_ROOT");
  if (!path) throw new Error("ANDROID_NDK_HOME must point to the pinned Android NDK.");
  return path;
}

/** The Android NDK revision pinned across the mobile artifact build and the EAS pre-install hook. */
export const androidNdkVersion = "28.1.13356709";

/** The cargo-ndk release pinned for reproducible Android artifact builds. */
export const cargoNdkVersion = "3.5.4";

/** The Apple target triples the iOS XCFramework is assembled from. */
export const iosTargetTriples = [
  "aarch64-apple-ios",
  "aarch64-apple-ios-sim",
  "x86_64-apple-ios",
] as const;
