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
export {
  EMBEDDED_UPLOAD_PATH,
  createConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetchOptions,
} from "../browser/upload";
export type {
  AuthTokenFetcher,
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedMutationOptions,
  ConvexEmbeddedSchema,
  ConvexLocalModules,
  ConvexModules,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
  EmbeddedConnectionState,
  EmbeddedEvent,
  EmbeddedEventListener,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedOperationPhase,
  EmbeddedRemoteEvent,
  EmbeddedRemoteStatus,
  EmbeddedSchedulerEvent,
  EmbeddedSpanEvent,
  EmbeddedSpanPhase,
  EmbeddedStorageEvent,
  Watch,
} from "./client";
