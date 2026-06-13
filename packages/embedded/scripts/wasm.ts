import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const artifact = resolve(packageDir, "dist/wasm/index.wasm");
const debugArtifact = resolve(packageDir, "dist/wasm/index.debug.wasm");
const generatedTypes = resolve(packageDir, "dist/wasm/index.d.ts");
const manifest = resolve(repoRoot, "crates/node/Cargo.toml");
const napi = resolve(
  packageDir,
  "node_modules/.bin",
  process.platform === "win32" ? "napi.cmd" : "napi",
);
const outputDir = resolve(packageDir, "dist/wasm");
const rustc = execFileSync("rustup", ["which", "rustc"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

if (!existsSync(napi)) {
  throw new Error(`Missing @napi-rs/cli binary. Run \`vp install\` before building WASM.`);
}

execFileSync(
  napi,
  [
    "build",
    "--release",
    "--target",
    "wasm32-wasip1-threads",
    "--no-js",
    "--manifest-path",
    manifest,
    "--output-dir",
    outputDir,
  ],
  { cwd: repoRoot, env: { ...process.env, RUSTC: rustc }, stdio: "inherit" },
);

if (!existsSync(artifact)) {
  throw new Error(`WASM artifact build did not produce ${artifact}`);
}

rmSync(debugArtifact, { force: true });
rmSync(generatedTypes, { force: true });

console.log(`Built WASM artifact: ${artifact}`);
