import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseEnvFile } from "./read.ts";

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;
export type MutableDeploymentEnvironment = Record<string, string | undefined>;

const deploymentNames = ["VITE_CONVEX_URL", "CONVEX_URL"] as const;

/** Checked-in Embedded contract, kept outside Convex's generator-owned directory. */
export const embeddedGeneratedPath = "embedded.generated.ts";

/** Device-only function root, relative to the repository root, shared by both demo graphs. */
export const embeddedLocalPath = "local";

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
    )} or the build environment.`,
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
  return parseEnvFile(pathToFileURL(join(workspaceRoot, ".env.local")));
}
