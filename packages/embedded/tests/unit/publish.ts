import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  preparePackage,
  prepareBuildVersion,
  qualifyTarball,
  packPackage,
  packageName,
  packageRepository,
  preview2Tag,
  preview2Version,
  requiredPackageFiles,
  verifyManifest,
  verifyPackageTree,
  verifyFixtureFiles,
  verifyPackedFiles,
  verifyReadme,
} from "../../scripts/publish.js";

const temporary: string[] = [];
const readmeFixture = `# Convex Embedded

\`@estifanos-sh/convex-embedded\`

\`\`\`sh
pnpm add @estifanos-sh/convex-embedded convex
\`\`\`

## Quick start

## Functions

## Client lifecycle and API

await client.open()

## User data migrations

## Platform setup

## Errors and troubleshooting

## Release and compatibility policy
`;

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Embedded package publication", () => {
  test("keeps the historical Preview2 name and rejects fixture-directory debris", () => {
    expect(preview2Tag).toBe("robelest-v0.0.1-preview-2");
    expect(preview2Version).toBe("0.0.1-preview-2");

    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-preview2-"));
    temporary.push(directory);
    writeFileSync(join(directory, "manifest.json"), "{}");
    writeFileSync(join(directory, "store.sqlite3"), "fixture");
    expect(() => verifyFixtureFiles(directory)).not.toThrow();

    writeFileSync(join(directory, "store.sqlite3-wal"), "");
    expect(() => verifyFixtureFiles(directory)).toThrow("must contain only");
  });

  test("preserves the package identity and strips lifecycle builds", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-publish-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: packageName,
        publishConfig: { access: "restricted" },
        scripts: { build: "vp pack", postinstall: "false", prepack: "false" },
        version: "0.0.1",
      }),
    );

    preparePackage(directory);

    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name: string;
      publishConfig: { access: string };
      repository: { url: string };
      scripts: Record<string, string>;
    };
    expect(manifest.name).toBe(packageName);
    expect(manifest.repository.url).toContain(packageRepository);
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.scripts).toEqual({ build: "vp pack" });
  });

  test("stamps the release version before build without changing package identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-build-version-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: packageName, version: "0.0.1" }),
    );

    prepareBuildVersion(directory, "0.0.1-preview-3");

    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).toMatchObject({
      name: packageName,
      version: "0.0.1-preview-3",
    });
    expect(() => prepareBuildVersion(directory, "not-a-version")).toThrow("must be semver");
  });

  test("rejects a package identity other than the independent release package", () => {
    expect(() =>
      verifyManifest(
        {
          name: "@convex-dev/embedded",
          repository: { type: "git", url: `git+${packageRepository}.git` },
          version: "0.0.1",
        },
        "release",
      ),
    ).toThrow(`only ${packageName} is allowed`);
  });

  test("requires comprehensive npm documentation with the current package identity", () => {
    expect(() => verifyReadme(readmeFixture)).not.toThrow();
    expect(() => verifyReadme("")).toThrow("README must not be empty");
    expect(() =>
      verifyReadme(
        "# Convex Embedded\n\n`@estifanos-sh/convex-embedded`\n\npnpm add @estifanos-sh/convex-embedded convex",
      ),
    ).toThrow("Quick start");
    expect(() => verifyReadme(`${readmeFixture}\n@robelest/convex-embedded`)).toThrow(
      "retired package",
    );
  });

  test("requires every runtime artifact in the packed payload", () => {
    const complete = new Set(requiredPackageFiles().map((path) => `package/${path}`));
    expect(() => verifyPackedFiles(complete)).not.toThrow();
    complete.delete("package/native/android/x86_64/libconvex_embedded_mobile.so");
    expect(() => verifyPackedFiles(complete)).toThrow("x86_64");

    for (const path of [
      "package/LICENSE",
      "package/README.md",
      "package/dist/artifact.json",
      "package/dist/browser-embedded.mjs",
      "package/dist/thread/browser-worker.mjs",
    ]) {
      const withMissingArtifact = new Set(
        requiredPackageFiles().map((entry) => `package/${entry}`),
      );
      withMissingArtifact.delete(path);
      expect(() => verifyPackedFiles(withMissingArtifact)).toThrow(path.replace("package/", ""));
    }
  });

  test("packs and re-verifies the exact prepared payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-package-"));
    const destination = mkdtempSync(join(tmpdir(), "convex-embedded-tarball-"));
    const consumer = mkdtempSync(join(tmpdir(), "convex-embedded-consumer-"));
    temporary.push(directory, destination, consumer);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        exports: { "./node": "./dist/node.mjs" },
        files: [
          "ConvexEmbeddedNative.podspec",
          "android",
          "dist",
          "expo-module.config.json",
          "ios",
          "native",
        ],
        name: packageName,
        scripts: { prepack: "false" },
        version: "0.0.0",
      }),
    );
    for (const path of requiredPackageFiles()) {
      const absolute = join(directory, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(
        absolute,
        path === "dist/artifact.json"
          ? JSON.stringify({ format: 1, packageVersion: "0.0.0" })
          : path === "README.md"
            ? readmeFixture
            : path === "dist/node.mjs"
              ? "export {};\n"
              : "fixture",
      );
    }

    preparePackage(directory);
    const tarball = packPackage(directory, destination, "preview");
    expect(() => qualifyTarball(tarball, "preview")).not.toThrow();

    expect(readFileSync(tarball).byteLength).toBeGreaterThan(0);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", private: true }),
    );
    execFileSync("pnpm", ["add", `${packageName}@file:${tarball}`], {
      cwd: consumer,
      stdio: "pipe",
    });
    const aliased = join(consumer, "node_modules/@estifanos-sh/convex-embedded/package.json");
    expect(existsSync(aliased)).toBe(true);
    expect(JSON.parse(readFileSync(aliased, "utf8")).name).toBe(packageName);
  });

  test("requires release metadata, documentation, and runtime artifacts to agree", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-artifact-version-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "0.0.1-preview-3",
      }),
    );
    for (const path of requiredPackageFiles()) {
      const absolute = join(directory, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(
        absolute,
        path === "dist/artifact.json"
          ? JSON.stringify({ format: 1, packageVersion: "wrong" })
          : path === "README.md"
            ? readmeFixture
            : "fixture",
      );
    }
    preparePackage(directory, "0.0.1-preview-3");

    expect(() => verifyPackageTree(directory, "prerelease")).toThrow(
      "artifact version does not match",
    );
  });

  test("rejects placeholder and prerelease versions", () => {
    const manifest = {
      name: packageName,
      repository: { type: "git", url: `git+${packageRepository}.git` },
    };
    expect(() => verifyManifest({ ...manifest, version: "0.0.0" }, "release")).toThrow(
      "nonzero stable",
    );
    expect(() => verifyManifest({ ...manifest, version: "0.1.0-beta.1" }, "release")).toThrow(
      "nonzero stable",
    );
    expect(() =>
      verifyManifest({ ...manifest, version: "0.0.1-preview-0" }, "prerelease"),
    ).not.toThrow();
    expect(() => verifyManifest({ ...manifest, version: "0.0.1" }, "prerelease")).toThrow(
      "x.y.z-prerelease",
    );
    expect(() => verifyManifest({ ...manifest, version: "0.0.0" }, "preview")).not.toThrow();
  });

  test("assigns a prerelease version in the assembled package tree", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-prerelease-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: packageName, version: "0.0.0" }),
    );

    preparePackage(directory, "0.0.1-preview-0");

    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest).toMatchObject({ name: packageName, version: "0.0.1-preview-0" });
  });
});
