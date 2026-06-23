import { describe, expect, test } from "vite-plus/test";

import {
  EMBEDDED_ERROR_CODES,
  EmbeddedClosedError,
  EmbeddedError,
  EmbeddedHostedDependencyError,
  EmbeddedOfflineError,
  EmbeddedUnsupportedError,
  isEmbeddedError,
  type EmbeddedErrorCode,
} from "../../src/error";

const CONTRACT_CODES: EmbeddedErrorCode[] = [
  "EMBEDDED_CLOSED",
  "EMBEDDED_OFFLINE",
  "EMBEDDED_CONFLICT",
  "EMBEDDED_REJECTED",
  "EMBEDDED_DIVERGENCE",
  "EMBEDDED_REBASE_EXHAUSTED",
  "EMBEDDED_DEPENDENCY_FAILED",
  "EMBEDDED_CLIENT_RETIRED",
  "EMBEDDED_SCHEMA_MISMATCH",
  "EMBEDDED_PROTOCOL_MISMATCH",
  "EMBEDDED_CRDT_CORRUPT",
  "EMBEDDED_STORAGE",
  "EMBEDDED_UNSUPPORTED",
];

describe("embedded error registry", () => {
  test("registers every stable contract code with a meaning", () => {
    expect(Object.keys(EMBEDDED_ERROR_CODES).sort()).toEqual([...CONTRACT_CODES].sort());
    for (const code of CONTRACT_CODES) {
      expect(EMBEDDED_ERROR_CODES[code].length).toBeGreaterThan(0);
    }
  });

  test("constructs every code, including the Rust-originated storage and schema paths", () => {
    for (const code of CONTRACT_CODES) {
      const error = new EmbeddedError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toBe(EMBEDDED_ERROR_CODES[code]);
      expect(isEmbeddedError(error, code)).toBe(true);
    }
    expect(new EmbeddedError("EMBEDDED_STORAGE").code).toBe("EMBEDDED_STORAGE");
    expect(new EmbeddedError("EMBEDDED_SCHEMA_MISMATCH").code).toBe("EMBEDDED_SCHEMA_MISMATCH");
    expect(new EmbeddedError("EMBEDDED_CRDT_CORRUPT").code).toBe("EMBEDDED_CRDT_CORRUPT");
  });

  test("public subclasses carry their contract code and stable name", () => {
    const offline = new EmbeddedOfflineError();
    expect(offline.code).toBe("EMBEDDED_OFFLINE");
    expect(offline.name).toBe("ConvexEmbeddedOfflineError");
    expect(isEmbeddedError(offline)).toBe(true);

    const dependency = new EmbeddedHostedDependencyError();
    expect(dependency.code).toBe("EMBEDDED_DEPENDENCY_FAILED");
    expect(dependency.name).toBe("ConvexEmbeddedHostedDependencyError");

    const closed = new EmbeddedClosedError();
    expect(closed.code).toBe("EMBEDDED_CLOSED");

    const unsupported = new EmbeddedUnsupportedError();
    expect(unsupported.code).toBe("EMBEDDED_UNSUPPORTED");
  });

  test("omits values and narrows by code", () => {
    const error = new EmbeddedError("EMBEDDED_CONFLICT");
    expect(isEmbeddedError(error, "EMBEDDED_REJECTED")).toBe(false);
    expect(isEmbeddedError(new Error("plain"))).toBe(false);
  });
});
