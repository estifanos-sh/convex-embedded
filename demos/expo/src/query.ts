import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

import { client } from "@/src/client";
import { type EmbeddedQueryState, useQuerySubscription } from "@/src/subscription";

export type { EmbeddedQueryState } from "@/src/subscription";

/** Subscribe to an embedded query without introducing a Convex React provider. */
export function useEmbeddedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): EmbeddedQueryState<FunctionReturnType<Query>> {
  return useQuerySubscription(client, query, args);
}
