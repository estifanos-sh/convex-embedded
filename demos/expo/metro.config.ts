import path from "node:path";

import { withConvexEmbedded } from "@convex-dev/embedded/metro";
import { getDefaultConfig } from "expo/metro-config";

import schema from "../../convex/schema";
import {
  embeddedCompatiblePriorRuntimes,
  embeddedGeneratedPath,
  exposeExpoDeployment,
} from "../deployment";

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
exposeExpoDeployment(workspaceRoot);
const config = getDefaultConfig(projectRoot);

// Expo discovers pnpm workspace packages automatically, but the repository-level Convex source is
// not a workspace package. Add only that source root and preserve Expo's resolver configuration.
config.watchFolders = [
  ...new Set([...(config.watchFolders ?? []), path.join(workspaceRoot, "convex")]),
];

export default withConvexEmbedded(config, {
  compatiblePriorRuntimes: embeddedCompatiblePriorRuntimes,
  generatedPath: embeddedGeneratedPath,
  root: workspaceRoot,
  schema,
});
