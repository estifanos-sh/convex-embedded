/**
 * Expo native client entrypoint for embedded Convex.
 *
 * @packageDocumentation
 */
import "./crypto";

export { ConvexEmbeddedClient } from "./client";
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
