import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

describe("generated contracts", () => {
  test("bind every local ABI to its checked semantic source surface", () => {
    expect(() =>
      execFileSync(process.execPath, ["packages/embedded/scripts/contract.mjs", "--check"], {
        cwd: resolve(import.meta.dirname, "../../../.."),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  test("detects runtime helpers and Rust exports beyond their TypeScript declarations", () => {
    expectSurfaceDrift(
      "browser",
      "packages/embedded/src/browser/coordinator/protocol.ts",
      "function isCanonicalFence",
      "function isChangedCanonicalFence",
    );
    expectSurfaceDrift(
      "browser",
      "packages/embedded/src/browser/identity.ts",
      "function runtimeScope",
      "function changedRuntimeScope",
    );
    expectSurfaceDrift(
      "mobile",
      "crates/mobile/src/ffi.rs",
      "fn cem_bridge_contract_id",
      "fn cem_changed_bridge_contract_id",
    );
    expectSurfaceDrift(
      "storage",
      "crates/node/src/lib.rs",
      "fn binding_contract_id",
      "fn changed_binding_contract_id",
    );
    expectSurfaceDrift(
      "storage",
      "packages/embedded/src/browser/opfs.ts",
      "export class OpfsDirectory",
      "export class ChangedOpfsDirectory",
    );
  }, 20_000);
});

function expectSurfaceDrift(contract: string, file: string, before: string, after: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "packages/embedded/scripts/contract.mjs",
      "--check",
      "--test-source-mutation",
      file,
      before,
      after,
    ],
    { cwd: resolve(import.meta.dirname, "../../../.."), encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`protocol/${contract}.json semantic surface changed`);
}
