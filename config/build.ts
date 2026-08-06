import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  if (path) return path;
  const pinned = androidSdkCandidates()
    .map((sdk) => resolve(sdk, "ndk", androidNdkVersion))
    .find((candidate) => existsSync(resolve(candidate, "source.properties")));
  if (pinned) return pinned;
  throw new Error(
    `Android NDK ${androidNdkVersion} was not found. Set ANDROID_NDK_HOME, or install the ` +
      "pinned NDK under ANDROID_HOME/ANDROID_SDK_ROOT.",
  );
}

/** Resolve an explicit SDK first, then standard Android Studio and Homebrew installations. */
export function androidSdk(): string | undefined {
  const candidates = androidSdkCandidates();
  return (
    candidates.find((sdk) =>
      existsSync(resolve(sdk, "ndk", androidNdkVersion, "source.properties")),
    ) ??
    candidates.find((sdk) => existsSync(resolve(sdk, "cmdline-tools"))) ??
    candidates.find(existsSync)
  );
}

function androidSdkCandidates(): string[] {
  const configured = readValue("ANDROID_HOME") ?? readValue("ANDROID_SDK_ROOT");
  return [
    ...(configured ? [configured] : []),
    resolve(homedir(), "Library/Android/sdk"),
    resolve(homedir(), "Android/Sdk"),
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
  ];
}

/** Resolve JDK 17 from the environment or Homebrew without requiring a privileged macOS install. */
export function javaHome(): string | undefined {
  const configured = readValue("JAVA_HOME");
  if (configured) return configured;
  return [
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
  ].find(existsSync);
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
