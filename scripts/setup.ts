import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { deploymentUrl, requireDeploymentUrl } from "../config/deployment.ts";
import { parseEnvFile, repoRoot, rootEnvFile } from "../config/read.ts";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes");
const link = args.includes("--link");
const interactive = Boolean(process.stdin.isTTY) && !process.env.CI && !assumeYes;

const envLocalPath = fileURLToPath(rootEnvFile);
const envExamplePath = fileURLToPath(new URL("../.env.example", import.meta.url));

await setup();

async function setup(): Promise<void> {
  ensureEnvLocal();

  const resolved = deploymentUrl(repoRoot);
  if (resolved) {
    persistToEnvLocal(resolved);
    console.log(`Convex deployment configured: ${resolved}`);
  } else if (!interactive) {
    console.error(
      `Missing Convex deployment URL. Set VITE_CONVEX_URL in ${envLocalPath} or the environment, ` +
        "or run `vp run setup` in an interactive terminal.",
    );
    process.exit(1);
  } else if (link) {
    provisionWithConvex();
  } else {
    await promptForUrl();
  }

  printNextSteps(requireDeploymentUrl(repoRoot));
}

/** Seed `.env.local` from the checked-in example, with the values blanked out. */
function ensureEnvLocal(): void {
  if (existsSync(envLocalPath)) return;
  const template = existsSync(envExamplePath)
    ? readFileSync(envExamplePath, "utf8").replace(/^([A-Z0-9_]+)=.*$/gm, "$1=")
    : "";
  writeFileSync(envLocalPath, template);
  console.log(`Created ${envLocalPath} from .env.example.`);
}

/** Persist an environment-provided URL to `.env.local` so later tooling reads it durably. */
function persistToEnvLocal(url: string): void {
  const fileEnv = parseEnvFile(rootEnvFile);
  if (fileEnv.VITE_CONVEX_URL?.trim() || fileEnv.CONVEX_URL?.trim()) return;
  writeEnvValue("VITE_CONVEX_URL", url);
  console.log(`Persisted VITE_CONVEX_URL to ${envLocalPath}.`);
}

async function promptForUrl(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (
        await rl.question("Convex deployment URL from `npx convex dashboard` (https://...): ")
      ).trim();
      if (isHttpsUrl(answer)) {
        writeEnvValue("VITE_CONVEX_URL", answer);
        console.log(`Set VITE_CONVEX_URL in ${envLocalPath}.`);
        return;
      }
      console.error("Enter a valid https:// Convex URL, or press Ctrl-C to cancel.");
    }
  } finally {
    rl.close();
  }
}

/** Opt-in `--link`: let the Convex CLI provision a dev deployment once and exit. */
function provisionWithConvex(): void {
  console.log("Provisioning a Convex dev deployment with `convex dev --once --configure`...");
  const result = spawnSync("vpx", ["convex", "dev", "--once", "--configure"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      "Convex provisioning did not complete. Re-run `vp run setup` or set VITE_CONVEX_URL manually.",
    );
    process.exit(result.status ?? 1);
  }
}

function writeEnvValue(name: string, value: string): void {
  const current = existsSync(envLocalPath) ? readFileSync(envLocalPath, "utf8") : "";
  const assignment = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(current)) {
    writeFileSync(envLocalPath, current.replace(pattern, assignment));
    return;
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(envLocalPath, `${current}${separator}${assignment}\n`);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function printNextSteps(url: string): void {
  console.log("");
  console.log(`Convex deployment ready: ${url}`);
  console.log("Next steps:");
  console.log("  vp check                  # format, lint, and type-check");
  console.log("  vp test                   # run the unit/storage/runtime/server/surface suites");
  console.log("  vp run dev:browser:vite   # run the browser demo");
  console.log("  vp run dev:expo           # run the Expo demo");
  console.log("");
  console.log(
    "Remote authorization tests also need CONVEX_EMBEDDED_FIXTURE_ADMIN_KEY in " +
      "packages/embedded/tests/fixture/.env.local.",
  );
}
