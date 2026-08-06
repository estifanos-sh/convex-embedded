import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sourcePackageName = "@convex-dev/embedded";
export const publishedPackageName = "@robelest/convex-embedded";
export const publishedRepository = "https://github.com/get-convex/embedded";
export const preview2Version = "0.0.1-preview-2";
export const preview2Tag = `robelest-v${preview2Version}`;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = resolve(packageDir, "../..");
const lifecycleScripts = ["install", "postinstall", "prepack", "prepare", "prepublishOnly"];
const nodeTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64",
] as const;
const androidAbis = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"] as const;
const appleSlices = ["ios-arm64", "ios-arm64-simulator"] as const;

interface PackageJson {
  author?: string;
  bugs?: { url: string } | string;
  exports?: unknown;
  homepage?: string;
  license?: string;
  name?: string;
  peerDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  repository?: { type: string; url: string } | string;
  scripts?: Record<string, string>;
  version?: string;
  [key: string]: unknown;
}

export type PublishMode = "preview" | "prerelease" | "release";

/**
 * Stamp the version consumed by tsdown before it emits package artifacts.
 *
 * This deliberately leaves the source package identity intact: the Robelest rename happens only
 * in the assembled publication tree. Separate CI jobs start from fresh checkouts, so this must
 * run in every job that produces distributable JavaScript.
 */
export function prepareBuildVersion(directory: string, version?: string): PackageJson {
  const path = resolve(directory, "package.json");
  const manifest = readPackageJson(path);
  if (manifest.name !== sourcePackageName) {
    throw new Error(
      `Refusing to build ${String(manifest.name)}; expected source package ${sourcePackageName}.`,
    );
  }
  if (version === undefined) return manifest;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    throw new Error(`Embedded package build version must be semver; received ${version}.`);
  }
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Keep a frozen fixture directory to its two reviewable, durable release artifacts. */
export function verifyFixtureFiles(directory: string): void {
  const expected = ["manifest.json", "store.sqlite3"];
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Preview2 fixture directory must contain only ${expected.join(", ")}; found ${actual.join(", ") || "nothing"}.`,
    );
  }
  for (const name of expected) {
    const path = resolve(directory, name);
    if (!statSync(path).isFile())
      throw new Error(`Preview2 fixture artifact is not a file: ${name}.`);
  }
}

/** Before its immutable tag exists, Preview2 may authorize only its own named prerelease. */
export function verifyPreview2PendingVersion(requestedVersion?: string): void {
  if (requestedVersion && requestedVersion !== preview2Version) {
    throw new Error(
      `Preview2 must first publish as ${preview2Tag}; refusing ${requestedVersion} while that immutable tag is missing.`,
    );
  }
}

/** Require the exact, checksummed Preview2 writer artifact before any package tag or assembly. */
export function verifyPreview2Fixture(): void {
  const directory = resolve(repositoryDir, "crates/storage/tests/fixtures/preview2");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error("Preview2 SQLite fixture and semantic manifest are required for publication.");
  }
  verifyFixtureFiles(directory);
  const fixture = resolve(directory, "store.sqlite3");
  const manifestPath = resolve(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    releaseIdentity?: string;
    releasePackage?: string;
    releaseVersion?: string;
    fixtureContractVersion?: number;
    epoch?: number;
    bootstrapVersion?: number;
    sha256?: string;
    permanentOriginKinds?: number[];
    semanticDigest?: string;
    semanticSnapshot?: unknown;
    portableOracle?: unknown;
    originInventory?: unknown[];
    referencedPayloadCount?: number;
    contract?: Record<string, unknown>;
  };
  const checksum = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  if (manifest.sha256 !== checksum) {
    throw new Error(
      `Preview2 fixture checksum mismatch: expected ${manifest.sha256}, got ${checksum}.`,
    );
  }
  if (manifest.epoch !== 47 || manifest.bootstrapVersion !== 1) {
    throw new Error("Preview2 fixture semantic version oracle is invalid.");
  }
  if (
    manifest.releaseIdentity !== preview2Tag ||
    manifest.releasePackage !== publishedPackageName ||
    manifest.releaseVersion !== preview2Version ||
    manifest.fixtureContractVersion !== 1 ||
    !manifest.contract?.kernelLayoutHash ||
    !manifest.contract?.generationLayoutHash ||
    !manifest.contract?.originWriterHash ||
    !manifest.contract?.originReaderHash ||
    !Array.isArray(manifest.originInventory) ||
    manifest.portableOracle === undefined ||
    typeof manifest.referencedPayloadCount !== "number"
  ) {
    throw new Error("Preview2 fixture release identity or semantic contract is incomplete.");
  }
  const semanticDigest = createHash("sha256")
    .update(JSON.stringify(manifest.semanticSnapshot))
    .digest("hex");
  if (semanticDigest !== manifest.semanticDigest) {
    throw new Error("Preview2 fixture semantic snapshot digest does not match its manifest.");
  }
  const expectedKinds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17];
  if (JSON.stringify(manifest.permanentOriginKinds) !== JSON.stringify(expectedKinds)) {
    throw new Error("Preview2 fixture does not enumerate every permanent originated record kind.");
  }

  // Once Preview2 has been tagged, its pair is immutable. Later releases may only add sibling
  // fixture directories; they cannot silently refresh the baseline with the current writer.
  const releaseTag = preview2Tag;
  let released = false;
  try {
    execFileSync("git", ["cat-file", "-e", `${releaseTag}^{commit}`], {
      cwd: repositoryDir,
      stdio: "ignore",
    });
    released = true;
  } catch {
    verifyPreview2PendingVersion(process.env.CONVEX_EMBEDDED_PUBLISH_VERSION?.trim());
  }
  if (released) {
    for (const relative of [
      "crates/storage/tests/fixtures/preview2/store.sqlite3",
      "crates/storage/tests/fixtures/preview2/manifest.json",
    ]) {
      const tagged = execFileSync("git", ["show", `${releaseTag}:${relative}`], {
        cwd: repositoryDir,
      });
      const current = readFileSync(resolve(repositoryDir, relative));
      if (!tagged.equals(current)) {
        throw new Error(`${relative} differs from immutable release ${releaseTag}.`);
      }
    }
  }
}

/** Rewrite only the ephemeral package copy assembled by CI for Robelest publication. */
export function preparePackage(directory: string, version?: string): PackageJson {
  const path = resolve(directory, "package.json");
  const manifest = readPackageJson(path);
  if (manifest.name !== sourcePackageName) {
    throw new Error(
      `Refusing to prepare ${String(manifest.name)}; expected source package ${sourcePackageName}.`,
    );
  }

  manifest.name = publishedPackageName;
  if (version !== undefined) manifest.version = version;
  manifest.author = "robelest";
  manifest.license ??= "MIT";
  manifest.repository = { type: "git", url: `git+${publishedRepository}.git` };
  manifest.homepage = `${publishedRepository}#readme`;
  manifest.bugs = { url: `${publishedRepository}/issues` };
  manifest.publishConfig = { ...manifest.publishConfig, access: "public" };
  if (manifest.scripts) {
    for (const script of lifecycleScripts) delete manifest.scripts[script];
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Every prebuilt that must be present in the npm tarball. */
export function requiredPackageFiles(): string[] {
  return [
    "ConvexEmbeddedNative.podspec",
    "LICENSE",
    "README.md",
    "android/build.gradle",
    "android/src/main/java/dev/convex/embedded/mobile/Native.kt",
    "android/src/main/java/expo/modules/convexembedded/ConvexEmbeddedNativeModule.kt",
    "dist/browser-embedded.mjs",
    "dist/browser.mjs",
    "dist/artifact.json",
    "dist/expo/index.mjs",
    "dist/node.mjs",
    "dist/thread/browser-worker.mjs",
    "dist/wasm/index.wasm",
    "expo-module.config.json",
    "ios/ConvexEmbeddedNativeModule.swift",
    ...nodeTargets.map((target) => `dist/native/${target}/convex-embedded.node`),
    ...androidAbis.map((abi) => `native/android/${abi}/libconvex_embedded_mobile.so`),
    "native/apple/ConvexEmbedded.xcframework/Info.plist",
    ...appleSlices.flatMap((slice) => [
      `native/apple/ConvexEmbedded.xcframework/${slice}/Headers/convex_embedded_mobile.h`,
      `native/apple/ConvexEmbedded.xcframework/${slice}/Headers/module.modulemap`,
      `native/apple/ConvexEmbedded.xcframework/${slice}/libconvex_embedded_mobile.a`,
    ]),
  ].sort();
}

export function verifyPackageTree(directory: string, mode: PublishMode): void {
  const manifest = readPackageJson(resolve(directory, "package.json"));
  verifyManifest(manifest, mode);
  for (const path of new Set([...requiredPackageFiles(), ...exportedPackageFiles(manifest)])) {
    const absolute = resolve(directory, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile() || statSync(absolute).size === 0) {
      throw new Error(`Robelest package is missing required artifact: ${path}`);
    }
  }
  verifyArtifactVersion(readArtifact(directory), manifest.version);
}

export function verifyPackedFiles(files: ReadonlySet<string>, manifest?: PackageJson): void {
  const expected = [...requiredPackageFiles(), ...(manifest ? exportedPackageFiles(manifest) : [])];
  for (const path of new Set(expected)) {
    if (!files.has(`package/${path}`)) {
      throw new Error(`Robelest tarball is missing required artifact: ${path}`);
    }
  }
}

export function packPackage(directory: string, destination: string, mode: PublishMode): string {
  verifyPackageTree(directory, mode);
  mkdirSync(destination, { recursive: true });
  const before = new Set(readdirSync(destination));
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: directory,
    env: process.env,
    stdio: "inherit",
  });
  const created = readdirSync(destination).filter(
    (name) => name.endsWith(".tgz") && !before.has(name),
  );
  if (created.length !== 1) {
    throw new Error(`Expected pnpm pack to create one tarball, found ${created.length}.`);
  }
  const packed = resolve(destination, created[0]!);
  const stable = resolve(destination, "convex-embedded.tgz");
  renameSync(packed, stable);
  verifyTarball(stable, mode);
  console.log(stable);
  return stable;
}

export function verifyTarball(path: string, mode: PublishMode): void {
  const files = new Set(
    execFileSync("tar", ["-tzf", path], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^\.\//, "")),
  );
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/package.json"], { encoding: "utf8" }),
  ) as PackageJson;
  verifyPackedFiles(files, manifest);
  verifyManifest(manifest, mode);
  const artifact = JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/dist/artifact.json"], { encoding: "utf8" }),
  ) as unknown;
  verifyArtifactVersion(artifact, manifest.version);
  if (JSON.stringify(manifest).includes('"catalog:"')) {
    throw new Error("Robelest tarball contains unresolved pnpm catalog dependency ranges.");
  }
}

/**
 * Qualify the exact npm payload after assembly.
 *
 * This deliberately installs the tarball in a fresh consumer outside the workspace. It exercises
 * the package manager's real dependency graph and the public export, so neither relative imports
 * nor dependencies can be satisfied accidentally by the source checkout. Registry access is the
 * only external prerequisite; this operation has no deploy or publishing credentials.
 */
export function qualifyTarball(path: string, mode: PublishMode): void {
  const archive = resolve(path);
  verifyTarball(archive, mode);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  ) as PackageJson;
  const convex = manifest.peerDependencies?.convex;
  const temporary = mkdtempSync(join(tmpdir(), "convex-embedded-tarball-qualification-"));
  try {
    writeFileSync(
      resolve(temporary, "package.json"),
      `${JSON.stringify(
        {
          name: "convex-embedded-tarball-qualification",
          private: true,
          type: "module",
          dependencies: {
            [publishedPackageName]: `file:${archive}`,
            ...(convex === undefined ? {} : { convex }),
          },
        },
        null,
        2,
      )}\n`,
    );
    execFileSync(
      "pnpm",
      ["install", "--ignore-scripts", "--config.audit=false", "--config.fund=false"],
      {
        cwd: temporary,
        stdio: "inherit",
      },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(`${publishedPackageName}/node`)});`,
      ],
      {
        cwd: temporary,
        stdio: "inherit",
      },
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/** The emitted artifact record proves the packed runtime was built at the manifest's version. */
function readArtifact(directory: string): unknown {
  return JSON.parse(readFileSync(resolve(directory, "dist/artifact.json"), "utf8")) as unknown;
}

function verifyArtifactVersion(artifact: unknown, version: string | undefined): void {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    (artifact as Record<string, unknown>).format !== 1 ||
    (artifact as Record<string, unknown>).packageVersion !== version
  ) {
    throw new Error(
      `Robelest artifact version does not match package manifest version ${String(version)}.`,
    );
  }
}

export function exportedPackageFiles(manifest: PackageJson): string[] {
  const files = new Set<string>();
  visit(manifest.exports);
  return [...files].sort();

  function visit(value: unknown): void {
    if (typeof value === "string") {
      if (value.startsWith("./")) files.add(value.slice(2));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  }
}

export function verifyManifest(manifest: PackageJson, mode: PublishMode): void {
  if (manifest.name !== publishedPackageName) {
    throw new Error(
      `Refusing to publish ${String(manifest.name)}; only ${publishedPackageName} is allowed.`,
    );
  }
  if (
    manifest.repository === undefined ||
    !JSON.stringify(manifest.repository).includes(publishedRepository)
  ) {
    throw new Error(`Robelest package repository must be ${publishedRepository}.`);
  }
  for (const script of lifecycleScripts) {
    if (manifest.scripts?.[script]) {
      throw new Error(`Robelest package must not publish the ${script} lifecycle script.`);
    }
  }
  if (mode === "release") {
    const version = manifest.version ?? "";
    if (!/^\d+\.\d+\.\d+$/.test(version) || version === "0.0.0") {
      throw new Error(
        `Robelest releases require a nonzero stable x.y.z version; received ${version}.`,
      );
    }
  } else if (mode === "prerelease") {
    const version = manifest.version ?? "";
    if (!/^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
      throw new Error(
        `Robelest prereleases require an x.y.z-prerelease version; received ${version}.`,
      );
    }
  }
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function argument(index: number, description: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`Missing ${description}.`);
  return value;
}

function mode(index: number): PublishMode {
  const value = argument(index, "publish mode");
  if (value !== "preview" && value !== "prerelease" && value !== "release") {
    throw new Error(`Publish mode must be preview, prerelease, or release; received ${value}.`);
  }
  return value;
}

function main(): void {
  const command = argument(2, "publish command");
  const directory = process.env.CONVEX_EMBEDDED_PACKAGE_DIR
    ? resolve(process.env.CONVEX_EMBEDDED_PACKAGE_DIR)
    : packageDir;
  if (command === "prepare") {
    verifyPreview2Fixture();
    const version = process.env.CONVEX_EMBEDDED_PUBLISH_VERSION?.trim() || undefined;
    preparePackage(directory, version);
  } else if (command === "prepare-build") {
    const version = process.env.CONVEX_EMBEDDED_PUBLISH_VERSION?.trim() || undefined;
    prepareBuildVersion(directory, version);
  } else if (command === "fixture") {
    verifyPreview2Fixture();
  } else if (command === "verify") verifyPackageTree(directory, mode(3));
  else if (command === "pack") packPackage(directory, resolve(argument(3, "destination")), mode(4));
  else if (command === "verify-tarball") verifyTarball(resolve(argument(3, "tarball")), mode(4));
  else if (command === "qualify-tarball") qualifyTarball(resolve(argument(3, "tarball")), mode(4));
  else throw new Error(`Unknown publish command: ${command}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) main();
