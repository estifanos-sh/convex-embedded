import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const require = createRequire(import.meta.url);
const nativeApiVersion = 6;
const target = nativeTarget();
const destinationDir = resolve(packageDir, "dist/native", target);
const destination = resolve(destinationDir, "convex-embedded.node");

const source = nativeSource();
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
loadNativeArtifact(destination);
console.log(`Copied native artifact: ${destination}`);

function nativeSource(): string {
  const candidates = nativeSourceCandidates().map((candidate) => resolve(repoRoot, candidate));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      [
        "No release native artifact found. Run `cargo build -p node --release --locked` first.",
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
      ? "target/release/libnode.dylib"
      : process.platform === "win32"
        ? "target/release/node.dll"
        : "target/release/libnode.so";
  return [
    platformArtifact,
    "target/release/convex-embedded.node",
    "target/release/node.node",
    "target/release/libnode.dylib",
    "target/release/libnode.so",
    "target/release/node.dll",
  ];
}

function loadNativeArtifact(path: string): void {
  const module = require(path) as { apiVersion?: () => number };
  if (module.apiVersion?.() !== nativeApiVersion) {
    throw new Error(`Native artifact API version mismatch after copy: ${path}`);
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
