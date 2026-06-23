export function fixtureRemoteUrl(): string {
  const url = process.env.CONVEX_EMBEDDED_FIXTURE_URL?.trim();
  if (!url) {
    throw new Error(
      "Set CONVEX_EMBEDDED_FIXTURE_URL to the deployment running tests/fixture/convex before running remote tests.",
    );
  }
  return url;
}
