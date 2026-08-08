/** Internal wire revision. Increment for every breaking client/component protocol change. */
/** The current wire requires structured, sanitized terminal replay failure codes. */
export const EMBEDDED_PROTOCOL_VERSION = 27;

/**
 * The deliberately finite set of hosted wires this package deployment understands.
 *
 * This is not a numeric range: adding a wire requires an explicit adapter and tests for both
 * directions. Keep the order newest-first so identity selection prefers the current wire.
 */
export const EMBEDDED_PROTOCOL_VERSIONS = [EMBEDDED_PROTOCOL_VERSION] as const;

export type EmbeddedProtocolVersion = (typeof EMBEDDED_PROTOCOL_VERSIONS)[number];

/** Whether a runtime request names one of this deployment's explicit wire adapters. */
export function isEmbeddedProtocolVersion(value: number): value is EmbeddedProtocolVersion {
  return value === EMBEDDED_PROTOCOL_VERSION;
}

/**
 * Select the shared wire for an identity request.
 *
 * Clients advertise their complete discrete set and receive the newest common wire. This decision
 * happens before an identity response or any durable component write.
 */
export function selectEmbeddedProtocolVersion(
  offered: readonly number[] | undefined,
): EmbeddedProtocolVersion | undefined {
  if (offered === undefined) return undefined;
  for (const version of EMBEDDED_PROTOCOL_VERSIONS) {
    if (offered.includes(version)) return version;
  }
  return undefined;
}

/** Stable Convex error code for a client/component wire revision mismatch. */
export const EMBEDDED_PROTOCOL_MISMATCH = "EMBEDDED_PROTOCOL_MISMATCH";

/** Stable Convex error code for a retired remote client incarnation; survives prod error redaction. */
export const EMBEDDED_CLIENT_RETIRED = "EMBEDDED_CLIENT_RETIRED";

/** Reserved local partition key for unauthenticated data; non-hex so it never collides with a {@link hashValue} digest. */
export const EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY = "unauthenticated";
