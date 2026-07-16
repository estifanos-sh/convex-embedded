import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export function fixtureRemoteUrl(): string {
  const url = process.env.CONVEX_EMBEDDED_FIXTURE_URL?.trim();
  if (!url) {
    throw new Error(
      "Set CONVEX_EMBEDDED_FIXTURE_URL to the deployment running tests/fixture/convex before running remote tests.",
    );
  }
  return url;
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
      `CONVEX_EMBEDDED_FIXTURE_URL ${url} does not expose the embedded test fixture contract. Refusing to run remote tests against an application deployment.`,
      { cause },
    );
  }
  if (result.fixture !== "@convex-dev/embedded/remote-test-fixture" || result.version !== 1) {
    throw new Error(
      `CONVEX_EMBEDDED_FIXTURE_URL ${url} returned an incompatible fixture contract.`,
    );
  }
}
