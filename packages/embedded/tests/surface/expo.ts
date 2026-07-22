import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Expo package surface", () => {
  test("publishes the JavaScript and native autolinking metadata together", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      files: string[];
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    const moduleConfig = JSON.parse(
      readFileSync(join(root, "expo-module.config.json"), "utf8"),
    ) as {
      android: { modules: string[] };
      apple: { modules: string[]; podspecPath: string };
    };

    expect(packageJson.exports["./expo"]).toEqual({
      import: "./dist/expo/index.mjs",
      types: "./dist/expo/index.d.mts",
    });
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "android",
        "ios",
        "native",
        "expo-module.config.json",
        "ConvexEmbeddedNative.podspec",
      ]),
    );
    expect(packageJson.peerDependenciesMeta.expo?.optional).toBe(true);
    expect(packageJson.peerDependenciesMeta["react-native"]?.optional).toBe(true);
    expect(moduleConfig).toEqual({
      platforms: ["apple", "android"],
      apple: {
        modules: ["ConvexEmbeddedNativeModule"],
        podspecPath: "ConvexEmbeddedNative.podspec",
      },
      android: { modules: ["expo.modules.convexembedded.ConvexEmbeddedNativeModule"] },
    });
  });

  test("packages prebuilts rather than compiling Rust in consumer projects", () => {
    const podspec = readFileSync(join(root, "ConvexEmbeddedNative.podspec"), "utf8");
    const gradle = readFileSync(join(root, "android/build.gradle"), "utf8");
    const mobile = readFileSync(join(root, "scripts/mobile.ts"), "utf8");

    expect(podspec).toContain('s.vendored_frameworks = "native/apple/ConvexEmbedded.xcframework"');
    expect(podspec).toContain('s.platforms = { :ios => "15.1" }');
    expect(mobile).toContain('const iosDeploymentTarget = "15.1"');
    expect(mobile).toContain("IPHONEOS_DEPLOYMENT_TARGET: iosDeploymentTarget");
    expect(gradle).toContain('jniLibs.srcDirs = ["../native/android"]');
    expect(gradle).not.toMatch(/cargo|externalNativeBuild|cmake/i);
  });

  test("maps every required StoreBinding operation", () => {
    const source = readFileSync(join(root, "src/expo/store.ts"), "utf8");
    const operations = [
      ...source.matchAll(/this\.invoke(?:Remote)?(?:<[^>]+>)?\("([A-Za-z]+)"/g),
    ].map(([, operation]) => operation);
    const rust = readFileSync(join(root, "../../crates/mobile/src/lib.rs"), "utf8");
    const dispatch = rust.slice(rust.indexOf("fn dispatch("), rust.indexOf("fn mutation_record("));
    const rustOperations = dispatch
      .split("\n")
      .filter((line) => line.startsWith('        "') || line.startsWith("        operation @"))
      .flatMap((line) => [...line.matchAll(/"([A-Za-z]+)"/g)].map(([, operation]) => operation));

    const expected = new Set([
      "setup",
      "identityRead",
      "identityWrite",
      "mutationWrite",
      "mutationCacheRead",
      "mutationCacheWrite",
      "mutationFail",
      "commit",
      "docRead",
      "localFieldsRead",
      "docVersionRead",
      "crdtHeadRead",
      "crdtSnapshotRead",
      "docPageRead",
      "keyPageRead",
      "docCountRead",
      "ledgerDelete",
      "walWrite",
      "blobRead",
      "blobWrite",
      "blobDelete",
      "resultRead",
      "resultWrite",
      "resultDelete",
      "docBaseRead",
      "idWrite",
      "idRead",
      "idPageRead",
      "dirtyHeadsDebugRead",
      "remoteDocDebugRead",
      "idDelete",
      "fileWrite",
      "fileMetaWrite",
      "fileRead",
      "fileDelete",
      "uploadWrite",
      "uploadRead",
      "uploadLeaseWrite",
      "uploadComplete",
      "uploadDelete",
      "scheduleWrite",
      "scheduleRead",
      "scheduleLeaseWrite",
      "scheduleComplete",
      "scheduleFail",
      "scheduleCancel",
      "remoteStart",
      "remoteNext",
      "remoteAuthWrite",
      "remotePull",
      "remoteIdentity",
      "remoteDocPush",
      "remoteScopeWrite",
      "remoteClose",
      "clear",
    ]);
    expect(new Set(operations)).toEqual(expected);
    expect(new Set(rustOperations)).toEqual(expected);
    expect(source).not.toContain("commitOneDocWrite");
  });

  test("runs blocking iOS store calls on a concurrent queue", () => {
    const swift = readFileSync(join(root, "ios/ConvexEmbeddedNativeModule.swift"), "utf8");
    expect(swift).toContain("attributes: .concurrent");
    expect(swift).toMatch(/AsyncFunction\("call"\)[\s\S]*?\.runOnQueue\(Self\.storeQueue\)/);
    expect(swift).toMatch(/AsyncFunction\("close"\)[\s\S]*?\.runOnQueue\(Self\.storeQueue\)/);
  });

  test("runs blocking Android store calls on the lifecycle-owned background scope", () => {
    const kotlin = readFileSync(
      join(root, "android/src/main/java/expo/modules/convexembedded/ConvexEmbeddedNativeModule.kt"),
      "utf8",
    );
    expect(kotlin).toMatch(
      /AsyncFunction\("call"\)[\s\S]*?\.runOnQueue\(appContext\.backgroundCoroutineScope\)/,
    );
    expect(kotlin).toMatch(
      /AsyncFunction\("close"\)[\s\S]*?\.runOnQueue\(appContext\.backgroundCoroutineScope\)/,
    );
  });

  test("declares every expected prebuilt artifact path", () => {
    const validation = join(root, "scripts/mobile.ts");

    expect(existsSync(validation)).toBe(true);
    const source = readFileSync(validation, "utf8");
    expect(source).toContain("ConvexEmbedded.xcframework");
    expect(source).toContain("libconvex_embedded_mobile.so");
    for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]) {
      expect(source).toContain(abi);
    }
    expect(source).toContain('const command = process.argv[2] ?? "verify"');
  });
});
