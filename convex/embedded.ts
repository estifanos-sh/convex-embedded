import { defineEmbedded } from "@convex-dev/embedded/server";

import { components } from "./_generated/api";
import { embeddedManifest } from "./generated/embedded";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  manifest: embeddedManifest,
  schema,
});

// The browser and Expo demos share these root-deployment replication endpoints.
export const { upload, push, pull } = embedded;
