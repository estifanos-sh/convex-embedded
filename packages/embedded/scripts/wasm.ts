import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTargetDir, skipWasmOpt } from "../../../config/build.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const artifact = resolve(packageDir, "dist/wasm/index.wasm");
const debugArtifact = resolve(packageDir, "dist/wasm/index.debug.wasm");
const generatedTypes = resolve(packageDir, "dist/wasm/index.d.ts");
const manifest = resolve(repoRoot, "crates/node/Cargo.toml");
const targetDir = cargoTargetDir();
const binName = (name: string) => (process.platform === "win32" ? `${name}.cmd` : name);
const outputDir = resolve(packageDir, "dist/wasm");
const rustc = execFileSync("rustup", ["which", "rustc"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

function resolveTool(name: string): string | undefined {
  const local = resolve(packageDir, "node_modules/.bin", binName(name));
  if (existsSync(local)) return local;

  const workspace = resolve(repoRoot, "node_modules/.bin", binName(name));
  if (existsSync(workspace)) return workspace;

  const probe = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(probe, [name], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

const napi = resolveTool("napi");
if (!napi) {
  throw new Error(`Missing @napi-rs/cli binary. Run \`vp install\` before building WASM.`);
}

execFileSync(
  napi,
  [
    "build",
    "--profile",
    "release-wasm",
    "--target",
    "wasm32-wasip1-threads",
    "--no-js",
    "--manifest-path",
    manifest,
    "--output-dir",
    outputDir,
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTC: rustc },
    stdio: "inherit",
  },
);

if (!existsSync(artifact)) {
  throw new Error(`WASM artifact build did not produce ${artifact}`);
}

const wasmOpt = resolveTool("wasm-opt");
if (wasmOpt) {
  execFileSync(
    wasmOpt,
    [
      "-Oz",
      "--strip-debug",
      "--strip-dwarf",
      "--strip-producers",
      "--enable-threads",
      "--enable-bulk-memory",
      "--enable-bulk-memory-opt",
      "--enable-nontrapping-float-to-int",
      artifact,
      "-o",
      artifact,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  console.log(`Optimized WASM artifact with wasm-opt -Oz: ${artifact}`);
} else if (skipWasmOpt()) {
  console.log("Skipping wasm-opt -Oz step: CONVEX_EMBEDDED_SKIP_WASM_OPT=1.");
} else {
  throw new Error(
    "Missing wasm-opt. Run `vp install` to install binaryen, or set " +
      "CONVEX_EMBEDDED_SKIP_WASM_OPT=1 for an explicitly unoptimized build.",
  );
}

rmSync(debugArtifact, { force: true });
rmSync(generatedTypes, { force: true });

console.log(`Built WASM artifact: ${artifact}`);
