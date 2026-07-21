import { ConvexEmbeddedClient } from "@convex-dev/embedded/expo";

/** One native store and reactive cache for the lifetime of the application. */
const scope = globalThis as typeof globalThis & {
  __convexEmbeddedDemoClient?: ConvexEmbeddedClient;
};

export const client =
  scope.__convexEmbeddedDemoClient ??
  (scope.__convexEmbeddedDemoClient = new ConvexEmbeddedClient({
    path: "convex-embedded-demo.sqlite3",
  }));
