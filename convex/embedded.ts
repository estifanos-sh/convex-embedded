import { defineEmbedded } from "@convex-dev/embedded/server";

import { components } from "./_generated/api";
import schema from "./schema";

export const embedded = defineEmbedded({
  component: components.embedded,
  schema,
});

export const { query, mutation, internalQuery, internalMutation, push, pull } = embedded;
