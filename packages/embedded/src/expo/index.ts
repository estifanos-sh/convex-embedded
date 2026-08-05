/**
 * Expo native client entrypoint for embedded Convex.
 *
 * @packageDocumentation
 */
import "./crypto";

export { ConvexEmbeddedClient } from "./client";
export { EMBEDDED_ERROR_CODES, EmbeddedError, isEmbeddedError } from "../error";
export type { EmbeddedErrorCode } from "../error";
export type {
  AuthTokenFetcher,
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedMutationOptions,
  ConvexEmbeddedSchema,
  EmbeddedConnectionState,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
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
