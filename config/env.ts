import { fileURLToPath, URL } from "node:url";

import { readValue, rootEnvFile } from "./read.ts";

const fixtureEnvFile = new URL("packages/embedded/tests/fixture/.env.local", rootEnvFile);

/** The client-safe Convex URL shared by every demo and test surface. */
export function convexUrl(): string | undefined {
  return readValue("VITE_CONVEX_URL") ?? readValue("CONVEX_URL");
}

export function requireConvexUrl(): string {
  const value = convexUrl();
  if (value) return value;
  throw new Error(
    `Missing Convex deployment URL. Set VITE_CONVEX_URL in ${fileURLToPath(rootEnvFile)} or the build environment.`,
  );
}

/** The deployment slug written by the Convex CLI, cross-checked against the URL. */
export function convexDeployment(): string | undefined {
  return readValue("CONVEX_DEPLOYMENT");
}

/** The fixture deployment admin key, read only from the fixture's own `.env.local`. */
export function fixtureAdminKey(): string {
  const key = readValue("CONVEX_EMBEDDED_FIXTURE_ADMIN_KEY", [fixtureEnvFile]);
  if (!key) {
    throw new Error(
      "Run Convex from packages/embedded/tests/fixture so its local admin key is available to the authorization test.",
    );
  }
  return key;
}

/** The shared URL when it names a reachable hosted deployment, else undefined. */
export function hostedRemoteUrl(): string | undefined {
  const explicit = readValue("VITE_CONVEX_URL");
  if (!explicit) return undefined;
  try {
    const url = new URL(explicit);
    if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
