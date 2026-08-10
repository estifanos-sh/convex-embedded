import { describe, expect, test } from "vite-plus/test";

import {
  EMBEDDED_ERROR_CODES,
  EmbeddedClosedError,
  EmbeddedError,
  EmbeddedHostedDependencyError,
  EmbeddedOfflineError,
  EmbeddedUnsupportedError,
  isEmbeddedError,
  normalizeStorageError,
  type EmbeddedErrorCode,
  EMBEDDED_SETTLEMENT_CODES,
  type EmbeddedSettlementCode,
} from "../../src/error";
import { deserializeError, serializeError } from "../../src/browser/protocol";

const CONTRACT_CODES: EmbeddedErrorCode[] = [
  "EMBEDDED_CLOSED",
  "EMBEDDED_NOT_OPEN",
  "EMBEDDED_OPEN_MISMATCH",
  "EMBEDDED_OFFLINE",
  "EMBEDDED_DEPENDENCY_FAILED",
  "EMBEDDED_CLIENT_RETIRED",
  "EMBEDDED_PROTOCOL_MISMATCH",
  "EMBEDDED_STORAGE",
  "EMBEDDED_PRE_BASELINE_STORE",
  "EMBEDDED_UNSUPPORTED",
];

const SETTLEMENT_CODES: EmbeddedSettlementCode[] = [
  "EMBEDDED_CONFLICT",
  "EMBEDDED_REJECTED",
  "EMBEDDED_DIVERGENCE",
];

describe("embedded error registry", () => {
  test("registers every stable contract code with a meaning", () => {
    expect(Object.keys(EMBEDDED_ERROR_CODES).sort()).toEqual([...CONTRACT_CODES].sort());
    for (const code of CONTRACT_CODES) {
      expect(EMBEDDED_ERROR_CODES[code].length).toBeGreaterThan(0);
    }
  });

  test("constructs every thrown code, including the Rust-originated storage path", () => {
    for (const code of CONTRACT_CODES) {
      const error = new EmbeddedError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toBe(EMBEDDED_ERROR_CODES[code]);
      expect(isEmbeddedError(error, code)).toBe(true);
    }
    expect(new EmbeddedError("EMBEDDED_STORAGE").code).toBe("EMBEDDED_STORAGE");
  });

  test("keeps terminal settlement codes out of thrown errors", () => {
    expect(Object.keys(EMBEDDED_SETTLEMENT_CODES).sort()).toEqual([...SETTLEMENT_CODES].sort());
    for (const code of SETTLEMENT_CODES) {
      expect(EMBEDDED_SETTLEMENT_CODES[code].length).toBeGreaterThan(0);
      expect(code in EMBEDDED_ERROR_CODES).toBe(false);
    }
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
    const error = new EmbeddedError("EMBEDDED_STORAGE");
    expect(isEmbeddedError(error, "EMBEDDED_OFFLINE")).toBe(false);
    expect(isEmbeddedError(new Error("plain"))).toBe(false);
  });

  test("normalizes the stable prebaseline marker shared by Node, WASM, and Expo", () => {
    const cause = new Error(
      "[convex-embedded:EMBEDDED_PRE_BASELINE_STORE] store epoch 0 predates baseline 1",
    );
    const error = normalizeStorageError(cause);
    expect(isEmbeddedError(error, "EMBEDDED_PRE_BASELINE_STORE")).toBe(true);
    expect(error.cause).toBe(cause);
  });

  test("preserves typed embedded codes across the browser worker boundary", () => {
    const source = new EmbeddedError(
      "EMBEDDED_PRE_BASELINE_STORE",
      "[convex-embedded:EMBEDDED_PRE_BASELINE_STORE] preserved",
    );
    const roundtrip = deserializeError(serializeError(source));
    expect(isEmbeddedError(roundtrip, "EMBEDDED_PRE_BASELINE_STORE")).toBe(true);
    expect(roundtrip.message).toBe(source.message);
  });
});
