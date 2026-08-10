import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { androidAbis, androidSdk, javaHome, mobileSlices } from "../../../config/build.ts";

const platform = process.argv[2];
if (platform !== "ios" && platform !== "android") {
  throw new Error("Native compile smoke requires an ios or android platform argument.");
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(resolve(tmpdir(), "convex-embedded-expo-"));
const name = "EmbeddedNativeCompile";

try {
  writeJson(resolve(work, "package.json"), {
    name: "embedded-native-compile",
    private: true,
    version: "0.0.0",
    packageManager: "pnpm@11.5.2",
    dependencies: {
      "@estifanos-sh/convex-embedded": `link:${packageDir}`,
      expo: "~54.0.34",
      "expo-crypto": "~15.0.9",
      react: "19.1.0",
      "react-native": "0.81.5",
    },
  });
  writeJson(resolve(work, "app.json"), {
    expo: {
      name,
      slug: "embedded-native-compile",
      version: "0.0.0",
      ios: { bundleIdentifier: "dev.convex.embeddedcompile" },
      android: { package: "dev.convex.embeddedcompile" },
    },
  });
  writeFileSync(
    resolve(work, "App.js"),
    "import React from 'react';\nexport default function App() { return null; }\n",
  );

  run("pnpm", ["install", "--ignore-workspace"], work);
  run("pnpm", ["exec", "expo", "prebuild", "--platform", platform, "--no-install"], work);
  if (platform === "ios") {
    const ios = resolve(work, "ios");
    run("pod", ["install"], ios, { ...process.env, RCT_NEW_ARCH_ENABLED: "1" });
    const provider = resolve(
      ios,
      "Pods/Target Support Files",
      `Pods-${name}`,
      "ExpoModulesProvider.swift",
    );
    const providerSource = readFileSync(provider, "utf8");
    for (const expected of ["import ConvexEmbeddedNative", "ConvexEmbeddedNativeModule.self"]) {
      if (!providerSource.includes(expected)) {
        throw new Error(`Expo autolinking provider is missing ${expected}.`);
      }
    }
    const derived = resolve(work, "derived");
    run(
      "xcodebuild",
      [
        "-workspace",
        `${name}.xcworkspace`,
        "-scheme",
        name,
        "-configuration",
        "Debug",
        "-sdk",
        "iphoneos",
        "-destination",
        "generic/platform=iOS",
        "-derivedDataPath",
        derived,
        "CODE_SIGNING_ALLOWED=NO",
        "ONLY_ACTIVE_ARCH=NO",
        "build",
      ],
      ios,
    );
    const app = resolve(derived, `Build/Products/Debug-iphoneos/${name}.app`);
    const binaries = [resolve(app, name), resolve(app, `${name}.debug.dylib`)].filter(existsSync);
    const symbols = binaries.flatMap((binary) =>
      read("xcrun", ["nm", "-gUj", binary], ios)
        .split("\n")
        .map((symbol) => symbol.trim().replace(/^_/, "")),
    );
    if (!symbols.includes("cem_bridge_contract_id") || !symbols.includes("cem_wire_contract_id")) {
      throw new Error("Compiled Expo app is missing the Convex Embedded native storage symbols.");
    }
  } else {
    const android = resolve(work, "android");
    const jdk = javaHome();
    const sdk = androidSdk();
    const environment = {
      ...process.env,
      ...(jdk ? { JAVA_HOME: jdk } : {}),
      ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}),
    };
    run(
      resolve(android, "gradlew"),
      [
        ":app:assembleDebug",
        `-PreactNativeArchitectures=${mobileSlices(androidAbis).join(",")}`,
        "--no-daemon",
      ],
      android,
      environment,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: string[], cwd: string, env = process.env): void {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

function read(command: string, args: string[], cwd: string, env = process.env): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
}
