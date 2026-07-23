import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;
export type MutableDeploymentEnvironment = Record<string, string | undefined>;

const deploymentNames = ["VITE_CONVEX_URL", "CONVEX_URL"] as const;

/** Generated contract path kept outside Convex CLI-owned `_generated`. */
export const embeddedGeneratedPath = "generated/embedded.ts";

/**
 * Reviewed build migrations for durable demo mutations. Every declaration pins the one reviewed target
 * graph so a later build fails closed until re-reviewed.
 *
 * This build renamed the document surface to the storage lexicon: the `list`/`get`/`getBySlug` queries
 * collapsed into `documents:read`, the `create`/`update`/`writeBody`/`writeSlug` mutations into
 * `documents:write`, `remove` into `documents:del`, and `savepoint` moved to `rev:savepoint`. The
 * `8975…` graph is the immediately prior build (it dropped the `documents:summaries` list query). Because
 * mutation wire names changed, a client that upgrades across this boundary while holding an unsettled
 * durable mutation recorded under an old name replays it under that old name; confirm that transition is
 * acceptable at deploy time before trusting it.
 */
export const embeddedCompatiblePriorRuntimes = [
  {
    moduleGraphHash: "fe4d109bd5da3121",
    protocolVersion: 25,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
  {
    moduleGraphHash: "3dec910778cbead7",
    protocolVersion: 24,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
  {
    moduleGraphHash: "b8f55ea7c16f2604",
    protocolVersion: 24,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
  {
    moduleGraphHash: "fab5f6210c35cfca",
    protocolVersion: 24,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
  {
    moduleGraphHash: "fab5f6210c35cfca",
    protocolVersion: 25,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
  {
    moduleGraphHash: "8975648676c532b0",
    protocolVersion: 25,
    schemaHash: "fd6fd33687d90268",
    targetModuleGraphHash: "b7a09fdaa719d405",
  },
] as const;

/** Resolve the client-safe Convex URL shared by browser and native demos. */
export function resolveDeploymentUrl(
  environment: DeploymentEnvironment,
  rootEnvironment: DeploymentEnvironment = {},
): string {
  for (const source of [environment, rootEnvironment]) {
    for (const name of deploymentNames) {
      const value = source[name]?.trim();
      if (value) return value;
    }
  }
  return "";
}

/** Read the shared deployment from process overrides, then the repository root `.env.local`. */
export function deploymentUrl(
  workspaceRoot: string,
  environment: DeploymentEnvironment = process.env,
): string {
  return resolveDeploymentUrl(environment, readRootEnvironment(workspaceRoot));
}

/** Require the one deployment shared by both demo build graphs. */
export function requireDeploymentUrl(
  workspaceRoot: string,
  environment: DeploymentEnvironment = process.env,
): string {
  const value = deploymentUrl(workspaceRoot, environment);
  if (value) return value;
  throw new Error(
    `Missing Convex deployment URL. Set VITE_CONVEX_URL in ${join(
      workspaceRoot,
      ".env.local",
    )} or in the build environment.`,
  );
}

/** Expose the shared URL under Expo's client-visible build-time prefix. */
export function exposeExpoDeployment(
  workspaceRoot: string,
  environment: MutableDeploymentEnvironment = process.env,
): string {
  const value = requireDeploymentUrl(workspaceRoot, environment);
  environment.EXPO_PUBLIC_CONVEX_URL = value;
  return value;
}

function readRootEnvironment(workspaceRoot: string): DeploymentEnvironment {
  try {
    return parseEnv(readFileSync(join(workspaceRoot, ".env.local"), "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
