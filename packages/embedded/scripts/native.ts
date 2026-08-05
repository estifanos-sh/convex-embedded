import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTargetDir } from "../../../config/build.ts";
import { EMBEDDED_PROTOCOL_VERSION } from "../src/protocol.ts";
import { EMBEDDED_STORAGE_ABI_VERSION } from "../src/abi.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const target = nativeTarget();
const targetDir = cargoTargetDir();
const destinationDir = resolve(packageDir, "dist/native", target);
const destination = resolve(destinationDir, "convex-embedded.node");

execFileSync("cargo", ["build", "-p", "node", "--release", "--locked"], {
  cwd: repoRoot,
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
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
    resolve(targetDir, platformArtifact),
    resolve(targetDir, "release/convex-embedded.node"),
    resolve(targetDir, "release/node.node"),
    resolve(targetDir, "release/libnode.dylib"),
    resolve(targetDir, "release/libnode.so"),
    resolve(targetDir, "release/node.dll"),
  ];
}

function loadNativeArtifact(path: string): void {
  const probe = resolve(
    tmpdir(),
    `convex-embedded-native-probe-${process.pid}-${randomUUID()}.node`,
  );
  copyFileSync(path, probe);
  try {
    // Windows keeps an addon locked for the lifetime of the process that loaded it. Probe in a
    // child so the handle is closed before this process removes the temporary copy.
    execFileSync(
      process.execPath,
      [
        "-e",
        `
          const module = require(process.argv[1]);
          const api = Number(process.argv[2]);
          const protocol = Number(process.argv[3]);
          const source = process.argv[4];
          if (module.apiVersion?.() !== api) {
            throw new Error(\`Native artifact API version mismatch after copy: \${source}\`);
          }
          if (module.protocolVersion?.() !== protocol) {
            throw new Error(\`Native artifact protocol version mismatch after copy: \${source}\`);
          }
        `,
        probe,
        String(EMBEDDED_STORAGE_ABI_VERSION),
        String(EMBEDDED_PROTOCOL_VERSION),
        path,
      ],
      { stdio: "inherit" },
    );
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
