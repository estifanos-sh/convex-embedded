import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { deploymentUrl } from "../../../../config/deployment.js";
import { fixtureAdminKey } from "../../../../config/env.js";
import { repoRoot } from "../../../../config/read.js";

export function fixtureRemoteUrl(): string {
  const url = deploymentUrl(repoRoot);
  if (!url) {
    throw new Error("Set VITE_CONVEX_URL in the root .env.local before running remote tests.");
  }
  return url;
}

export { fixtureAdminKey };

/** Refuses to run remote mutations against an application deployment lacking the fixture API. */
// fallow-ignore-next-line unused-export -- Vite loads this default export through globalSetup.
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
