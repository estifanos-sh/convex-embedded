import { execFileSync } from "node:child_process";
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

export const packageName = "@estifanos-sh/convex-embedded";
export const packageRepository = "https://github.com/estifanos-sh/convex-embedded";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = resolve(packageDir, "../..");
const lifecycleScripts = ["install", "postinstall", "prepack", "prepare", "prepublishOnly"];
const nodeTargets = ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu", "win32-x64"] as const;
const androidAbis = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"] as const;
const appleSlices = ["ios-arm64", "ios-arm64-simulator"] as const;
const readmeContract = [
  "# Embedded",
  `\`${packageName}\``,
  "## 1. Configure Convex",
  "## Schema changes and migrations",
  "## 2. Configure the browser build",
  "## 3. Create a client",
  "## Troubleshooting browser builds",
] as const;

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

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";
export type PublishMode = "verify" | "preview" | "prerelease" | "release";

const dependencySections: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Stamp the version consumed by tsdown before it emits package artifacts.
 *
 * Separate CI jobs start from fresh checkouts, so this must run in every job that produces
 * distributable JavaScript.
 */
export function prepareBuildVersion(directory: string, version?: string): PackageJson {
  const path = resolve(directory, "package.json");
  const manifest = readPackageJson(path);
  if (manifest.name !== packageName) {
    throw new Error(`Refusing to build ${String(manifest.name)}; expected package ${packageName}.`);
  }
  if (version === undefined) return manifest;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    throw new Error(`Embedded package build version must be semver; received ${version}.`);
  }
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Prepare the assembled package copy without changing its public identity. */
export function preparePackage(directory: string, version?: string): PackageJson {
  const path = resolve(directory, "package.json");
  const manifest = readPackageJson(path);
  if (manifest.name !== packageName) {
    throw new Error(
      `Refusing to prepare ${String(manifest.name)}; expected package ${packageName}.`,
    );
  }

  if (version !== undefined) manifest.version = version;
  manifest.author = "estifanos-sh";
  manifest.license ??= "MIT";
  manifest.repository = { type: "git", url: `git+${packageRepository}.git` };
  manifest.homepage = `${packageRepository}#readme`;
  manifest.bugs = { url: `${packageRepository}/issues` };
  manifest.publishConfig = { ...manifest.publishConfig, access: "public" };
  resolveCatalogRanges(manifest);
  if (manifest.scripts) {
    for (const script of lifecycleScripts) delete manifest.scripts[script];
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Resolve workspace-only pnpm catalog ranges before npm creates the release payload. */
function resolveCatalogRanges(manifest: PackageJson): void {
  const catalog = readDefaultCatalog();
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (!isStringRecord(dependencies)) {
      throw new Error(`Embedded package ${section} must be a dependency map.`);
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (range === "catalog:") {
        const resolved = catalog.get(name);
        if (resolved === undefined) {
          throw new Error(`Embedded package ${section}.${name} has no default catalog range.`);
        }
        dependencies[name] = resolved;
      } else if (range.startsWith("catalog:")) {
        throw new Error(
          `Embedded package ${section}.${name} uses an unsupported named pnpm catalog range.`,
        );
      }
    }
  }
}

/** Read the small, flat default pnpm catalog without adding a YAML parser to the release path. */
function readDefaultCatalog(): Map<string, string> {
  const workspace = readFileSync(resolve(repositoryDir, "pnpm-workspace.yaml"), "utf8");
  const catalog = new Map<string, string>();
  let active = false;
  for (const line of workspace.split("\n")) {
    if (line === "catalog:") {
      active = true;
      continue;
    }
    if (!active) continue;
    if (/^\S/.test(line)) break;
    const entry = line.match(/^  (?:("[^"]+")|([^:#][^:]*)):\s*(\S.*?)\s*$/);
    if (entry === null) continue;
    const name = entry[1] === undefined ? entry[2]!.trim() : entry[1].slice(1, -1);
    const range = entry[3]!.replace(/\s+#.*$/, "").trim();
    if (range.length > 0) catalog.set(name, range);
  }
  return catalog;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
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
      throw new Error(`Embedded package is missing required artifact: ${path}`);
    }
  }
  verifyReadme(readFileSync(resolve(directory, "README.md"), "utf8"));
  verifyArtifactVersion(readArtifact(directory), manifest.version);
}

export function verifyPackedFiles(files: ReadonlySet<string>, manifest?: PackageJson): void {
  const expected = [...requiredPackageFiles(), ...(manifest ? exportedPackageFiles(manifest) : [])];
  for (const path of new Set(expected)) {
    if (!files.has(`package/${path}`)) {
      throw new Error(`Embedded tarball is missing required artifact: ${path}`);
    }
  }
}

export function packPackage(directory: string, destination: string, mode: PublishMode): string {
  verifyPackageTree(directory, mode);
  mkdirSync(destination, { recursive: true });
  const before = new Set(readdirSync(destination));
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], {
    cwd: directory,
    env: process.env,
    stdio: "inherit",
  });
  const created = readdirSync(destination).filter(
    (name) => name.endsWith(".tgz") && !before.has(name),
  );
  if (created.length !== 1) {
    throw new Error(`Expected npm pack to create one tarball, found ${created.length}.`);
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
  verifyReadme(execFileSync("tar", ["-xOzf", path, "package/README.md"], { encoding: "utf8" }));
  const artifact = JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/dist/artifact.json"], { encoding: "utf8" }),
  ) as unknown;
  verifyArtifactVersion(artifact, manifest.version);
  if (JSON.stringify(manifest).includes('"catalog:"')) {
    throw new Error("Embedded tarball contains unresolved pnpm catalog dependency ranges.");
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
            [packageName]: `file:${archive}`,
            ...(convex === undefined ? {} : { convex }),
          },
        },
        null,
        2,
      )}\n`,
    );
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: temporary,
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(`${packageName}/node`)});`],
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
      `Embedded artifact version does not match package manifest version ${String(version)}.`,
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
  if (manifest.name !== packageName) {
    throw new Error(
      `Refusing to publish ${String(manifest.name)}; only ${packageName} is allowed.`,
    );
  }
  if (
    manifest.repository === undefined ||
    !JSON.stringify(manifest.repository).includes(packageRepository)
  ) {
    throw new Error(`Embedded package repository must be ${packageRepository}.`);
  }
  for (const script of lifecycleScripts) {
    if (manifest.scripts?.[script]) {
      throw new Error(`Embedded package must not publish the ${script} lifecycle script.`);
    }
  }
  if (mode === "release") {
    const version = manifest.version ?? "";
    if (!/^\d+\.\d+\.\d+$/.test(version) || version === "0.0.0") {
      throw new Error(
        `Embedded releases require a nonzero stable x.y.z version; received ${version}.`,
      );
    }
  } else if (mode === "prerelease") {
    const version = manifest.version ?? "";
    if (!/^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
      throw new Error(
        `Embedded prereleases require an x.y.z-prerelease version; received ${version}.`,
      );
    }
  }
}

/** Keep npm's package page self-contained while the documentation site does not exist yet. */
export function verifyReadme(readme: string): void {
  for (const required of readmeContract) {
    if (!readme.includes(required)) {
      throw new Error(`Embedded package README is missing required section: ${required}`);
    }
  }
}

function readPublishedReadme(packageSpecifier: string): unknown {
  return JSON.parse(
    execFileSync("npm", ["view", packageSpecifier, "readme", "--json"], { encoding: "utf8" }),
  ) as unknown;
}

/** Verify npm rendered the exact README carried by the verified package directory. */
export function verifyPublishedReadme(
  directory: string,
  packageSpecifier: string,
  read = readPublishedReadme,
): void {
  const expected = readFileSync(resolve(directory, "README.md"), "utf8");
  const published = read(packageSpecifier);
  if (typeof published !== "string") {
    throw new Error(`npm did not return a README for ${packageSpecifier}.`);
  }
  verifyReadme(published);
  if (published !== expected) {
    throw new Error(`npm README for ${packageSpecifier} does not match the assembled package.`);
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
  if (value !== "verify" && value !== "preview" && value !== "prerelease" && value !== "release") {
    throw new Error(
      `Publish mode must be verify, preview, prerelease, or release; received ${value}.`,
    );
  }
  return value;
}

function main(): void {
  const command = argument(2, "publish command");
  const directory = process.env.CONVEX_EMBEDDED_PACKAGE_DIR
    ? resolve(process.env.CONVEX_EMBEDDED_PACKAGE_DIR)
    : packageDir;
  if (command === "prepare") {
    const version = process.env.CONVEX_EMBEDDED_PUBLISH_VERSION?.trim() || undefined;
    preparePackage(directory, version);
  } else if (command === "prepare-build") {
    const version = process.env.CONVEX_EMBEDDED_PUBLISH_VERSION?.trim() || undefined;
    prepareBuildVersion(directory, version);
  } else if (command === "verify") verifyPackageTree(directory, mode(3));
  else if (command === "pack") packPackage(directory, resolve(argument(3, "destination")), mode(4));
  else if (command === "verify-tarball") verifyTarball(resolve(argument(3, "tarball")), mode(4));
  else if (command === "verify-published-readme")
    verifyPublishedReadme(directory, argument(3, "published package"));
  else if (command === "qualify-tarball") qualifyTarball(resolve(argument(3, "tarball")), mode(4));
  else throw new Error(`Unknown publish command: ${command}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) main();
