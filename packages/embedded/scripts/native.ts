import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTarget } from "./cargo.ts";
import { EMBEDDED_PROTOCOL_VERSION } from "../src/protocol.ts";
import { EMBEDDED_STORAGE_ABI_VERSION } from "../src/abi.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const require = createRequire(import.meta.url);
const target = nativeTarget();
const cargoTargetDir = cargoTarget(repoRoot);
const destinationDir = resolve(packageDir, "dist/native", target);
const destination = resolve(destinationDir, "convex-embedded.node");

execFileSync("cargo", ["build", "-p", "node", "--release", "--locked"], {
  cwd: repoRoot,
  env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
  stdio: "inherit",
});
const source = nativeSource();
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
loadNativeArtifact(destination);
console.log(`Copied native artifact: ${destination}`);

function nativeSource(): string {
  const candidates = nativeSourceCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      [
        "Native build completed without a release artifact.",
        "Checked:",
        ...candidates.map((candidate) => `  - ${candidate}`),
      ].join("\n"),
    );
  }
  return found;
}

function nativeSourceCandidates(): string[] {
  const platformArtifact =
    process.platform === "darwin"
      ? "release/libnode.dylib"
      : process.platform === "win32"
        ? "release/node.dll"
        : "release/libnode.so";
  return [
    resolve(cargoTargetDir, platformArtifact),
    resolve(cargoTargetDir, "release/convex-embedded.node"),
    resolve(cargoTargetDir, "release/node.node"),
    resolve(cargoTargetDir, "release/libnode.dylib"),
    resolve(cargoTargetDir, "release/libnode.so"),
    resolve(cargoTargetDir, "release/node.dll"),
  ];
}

function loadNativeArtifact(path: string): void {
  const probe = resolve(tmpdir(), `convex-embedded-native-probe-${process.pid}-${Date.now()}.node`);
  copyFileSync(path, probe);
  try {
    const module = require(probe) as {
      apiVersion?: () => number;
      protocolVersion?: () => number;
    };
    if (module.apiVersion?.() !== EMBEDDED_STORAGE_ABI_VERSION) {
      throw new Error(`Native artifact API version mismatch after copy: ${path}`);
    }
    if (module.protocolVersion?.() !== EMBEDDED_PROTOCOL_VERSION) {
      throw new Error(`Native artifact protocol version mismatch after copy: ${path}`);
    }
  } finally {
    unlinkSync(probe);
  }
}

function nativeTarget(): string {
  const arch = process.arch;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "linux") return `linux-${arch}-${hasGlibc() ? "gnu" : "musl"}`;
  return `${process.platform}-${arch}`;
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return Boolean(report?.header?.glibcVersionRuntime);
}
