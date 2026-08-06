import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Robelest publishing workflow", () => {
  test("assembles every runtime before publishing the guarded package", () => {
    const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");

    for (const target of [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-x64-gnu",
      "win32-x64",
    ]) {
      expect(workflow).toContain(`target: ${target}`);
    }
    expect(workflow).toContain("Build every Apple slice through the Expo hook");
    expect(workflow).toContain("Build every Android ABI through the Expo hook");
    expect(workflow).toContain("runs-on: large-runner");
    expect(workflow).toContain("needs: [gate, javascript]");
    expect(workflow).toContain("Download JavaScript bundle for the Node smoke test");
    expect(workflow).toContain("Enable pnpm for the Expo compile fixture");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts pack");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts prepare-build");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts qualify-tarball");
    expect(workflow).toMatch(
      /name: Prepare and pack the guarded Robelest package[\s\S]*?name: Qualify exact packed artifact[\s\S]*?qualify-tarball artifacts\/convex-embedded\.tgz/,
    );
    expect(workflow).toContain(
      "npm publish ./artifacts/convex-embedded.tgz --ignore-scripts --access public",
    );
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "false"');
    expect(workflow).toContain("Publish package preview prerelease");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("artifacts/convex-embedded.tgz");
    expect(workflow).toContain("tar -xOzf artifacts/convex-embedded.tgz package/package.json");
    expect(workflow).not.toContain("pkg-pr-new");
    expect(workflow).toContain("Prerelease and release modes require a robelest-v* tag");
    expect(workflow).toContain("options: [preview, prerelease, release]");
    expect(workflow).toContain("dist_tag=latest");
    expect(workflow).not.toContain("dist_tag=preview");
    expect(workflow).toContain("CONVEX_EMBEDDED_PUBLISH_VERSION");
    expect(workflow).toContain("@robelest/convex-embedded");
    expect(workflow).toContain("github.repository == 'get-convex/embedded'");
    expect(workflow).toContain('REPOSITORY" != "get-convex/embedded"');
    expect(workflow).not.toContain("github.repository == 'robelest/convex-embedded'");
    expect(workflow).toContain("Refusing to publish unexpected package");
    expect(workflow).toContain("Verify packaged Node candidate conformance and process death");
    expect(workflow).toContain(
      "Verify production WASM OPFS conformance, worker death, stress, and memory ceilings",
    );
    expect(workflow).toContain("candidate_cold_and_warm_stress_preserves_every_row");
    expect(workflow).toContain("result_only_cursor_updates_batch_projection_dependencies");
    expect(workflow).toContain("cargo test -p storage --features testkit --test migration");
    expect(workflow).toContain("cargo test -p mobile");
    expect(workflow).toContain("vp test run packages/embedded/tests/unit/expo.ts");
    expect(workflow).not.toContain('tags: ["robelest-v*"]');
    expect(workflow).not.toContain('[[ "$EVENT" == "push" ]]');
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("labels.*.name, 'npm package'");
    expect(workflow).toContain('PACKAGE_PREVIEW" == "true"');
    expect(workflow).toContain('INPUT_MODE" == "prerelease"');
    expect(workflow).toMatch(
      /name: Checkout exact source[\s\S]*?fetch-depth: 0[\s\S]*?name: Verify Preview2 baseline/,
    );
    expect(workflow).toMatch(
      /name: Assemble and verify package[\s\S]*?name: Checkout[\s\S]*?fetch-depth: 0/,
    );
    expect(workflow).toContain("Qualify exact source for publication");
    expect(workflow).toContain("Bind packed artifact digest");
    expect(workflow).toContain("tarball_sha256: ${{ steps.tarball.outputs.sha256 }}");
    expect(workflow).toContain(
      "ASSEMBLED_TARBALL_SHA256: ${{ needs.assemble.outputs.tarball_sha256 }}",
    );
    expect(workflow).toContain("Robelest package SHA-256: $ASSEMBLED_TARBALL_SHA256");
    expect(workflow).toContain(
      "EXPECTED_TARBALL_SHA256: ${{ needs.release-tag.outputs.tarball_sha256 }}",
    );
    expect(workflow).toContain("Downloaded package digest $ACTUAL_TARBALL_SHA256");
    expect(workflow).toContain("needs: [gate, qualification, javascript, node, apple, android]");
    expect(workflow).toContain("Bind release tag to validated source");
    expect(workflow).toContain("git fetch --no-tags origin main");
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(workflow).toContain("ref: ${{ needs.gate.outputs.sha }}");
    expect(workflow).toContain("EXPECTED_SHA: ${{ needs.gate.outputs.sha }}");
    expect(workflow).toContain("ASSEMBLED_SHA: ${{ needs.assemble.outputs.sha }}");
    expect(workflow).toContain("needs: [gate, qualification, assemble, release-tag]");
    expect(workflow).toContain("RELEASE_TAG: ${{ needs.release-tag.outputs.tag }}");
    expect(workflow).not.toContain("Tag merged release and start the trusted build");
  });

  test("ordinary CI no longer publishes the incomplete JavaScript-only preview", () => {
    const workflow = readFileSync(join(root, ".github/workflows/preview.yml"), "utf8");

    expect(workflow).not.toContain("pkg-pr-new publish");
    expect(workflow).not.toContain("Publish preview");
  });
});
