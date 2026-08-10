import { defineEmbedded } from "@estifanos-sh/convex-embedded/server";

import { components } from "./_generated/api";
import { embeddedManifest } from "./embedded.generated";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  manifest: embeddedManifest,
  schema,
});

// The browser and Expo demos share these root-deployment replication endpoints.
export const { push, pull, upload } = embedded;

export const { remote, replicated } = embedded;
