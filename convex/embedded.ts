import { defineEmbedded } from "@convex-dev/embedded/server";

import { components } from "./_generated/api";
import { embeddedManifest } from "./_generated/embedded";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  manifest: embeddedManifest,
  schema,
});

export const { upload, push, pull } = embedded;
