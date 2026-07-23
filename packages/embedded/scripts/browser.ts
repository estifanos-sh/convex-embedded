import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDeployment } from "./deployment.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testConfig = ["--config", "vite/tests.ts"];

await verifyDeployment();
run("vp", ["pack"]);
run("node", ["scripts/wasm.ts"]);
run("vp", ["test", "run", ...testConfig, "--project", "browser", "tests/browser/runtime.ts"]);
run("vp", ["test", "run", ...testConfig, "--project", "browser", "tests/browser/memory.ts"]);
run("vp", ["test", "run", ...testConfig, "--project", "browser", "tests/browser/protocol.ts"]);
run("vp", [
  "test",
  "run",
  ...testConfig,
  "--project",
  "webkit",
  "tests/browser/webkit.ts",
  "tests/browser/protocol.ts",
]);

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: packageDir,
    env: cleanTaskEnv(),
    stdio: "inherit",
  });
}

function cleanTaskEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_TASK")) delete env[key];
  }
  return env;
}
