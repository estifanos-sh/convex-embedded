import { ConvexEmbeddedClient } from "@convex-dev/embedded/expo";

/** One native store and reactive cache for the lifetime of the application. */
const scope = globalThis as typeof globalThis & {
  __convexEmbeddedDemoClient?: ConvexEmbeddedClient;
};
const deploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL?.trim();
if (!deploymentUrl) {
  throw new Error(
    "Missing Convex deployment URL. Set VITE_CONVEX_URL in the repository root .env.local and reload Metro.",
  );
}

export const client =
  scope.__convexEmbeddedDemoClient ??
  (scope.__convexEmbeddedDemoClient = new ConvexEmbeddedClient({
    path: "convex-embedded-demo-preview2.sqlite3",
    url: deploymentUrl,
  }));

/** Await before mounting a consumer that issues queries. */
export const clientReady = client.open();
