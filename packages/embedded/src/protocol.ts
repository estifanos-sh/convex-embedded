/** Internal wire revision. Increment for every breaking client/component protocol change. */
export const EMBEDDED_PROTOCOL_VERSION = 23;

/** Stable Convex error code for a client/component wire revision mismatch. */
export const EMBEDDED_PROTOCOL_MISMATCH = "EMBEDDED_PROTOCOL_MISMATCH";

/** Stable Convex error code for a retired remote client incarnation; survives prod error redaction. */
export const EMBEDDED_CLIENT_RETIRED = "EMBEDDED_CLIENT_RETIRED";

/** Reserved local partition key for unauthenticated data; non-hex so it never collides with a {@link hashValue} digest. */
export const EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY = "unauthenticated";
