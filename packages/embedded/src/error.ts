export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stable public error codes and their meanings.
 *
 * @remarks
 * Every application-visible embedded failure that matches a contract category carries one of these
 * codes on an {@link EmbeddedError}. Storage, schema-mismatch, and CRDT-corruption categories
 * originate in the Rust store and surface through the binding.
 *
 * @public
 */
export const EMBEDDED_ERROR_CODES = {
  EMBEDDED_CLOSED: "method called after shutdown began",
  EMBEDDED_OFFLINE: "hosted-only work has no reachable deployment",
  EMBEDDED_CONFLICT: "a plain point, range, or target witness moved",
  EMBEDDED_REJECTED: "authoritative app code rejected a locally committed mutation",
  EMBEDDED_DIVERGENCE:
    "normalized local and authoritative execution differed; server writes rolled back",
  EMBEDDED_REBASE_EXHAUSTED:
    "one retry cycle exhausted its CRDT rebase budget; pending work is retained and backed off",
  EMBEDDED_DEPENDENCY_FAILED: "required insert, upload, or schedule producer cannot apply",
  EMBEDDED_CLIENT_RETIRED:
    "client incarnation was retired; rotate ID, retain pending work, and establish fresh pull state",
  EMBEDDED_SCHEMA_MISMATCH: "current app validators cannot consume stored or remote data",
  EMBEDDED_PROTOCOL_MISMATCH: "client and deployment protocol versions differ",
  EMBEDDED_CRDT_CORRUPT: "opaque history fails import, continuity, or projection-hash checks",
  EMBEDDED_STORAGE: "local durable storage could not open or commit",
  EMBEDDED_UNSUPPORTED: "a local-capable function used a primitive V5 cannot reproduce",
} as const;

/** Stable public error code. @public */
export type EmbeddedErrorCode = keyof typeof EMBEDDED_ERROR_CODES;

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
