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
export {
  EMBEDDED_UPLOAD_PATH,
  createConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetch,
  type ConvexEmbeddedUploadFetchOptions,
} from "./upload";
export type {
  AuthTokenFetcher,
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedMutationOptions,
  ConvexEmbeddedSchema,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataUpsert,
  EmbeddedConnectionState,
  EmbeddedEvent,
  EmbeddedEventListener,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedOperationPhase,
  EmbeddedRuntimeDegradation,
  EmbeddedRuntimeEvent,
  EmbeddedRuntimePhase,
  EmbeddedRemoteEvent,
  EmbeddedRemoteStatus,
  EmbeddedSchedulerEvent,
  EmbeddedSpanEvent,
  EmbeddedSpanPhase,
  EmbeddedStorageEvent,
  Watch,
} from "./client";
