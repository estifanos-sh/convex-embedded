import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

run("vp", ["pack"]);
run("node", ["scripts/wasm.ts"]);
run("vp", ["test", "run", "--project", "browser", "tests/browser/runtime.ts"]);

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: packageDir,
    env: cleanTaskEnv(),
    stdio: "inherit",
  });
}

function cleanTaskEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_TASK")),
  );
}
