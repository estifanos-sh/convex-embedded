import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
      "@convex-dev/embedded": `link:${packageDir}`,
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
        "CODE_SIGNING_ALLOWED=NO",
        "ONLY_ACTIVE_ARCH=NO",
        "build",
      ],
      ios,
    );
  } else {
    run(resolve(work, "android", "gradlew"), [":app:assembleDebug", "--no-daemon"], work);
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
