/**
 * Node client entrypoint for embedded Convex.
 *
 * @remarks
 * Import from `@estifanos-sh/convex-embedded/node` when running Convex functions in a
 * Node process with the Rust/NAPI storage backend.
 *
 * @example
 * ```ts
 * import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/node";
 * import { api } from "../convex/_generated/api";
 * import schema from "../convex/schema";
 *
 * const client = new ConvexEmbeddedClient({
 *   schema,
 *   modules: {},
 *   path: ".convex-embedded/db.sqlite3",
 * });
 * await client.open();
 * await client.query(api.todos.list, {});
 * ```
 *
 * @packageDocumentation
 */
export { ConvexEmbeddedClient } from "./client";
export {
  EMBEDDED_ERROR_CODES,
  EMBEDDED_SETTLEMENT_CODES,
  EmbeddedError,
  isEmbeddedError,
} from "../error";
export type { EmbeddedErrorCode, EmbeddedSettlementCode } from "../error";
export {
  EMBEDDED_UPLOAD_PATH,
  createConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetchOptions,
} from "../browser/upload";
export type {
  AuthTokenFetcher,
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedSchema,
  ConvexLocalModules,
  ConvexModules,
  EmbeddedConnectionError,
  EmbeddedConnectionErrorCode,
  EmbeddedConnectionState,
  EmbeddedLocalConnectionState,
  EmbeddedMutationSettlement,
  EmbeddedReplicationConnectionState,
  EmbeddedRetainedRevision,
  Watch,
} from "./client";
