import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  deploymentUrl,
  embeddedGeneratedPath,
  exposeExpoDeployment,
  requireDeploymentUrl,
  resolveDeploymentUrl,
} from "../../deployment";

void describe("demo deployment configuration", () => {
  void it("keeps browser and Metro generation outside Convex-owned output", () => {
    assert.equal(embeddedGeneratedPath, "generated/embedded.ts");
  });

  void it("uses process overrides before the shared root environment", () => {
    assert.equal(
      resolveDeploymentUrl(
        { VITE_CONVEX_URL: " https://override.convex.cloud " },
        { VITE_CONVEX_URL: "https://root.convex.cloud" },
      ),
      "https://override.convex.cloud",
    );
    assert.equal(
      resolveDeploymentUrl(
        { CONVEX_URL: " https://process.convex.cloud " },
        { VITE_CONVEX_URL: "https://root.convex.cloud" },
      ),
      "https://process.convex.cloud",
    );
    assert.equal(
      resolveDeploymentUrl({}, { CONVEX_URL: " https://fallback.convex.cloud " }),
      "https://fallback.convex.cloud",
    );
    assert.equal(
      resolveDeploymentUrl(
        { CONVEX_URL: "https://generic.convex.cloud" },
        { VITE_CONVEX_URL: "https://root.convex.cloud" },
      ),
      "https://generic.convex.cloud",
    );
  });

  void it("reads the repository root env file without an Expo-local copy", (context) => {
    const root = mkdtempSync(join(tmpdir(), "convex-embedded-deployment-"));
    context.after(() => rmSync(root, { force: true, recursive: true }));
    writeFileSync(
      join(root, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:ignored\nVITE_CONVEX_URL=https://shared.convex.cloud\n",
    );

    assert.equal(deploymentUrl(root, {}), "https://shared.convex.cloud");
  });

  void it("maps only the canonical shared URL to Expo", (context) => {
    const root = mkdtempSync(join(tmpdir(), "convex-embedded-deployment-"));
    context.after(() => rmSync(root, { force: true, recursive: true }));
    writeFileSync(join(root, ".env.local"), "VITE_CONVEX_URL=https://shared.convex.cloud\n");
    const local: Record<string, string | undefined> = {};
    const conflicting: Record<string, string | undefined> = {
      EXPO_PUBLIC_CONVEX_URL: "https://different.convex.cloud",
    };

    assert.equal(exposeExpoDeployment(root, local), "https://shared.convex.cloud");
    assert.equal(local.EXPO_PUBLIC_CONVEX_URL, "https://shared.convex.cloud");
    assert.equal(exposeExpoDeployment(root, conflicting), "https://shared.convex.cloud");
    assert.equal(conflicting.EXPO_PUBLIC_CONVEX_URL, "https://shared.convex.cloud");
  });

  void it("fails clearly when the shared deployment is missing", (context) => {
    const root = mkdtempSync(join(tmpdir(), "convex-embedded-deployment-"));
    context.after(() => rmSync(root, { force: true, recursive: true }));

    assert.throws(() => requireDeploymentUrl(root, {}), /Set VITE_CONVEX_URL/);
    assert.throws(
      () =>
        exposeExpoDeployment(root, {
          EXPO_PUBLIC_CONVEX_URL: "https://expo-only.convex.cloud",
        }),
      /Set VITE_CONVEX_URL/,
    );
  });
});
