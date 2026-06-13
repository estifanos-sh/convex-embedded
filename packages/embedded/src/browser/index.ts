/**
 * Browser client entrypoint for embedded Convex.
 *
 * @remarks
 * Import from `@convex-dev/embedded/browser` when running Convex functions in
 * the browser with worker-owned Rust/WASM storage. Browser applications should
 * also install the Vite or unplugin adapter so the worker can load the local
 * Convex schema and function modules.
 *
 * @example
 * ```ts
 * import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";
 *
 * const client = new ConvexEmbeddedClient();
 * ```
 *
 * @packageDocumentation
 */
import { embeddedIdentity } from "virtual:convex-embedded/identity";
import { setEmbeddedIdentity } from "./identity";

setEmbeddedIdentity(embeddedIdentity);

export { ConvexEmbeddedClient } from "./client";
export type {
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedMutationOptions,
  ConvexEmbeddedSchema,
  MutationOptions,
  OptimisticLocalStore,
  OptimisticUpdate,
  Watch,
  WatchQueryOptions,
} from "./client";
