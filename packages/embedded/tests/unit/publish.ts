import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  preparePackage,
  packPackage,
  preview2Tag,
  preview2Version,
  publishedPackageName,
  publishedRepository,
  requiredPackageFiles,
  sourcePackageName,
  verifyManifest,
  verifyFixtureFiles,
  verifyPreview2PendingVersion,
  verifyPackedFiles,
} from "../../scripts/publish.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Robelest package publication", () => {
  test("binds Preview2 to its named prerelease and rejects fixture-directory debris", () => {
    expect(preview2Tag).toBe("robelest-v0.0.1-preview-2");
    expect(preview2Version).toBe("0.0.1-preview-2");

    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-preview2-"));
    temporary.push(directory);
    writeFileSync(join(directory, "manifest.json"), "{}");
    writeFileSync(join(directory, "store.sqlite3"), "fixture");
    expect(() => verifyFixtureFiles(directory)).not.toThrow();

    writeFileSync(join(directory, "store.sqlite3-wal"), "");
    expect(() => verifyFixtureFiles(directory)).toThrow("must contain only");

    expect(() => verifyPreview2PendingVersion(preview2Version)).not.toThrow();
    expect(() => verifyPreview2PendingVersion("0.0.1")).toThrow("must first publish");
  });

  test("rewrites only the ephemeral package identity and strips lifecycle builds", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-publish-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: sourcePackageName,
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
    expect(manifest.name).toBe(publishedPackageName);
    expect(manifest.repository.url).toContain(publishedRepository);
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.scripts).toEqual({ build: "vp pack" });
  });

  test("cannot verify the official package identity for publication", () => {
    expect(() =>
      verifyManifest(
        {
          name: sourcePackageName,
          repository: { type: "git", url: `git+${publishedRepository}.git` },
          version: "0.0.1",
        },
        "release",
      ),
    ).toThrow(`only ${publishedPackageName} is allowed`);
  });

  test("requires every native target in the packed payload", () => {
    const complete = new Set(requiredPackageFiles().map((path) => `package/${path}`));
    expect(() => verifyPackedFiles(complete)).not.toThrow();
    complete.delete("package/native/android/x86_64/libconvex_embedded_mobile.so");
    expect(() => verifyPackedFiles(complete)).toThrow("x86_64");
  });

  test("packs and re-verifies the exact prepared payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-package-"));
    const destination = mkdtempSync(join(tmpdir(), "convex-embedded-tarball-"));
    const consumer = mkdtempSync(join(tmpdir(), "convex-embedded-consumer-"));
    temporary.push(directory, destination, consumer);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        files: [
          "ConvexEmbeddedNative.podspec",
          "android",
          "dist",
          "expo-module.config.json",
          "ios",
          "native",
        ],
        name: sourcePackageName,
        scripts: { prepack: "false" },
        version: "0.0.0",
      }),
    );
    for (const path of requiredPackageFiles()) {
      const absolute = join(directory, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "fixture");
    }

    preparePackage(directory);
    const tarball = packPackage(directory, destination, "preview");

    expect(readFileSync(tarball).byteLength).toBeGreaterThan(0);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", private: true }),
    );
    execFileSync("pnpm", ["add", `${sourcePackageName}@file:${tarball}`], {
      cwd: consumer,
      stdio: "pipe",
    });
    const aliased = join(consumer, "node_modules/@convex-dev/embedded/package.json");
    expect(existsSync(aliased)).toBe(true);
    expect(JSON.parse(readFileSync(aliased, "utf8")).name).toBe(publishedPackageName);
  });

  test("rejects placeholder and prerelease versions", () => {
    const manifest = {
      name: publishedPackageName,
      repository: { type: "git", url: `git+${publishedRepository}.git` },
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

  test("assigns a prerelease version only in the ephemeral package tree", () => {
    const directory = mkdtempSync(join(tmpdir(), "convex-embedded-prerelease-"));
    temporary.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: sourcePackageName, version: "0.0.0" }),
    );

    preparePackage(directory, "0.0.1-preview-0");

    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest).toMatchObject({ name: publishedPackageName, version: "0.0.1-preview-0" });
  });
});
