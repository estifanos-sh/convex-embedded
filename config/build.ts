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
export const iosTargetTriples = ["aarch64-apple-ios", "aarch64-apple-ios-sim"] as const;

/** The Android ABIs the mobile shared libraries are built for. */
export const androidAbis = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"] as const;

/**
 * Narrow a mobile build to the slices named by `CONVEX_EMBEDDED_MOBILE_SLICES` — Apple target
 * triples for iOS, ABI names for Android. Per-push CI requests one slice per platform; local and
 * release builds leave it unset and produce the whole set.
 */
export function mobileSlices<Slice extends string>(all: readonly Slice[]): Slice[] {
  const requested = readValue("CONVEX_EMBEDDED_MOBILE_SLICES");
  if (!requested) return [...all];
  const selected = requested.split(",").map((part) => part.trim());
  const slices = all.filter((slice) => selected.includes(slice));
  if (slices.length !== selected.length) {
    throw new Error(
      `CONVEX_EMBEDDED_MOBILE_SLICES must name distinct slices from ${all.join(", ")}; ` +
        `received ${requested}.`,
    );
  }
  return slices;
}
