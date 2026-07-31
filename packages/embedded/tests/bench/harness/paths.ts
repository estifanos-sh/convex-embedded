import { fileURLToPath } from "node:url";

import { makeFunctionReference } from "convex/server";

import {
  convexDeployment,
  hostedRemoteUrl as resolveHostedRemoteUrl,
} from "../../../../../config/env.js";

const packageRootUrl = new URL("../../../", import.meta.url);

export const packageRoot = fileURLToPath(packageRootUrl);
export const browserBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/browser-realworld.json", packageRootUrl),
);
export const browserStartupBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/browser-startup.json", packageRootUrl),
);
export const browserRemoteBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/browser-remote.json", packageRootUrl),
);
export const browserScaleBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/browser-scale.json", packageRootUrl),
);
export const browserSeedPath = fileURLToPath(new URL("./tests/bench/seed.ts", packageRootUrl));
export const metalScaleBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/metal-scale.json", packageRootUrl),
);
export const metalReconnectVolumeBenchOutPath = fileURLToPath(
  new URL("./tests/bench/.out/metal-reconnect-volume.json", packageRootUrl),
);
export const browserDistPath = fileURLToPath(new URL("./dist/browser.mjs", packageRootUrl));
export const devtoolsDistPath = fileURLToPath(new URL("./dist/devtools/index.mjs", packageRootUrl));
export const metalConvexDir = fileURLToPath(new URL("./tests/metal/convex", packageRootUrl));
export const metalFixtureDir = fileURLToPath(new URL("./tests/fixture", packageRootUrl));
export const browserConvexDir = fileURLToPath(new URL("./tests/browser/convex", packageRootUrl));
export const browserLocalDir = fileURLToPath(new URL("./tests/browser/local", packageRootUrl));
export const localEntryPath = fileURLToPath(new URL("./src/local.ts", packageRootUrl));
export const convexPath = fileURLToPath(import.meta.resolve("convex"));
export const convexBrowserPath = fileURLToPath(import.meta.resolve("convex/browser"));
export const convexBrowserWebPath = convexBrowserPath.replace(/index-node\.js$/, "index.js");
export const convexServerPath = fileURLToPath(import.meta.resolve("convex/server"));
export const convexValuesPath = fileURLToPath(import.meta.resolve("convex/values"));
export const hostedRemoteUrl = resolveHostedRemoteUrl();
export const hostedDeployment = convexDeployment();
export const listRootDocuments = makeFunctionReference<
  "query",
  { limit?: number; prefix?: string },
  Array<{ body: string; title: string }>
>("documents:read");
export const createRootDocument = makeFunctionReference<
  "mutation",
  { body: string; slug: string; title: string },
  { _id: string }
>("documents:write");
