/**
 * Node client entrypoint for embedded Convex.
 *
 * @remarks
 * Import from `@convex-dev/embedded/node` when running Convex functions in a
 * Node process with the Rust/NAPI storage backend.
 *
 * @example
 * ```ts
 * import { ConvexEmbeddedClient } from "@convex-dev/embedded/node";
 * import { api } from "../convex/_generated/api";
 * import schema from "../convex/schema";
 *
 * const client = new ConvexEmbeddedClient({
 *   schema,
 *   modules: {},
 *   path: ".convex-embedded/db.sqlite3",
 * });
 * await client.query(api.todos.list, {});
 * ```
 *
 * @packageDocumentation
 */
export { ConvexEmbeddedClient } from "./client";
export type {
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedMutationOptions,
  ConvexEmbeddedSchema,
  ConvexModules,
  MutationOptions,
  OptimisticLocalStore,
  OptimisticUpdate,
  Watch,
  WatchQueryOptions,
} from "./client";
