import path from "node:path";

import { withConvexEmbedded } from "@convex-dev/embedded/metro";
import { getDefaultConfig } from "expo/metro-config";

import schema from "../../convex/schema";
import { embeddedGeneratedPath, embeddedLocalPath, exposeExpoDeployment } from "../../config";

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const localDir = path.join(workspaceRoot, embeddedLocalPath);
exposeExpoDeployment(workspaceRoot);
const config = getDefaultConfig(projectRoot);

// Expo discovers pnpm workspace packages automatically, but the repository-level Convex and
// device-only sources are not workspace packages. Add only those source roots and preserve Expo's
// resolver configuration.
config.watchFolders = [
  ...new Set([...(config.watchFolders ?? []), path.join(workspaceRoot, "convex"), localDir]),
];

export default withConvexEmbedded(config, {
  generatedPath: embeddedGeneratedPath,
  local: localDir,
  root: workspaceRoot,
  schema,
});
