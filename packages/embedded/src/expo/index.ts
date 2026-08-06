/**
 * Expo native client entrypoint for embedded Convex.
 *
 * @packageDocumentation
 */
import "./crypto";

export { ConvexEmbeddedClient } from "./client";
export {
  EMBEDDED_ERROR_CODES,
  EMBEDDED_SETTLEMENT_CODES,
  EmbeddedError,
  isEmbeddedError,
} from "../error";
export type { EmbeddedErrorCode, EmbeddedSettlementCode } from "../error";
export type {
  AuthTokenFetcher,
  ConvexEmbeddedClientOptions,
  ConvexEmbeddedSchema,
  EmbeddedConnectionError,
  EmbeddedConnectionErrorCode,
  EmbeddedConnectionState,
  EmbeddedLocalConnectionState,
  EmbeddedMutationSettlement,
  EmbeddedReplicationConnectionState,
  EmbeddedRetainedRevision,
  Watch,
} from "./client";
