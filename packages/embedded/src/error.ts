export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stable public error codes and their meanings.
 *
 * @remarks
 * Every application-visible embedded failure that is thrown as an {@link EmbeddedError} carries
 * one of these codes. Terminal replication outcomes use
 * {@link EMBEDDED_SETTLEMENT_CODES} instead; they are delivered through
 * `subscribeToMutationSettlements()` rather than thrown.
 *
 * @public
 */
export const EMBEDDED_ERROR_CODES = {
  EMBEDDED_NOT_OPEN: "method called before the client was opened",
  EMBEDDED_OPEN_MISMATCH: "open called with a different setup action",
  EMBEDDED_CLOSED: "method called after shutdown began",
  EMBEDDED_OFFLINE: "hosted-only work has no reachable deployment",
  EMBEDDED_DEPENDENCY_FAILED: "required insert, upload, or schedule producer cannot apply",
  EMBEDDED_CLIENT_RETIRED:
    "client incarnation was retired; rotate ID, retain pending work, and establish fresh pull state",
  EMBEDDED_PROTOCOL_MISMATCH: "client and deployment protocol versions differ",
  EMBEDDED_STORAGE: "local durable storage could not open or commit",
  EMBEDDED_PRE_BASELINE_STORE:
    "the existing store predates the supported migration baseline and was preserved",
  EMBEDDED_UNSUPPORTED: "a local-capable function used a primitive V5 cannot reproduce",
} as const;

/** Stable public error code. @public */
export type EmbeddedErrorCode = keyof typeof EMBEDDED_ERROR_CODES;

/**
 * Stable terminal replication verdicts produced by the native settlement vector.
 *
 * @remarks
 * These values are intentionally distinct from {@link EmbeddedErrorCode}: a settlement has
 * already durably completed local processing and is reported as data, never thrown as a client
 * operation error.
 *
 * @public
 */
export const EMBEDDED_SETTLEMENT_CODES = {
  EMBEDDED_CONFLICT: "a plain point, range, or target witness moved",
  EMBEDDED_REJECTED: "authoritative app code rejected a locally committed mutation",
  EMBEDDED_DIVERGENCE:
    "normalized local and authoritative execution differed; server writes rolled back",
} as const;

/** Stable code carried by a terminal replication settlement. @public */
export type EmbeddedSettlementCode = keyof typeof EMBEDDED_SETTLEMENT_CODES;

/**
 * A public embedded failure carrying a stable {@link EmbeddedErrorCode}.
 *
 * @remarks
 * Messages include the smallest useful identifiers and never opaque payload bytes, auth tokens, or
 * private component state.
 *
 * @public
 */
export class EmbeddedError extends Error {
  readonly code: EmbeddedErrorCode;

  constructor(
    code: EmbeddedErrorCode,
    message: string = EMBEDDED_ERROR_CODES[code],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConvexEmbeddedError";
    this.code = code;
  }
}

/** Convert stable Rust/native markers into the public typed error surface. @internal */
export function normalizeStorageError(error: unknown): Error {
  const message = errorMessage(error);
  const marker = /\[convex-embedded:([A-Z_]+)\]/.exec(message)?.[1];
  if (marker !== undefined && marker in EMBEDDED_ERROR_CODES) {
    return new EmbeddedError(marker as EmbeddedErrorCode, message, { cause: error });
  }
  return error instanceof Error ? error : new EmbeddedError("EMBEDDED_STORAGE", message);
}

/** True when `error` is an {@link EmbeddedError} carrying `code`. @public */
export function isEmbeddedError(error: unknown, code?: EmbeddedErrorCode): error is EmbeddedError {
  return error instanceof EmbeddedError && (code === undefined || error.code === code);
}

/** A method was called after the client began shutting down. @public */
export class EmbeddedClosedError extends EmbeddedError {
  constructor(message = "ConvexEmbeddedClient has already been closed.") {
    super("EMBEDDED_CLOSED", message);
    this.name = "ConvexEmbeddedClosedError";
  }
}

/** A method requiring the runtime was called before `client.open()`. @public */
export class EmbeddedNotOpenError extends EmbeddedError {
  constructor(message = "Call await client.open() before using ConvexEmbeddedClient.") {
    super("EMBEDDED_NOT_OPEN", message);
    this.name = "ConvexEmbeddedNotOpenError";
  }
}

/** Concurrent `open()` calls supplied different setup identities. @public */
export class EmbeddedOpenMismatchError extends EmbeddedError {
  constructor(message = "ConvexEmbeddedClient is already opening with a different setup action.") {
    super("EMBEDDED_OPEN_MISMATCH", message);
    this.name = "ConvexEmbeddedOpenMismatchError";
  }
}

/** A function whose contract requires Convex was called without a configured deployment. */
export class EmbeddedOfflineError extends EmbeddedError {
  constructor(message = "This Convex function requires a configured hosted deployment.") {
    super("EMBEDDED_OFFLINE", message);
    this.name = "ConvexEmbeddedOfflineError";
  }
}

/** A hosted operation could not start because a local ID was not mapped before its deadline. */
export class EmbeddedHostedDependencyError extends EmbeddedError {
  constructor(
    message = "A local document ID was not mapped to Convex before the operation deadline.",
  ) {
    super("EMBEDDED_DEPENDENCY_FAILED", message);
    this.name = "ConvexEmbeddedHostedDependencyError";
  }
}

/** A remote client incarnation was retired by the deployment; the loop rotates to a fresh id. @public */
export class EmbeddedClientRetiredError extends EmbeddedError {
  constructor(message: string = EMBEDDED_ERROR_CODES.EMBEDDED_CLIENT_RETIRED) {
    super("EMBEDDED_CLIENT_RETIRED", message);
    this.name = "ConvexEmbeddedClientRetiredError";
  }
}

/** A local-capable function used a primitive the local runtime cannot reproduce. @public */
export class EmbeddedUnsupportedError extends EmbeddedError {
  constructor(message: string = EMBEDDED_ERROR_CODES.EMBEDDED_UNSUPPORTED) {
    super("EMBEDDED_UNSUPPORTED", message);
    this.name = "ConvexEmbeddedUnsupportedError";
  }
}

/** A hosted write crossed the network boundary but did not return a definitive result. */
export class EmbeddedHostedWriteIndeterminateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConvexEmbeddedHostedWriteIndeterminateError";
  }
}
