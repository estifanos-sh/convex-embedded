import { readFileSync } from "node:fs";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const rootEnv = new URL("../../../../.env.local", import.meta.url);
const fixtureEnv = new URL("../fixture/.env.local", import.meta.url);

export function fixtureRemoteUrl(): string {
  const url = readEnv("VITE_CONVEX_URL", [rootEnv]) ?? readEnv("CONVEX_URL", [rootEnv]);
  if (!url) {
    throw new Error("Set VITE_CONVEX_URL in the root .env.local before running remote tests.");
  }
  return url;
}

export function fixtureAdminKey(): string {
  const key = readEnv("CONVEX_EMBEDDED_FIXTURE_ADMIN_KEY", [fixtureEnv]);
  if (!key) {
    throw new Error(
      "Run Convex from packages/embedded/tests/fixture so its local admin key is available to the authorization test.",
    );
  }
  return key;
}

/** Refuses to run remote mutations against an application deployment lacking the fixture API. */
export default async function setup(): Promise<void> {
  const url = fixtureRemoteUrl();
  const contract = makeFunctionReference<
    "query",
    Record<string, never>,
    { fixture: string; version: number }
  >("contract:read");
  let result: { fixture: string; version: number };
  try {
    result = await new ConvexHttpClient(url).query(contract, {});
  } catch (cause) {
    throw new Error(
      `The root .env.local Convex deployment at ${url} does not expose the embedded test fixture contract. Refusing to run destructive remote tests against an application deployment.`,
      { cause },
    );
  }
  if (result.fixture !== "@convex-dev/embedded/remote-test-fixture" || result.version !== 1) {
    throw new Error(`The Convex deployment at ${url} returned an incompatible fixture contract.`);
  }
}

function readEnv(name: string, files: URL[]): string | undefined {
  for (const file of files) {
    try {
      const value = readEnvFile(file, name);
      if (value) return value;
    } catch {
      // Missing local env files are reported by the public accessor with actionable context.
    }
  }
  return process.env[name]?.trim() || undefined;
}

function readEnvFile(file: URL, name: string): string | undefined {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator).trim() !== name) continue;
    return (
      trimmed
        .slice(separator + 1)
        .trim()
        .replace(/\s+#.*$/, "")
        .replace(/^['"]|['"]$/g, "") || undefined
    );
  }
  return undefined;
}
