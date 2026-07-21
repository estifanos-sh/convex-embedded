import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTarget } from "./cargo.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const targetDir = cargoTarget(repoRoot);
const nativeDir = resolve(packageDir, "native");
const header = resolve(repoRoot, "crates/mobile/include/convex_embedded_mobile.h");
const command = process.argv[2] ?? "verify";
const androidAbis = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"] as const;
const cargoNdkVersion = "3.5.4";
const ndkVersion = "28.1.13356709";
const iosDeploymentTarget = "15.1";
const cSymbols = [
  "cem_api_version",
  "cem_open_path",
  "cem_request",
  "cem_clock_read_value",
  "cem_close",
  "cem_buffer_free",
];
const jniSymbols = [
  "Java_dev_convex_embedded_mobile_Native_apiVersion",
  "Java_dev_convex_embedded_mobile_Native_open",
  "Java_dev_convex_embedded_mobile_Native_call",
  "Java_dev_convex_embedded_mobile_Native_clockRead",
  "Java_dev_convex_embedded_mobile_Native_close",
];

if (command === "ios") buildIos();
else if (command === "android") buildAndroid();
else if (command === "verify") verify();
else if (command === "verify:ios") verifyApple();
else if (command === "verify:android") verifyAndroid();
else throw new Error(`Unknown mobile artifact command: ${command}`);

function buildIos(): void {
  requirePlatform("darwin", "iOS XCFrameworks require Xcode on macOS");
  const triples = ["aarch64-apple-ios", "aarch64-apple-ios-sim", "x86_64-apple-ios"];
  for (const triple of triples) cargoBuild(triple);

  const work = resolve(targetDir, "mobile-xcframework");
  const headers = resolve(work, "headers");
  const simulator = resolve(work, "simulator", "libconvex_embedded_mobile.a");
  const destination = resolve(nativeDir, "apple", "ConvexEmbedded.xcframework");
  rmSync(work, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(headers, { recursive: true });
  mkdirSync(dirname(simulator), { recursive: true });
  copyFileSync(header, resolve(headers, "convex_embedded_mobile.h"));
  writeFileSync(
    resolve(headers, "module.modulemap"),
    'module ConvexEmbeddedMobile { header "convex_embedded_mobile.h" export * }\n',
  );
  exec("lipo", [
    artifact("aarch64-apple-ios-sim", "a"),
    artifact("x86_64-apple-ios", "a"),
    "-create",
    "-output",
    simulator,
  ]);
  mkdirSync(dirname(destination), { recursive: true });
  exec("xcodebuild", [
    "-create-xcframework",
    "-library",
    artifact("aarch64-apple-ios", "a"),
    "-headers",
    headers,
    "-library",
    simulator,
    "-headers",
    headers,
    "-output",
    destination,
  ]);
  verifyApple();
}

function buildAndroid(): void {
  verifyAndroidToolchain();
  const output = resolve(targetDir, "mobile-android");
  rmSync(output, { recursive: true, force: true });
  exec("cargo", [
    "ndk",
    "--platform",
    "24",
    ...androidAbis.flatMap((abi) => ["--target", abi]),
    "--output-dir",
    output,
    "build",
    "--package",
    "mobile",
    "--release",
    "--locked",
  ]);
  for (const abi of androidAbis) {
    const source = resolve(output, abi, "libconvex_embedded_mobile.so");
    const destination = resolve(nativeDir, "android", abi, "libconvex_embedded_mobile.so");
    assertArtifact(source);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  verifyAndroid();
}

function verify(): void {
  verifyHeader();
  verifyApple();
  verifyAndroid();
}

function verifyApple(): void {
  verifyHeader();
  const apple = resolve(nativeDir, "apple", "ConvexEmbedded.xcframework");
  if (!existsSync(apple)) throw new Error(`Missing mobile Apple artifact: ${apple}`);
  const info = resolve(apple, "Info.plist");
  assertArtifact(info);
  const expected = [
    { architectures: ["arm64"], identifier: "ios-arm64", variant: undefined },
    {
      architectures: ["arm64", "x86_64"],
      identifier: "ios-arm64_x86_64-simulator",
      variant: "simulator",
    },
  ] as const;
  if (process.platform !== "darwin") {
    const plist = readFileSync(info, "utf8");
    for (const entry of expected) {
      if (!plist.includes(entry.identifier)) {
        throw new Error(`Apple XCFramework is missing ${entry.identifier}`);
      }
      verifyAppleFiles(apple, entry.identifier, "libconvex_embedded_mobile.a", "Headers");
    }
    return;
  }

  const plist = JSON.parse(execText("plutil", ["-convert", "json", "-o", "-", info])) as {
    AvailableLibraries?: AppleLibrary[];
  };
  if (plist.AvailableLibraries?.length !== expected.length) {
    throw new Error("Apple XCFramework must declare exactly one device and one simulator slice.");
  }
  for (const wanted of expected) {
    const entry = plist.AvailableLibraries.find(
      (candidate) => candidate.LibraryIdentifier === wanted.identifier,
    );
    if (
      !entry ||
      entry.SupportedPlatform !== "ios" ||
      entry.SupportedPlatformVariant !== wanted.variant ||
      entry.SupportedArchitectures.toSorted((left, right) => left.localeCompare(right)).join(
        ",",
      ) !== wanted.architectures.toSorted((left, right) => left.localeCompare(right)).join(",") ||
      entry.BinaryPath !== "libconvex_embedded_mobile.a"
    ) {
      throw new Error(`Apple XCFramework has an invalid ${wanted.identifier} declaration.`);
    }
    const library = verifyAppleFiles(
      apple,
      wanted.identifier,
      entry.LibraryPath,
      entry.HeadersPath,
    );
    verifyAppleSymbols(library, wanted.architectures);
  }
}

interface AppleLibrary {
  BinaryPath: string;
  HeadersPath: string;
  LibraryIdentifier: string;
  LibraryPath: string;
  SupportedArchitectures: string[];
  SupportedPlatform: string;
  SupportedPlatformVariant?: string;
}

function verifyAppleFiles(
  root: string,
  identifier: string,
  libraryPath: string,
  headersPath: string,
): string {
  const directory = resolve(root, identifier);
  const library = resolve(directory, libraryPath);
  const headers = resolve(directory, headersPath);
  assertArtifact(library);
  const packagedHeaderPath = resolve(headers, "convex_embedded_mobile.h");
  const moduleMapPath = resolve(headers, "module.modulemap");
  assertArtifact(packagedHeaderPath);
  assertArtifact(moduleMapPath);
  if (!readFileSync(moduleMapPath, "utf8").includes('header "convex_embedded_mobile.h"')) {
    throw new Error(`${identifier} has an invalid module map.`);
  }
  const packagedHeader = readFileSync(packagedHeaderPath, "utf8");
  for (const symbol of cSymbols) {
    if (!packagedHeader.includes(symbol)) {
      throw new Error(`${identifier} packaged header is missing ${symbol}`);
    }
  }
  return library;
}

function verifyAppleSymbols(library: string, expectedArchitectures: readonly string[]): void {
  const work = mkdtempSync(resolve(tmpdir(), "convex-embedded-mobile-"));
  try {
    const architectures = execText("xcrun", ["lipo", "-archs", library]).trim().split(/\s+/);
    if (
      architectures.toSorted((left, right) => left.localeCompare(right)).join(",") !==
      expectedArchitectures.toSorted((left, right) => left.localeCompare(right)).join(",")
    ) {
      throw new Error(`${library} has unexpected architectures: ${architectures.join(", ")}`);
    }
    for (const architecture of architectures) {
      const directory = resolve(work, architecture);
      mkdirSync(directory, { recursive: true });
      const archive =
        architectures.length === 1 ? library : resolve(directory, "libconvex_embedded_mobile.a");
      if (architectures.length > 1) {
        execText("xcrun", ["lipo", library, "-thin", architecture, "-output", archive]);
      }
      const members = execText("xcrun", ["ar", "-t", archive])
        .split("\n")
        .filter((member) => member.startsWith("convex_embedded_mobile") && member.endsWith(".o"));
      if (members.length === 0) throw new Error(`${library} has no ${architecture} object files.`);
      let symbols = "";
      for (const member of members) {
        execText("xcrun", ["ar", "-x", archive, member], directory);
        symbols += execText("xcrun", ["nm", "-gUj", resolve(directory, member)], directory);
      }
      assertSymbols(symbols, cSymbols, `${library} (${architecture})`);
      verifyAppleDeploymentTargets(archive);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function verifyAppleDeploymentTargets(library: string): void {
  const work = mkdtempSync(resolve(tmpdir(), "convex-embedded-deployment-"));
  try {
    execText("xcrun", ["ar", "-x", library], work);
    const objects = readdirSync(work)
      .filter((entry) => entry.endsWith(".o"))
      .map((entry) => resolve(work, entry));
    if (objects.length === 0) throw new Error(`${library} has no object files.`);
    for (let index = 0; index < objects.length; index += 64) {
      verifyAppleObjectTargets(
        execText("xcrun", ["otool", "-l", ...objects.slice(index, index + 64)]),
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function verifyAppleObjectTargets(output: string): void {
  let object = "unknown object";
  let deploymentCommand = false;
  for (const line of output.split("\n")) {
    if (line.endsWith(":")) {
      object = line.slice(0, -1);
      deploymentCommand = false;
      continue;
    }
    const command = line.match(/^\s*cmd (LC_[A-Z0-9_]+)/)?.[1];
    if (command) {
      deploymentCommand = command === "LC_BUILD_VERSION" || command === "LC_VERSION_MIN_IPHONEOS";
      continue;
    }
    if (!deploymentCommand) continue;
    const version = line.match(/^\s*(?:minos|version) ([0-9]+(?:\.[0-9]+)*)$/)?.[1];
    if (version && compareVersion(version, iosDeploymentTarget) > 0) {
      throw new Error(
        `${object} targets iOS ${version}, newer than package minimum ${iosDeploymentTarget}.`,
      );
    }
  }
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function verifyAndroid(): void {
  verifyHeader();
  const readelf = androidTool("llvm-readelf");
  const nm = androidTool("llvm-nm");
  const machines: Record<(typeof androidAbis)[number], RegExp> = {
    "arm64-v8a": /AArch64/,
    "armeabi-v7a": /ARM/,
    x86: /Intel 80386/,
    x86_64: /Advanced Micro Devices X86-64/,
  };
  for (const abi of androidAbis) {
    const library = resolve(nativeDir, "android", abi, "libconvex_embedded_mobile.so");
    assertArtifact(library);
    const header = execText(readelf, ["-hW", library]);
    if (!machines[abi].test(header)) throw new Error(`Android artifact has the wrong ABI: ${abi}`);
    const programHeaders = execText(readelf, ["-lW", library]);
    const loadAlignments = programHeaders
      .split("\n")
      .filter((line) => /^\s*LOAD\s/.test(line))
      .map((line) => Number.parseInt(line.trim().split(/\s+/).at(-1) ?? "0", 16));
    if (loadAlignments.length === 0 || loadAlignments.some((alignment) => alignment < 0x4000)) {
      throw new Error(`Android artifact is not 16 KiB page aligned: ${abi}`);
    }
    assertSymbols(
      execText(nm, ["-D", "--defined-only", "--just-symbol-name", library]),
      jniSymbols,
      abi,
    );
  }
}

function verifyHeader(): void {
  const headerText = readFileSync(header, "utf8");
  for (const symbol of cSymbols) {
    if (!headerText.includes(symbol)) throw new Error(`Mobile C header is missing ${symbol}`);
  }
}

function verifyAndroidToolchain(): void {
  const version = execText("cargo", ["ndk", "--version"]);
  if (!version.includes(cargoNdkVersion)) {
    throw new Error(`cargo-ndk ${cargoNdkVersion} is required; received ${version.trim()}`);
  }
  const properties = readFileSync(resolve(androidNdk(), "source.properties"), "utf8");
  if (!properties.includes(`Pkg.Revision = ${ndkVersion}`)) {
    throw new Error(`Android NDK ${ndkVersion} is required.`);
  }
}

function androidNdk(): string {
  const path = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT;
  if (!path) throw new Error("ANDROID_NDK_HOME must point to the pinned Android NDK.");
  return path;
}

function androidTool(name: "llvm-nm" | "llvm-readelf"): string {
  if (!process.env.ANDROID_NDK_HOME && !process.env.ANDROID_NDK_ROOT) {
    return name === "llvm-readelf" ? "readelf" : "nm";
  }
  const roots = resolve(androidNdk(), "toolchains", "llvm", "prebuilt");
  const hosts = readdirSync(roots).filter((entry) => !entry.startsWith("."));
  if (hosts.length !== 1) throw new Error(`Could not resolve ${name} from the Android NDK.`);
  const tool = resolve(roots, hosts[0], "bin", name);
  assertArtifact(tool);
  return tool;
}

function assertSymbols(output: string, symbols: readonly string[], artifactName: string): void {
  const exported = new Set(
    output
      .split("\n")
      .map((line) => line.trim().replace(/^_/, ""))
      .filter(Boolean),
  );
  for (const symbol of symbols) {
    if (!exported.has(symbol))
      throw new Error(`${artifactName} is missing native symbol ${symbol}`);
  }
}

function cargoBuild(triple: string): void {
  exec("cargo", ["build", "--package", "mobile", "--release", "--locked", "--target", triple], {
    IPHONEOS_DEPLOYMENT_TARGET: iosDeploymentTarget,
  });
}

function artifact(triple: string, extension: "a"): string {
  const path = resolve(targetDir, triple, "release", `libconvex_embedded_mobile.${extension}`);
  assertArtifact(path);
  return path;
}

function assertArtifact(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Missing or empty mobile artifact: ${path}`);
  }
}

function exec(
  command: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
): void {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...environment, CARGO_TARGET_DIR: targetDir },
    stdio: "inherit",
  });
}

function execText(command: string, args: string[], cwd = repoRoot): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function requirePlatform(platform: NodeJS.Platform, message: string): void {
  if (process.platform !== platform) throw new Error(message);
}
