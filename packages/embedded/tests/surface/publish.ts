import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Embedded publishing workflow", () => {
  test("assembles every runtime before publishing the independently verified package", () => {
    const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");

    for (const target of ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu", "win32-x64"]) {
      expect(workflow).toContain(`target: ${target}`);
    }
    expect(workflow).not.toContain("target: darwin-x64");
    expect(workflow).toContain("Build every Apple slice through the Expo hook");
    expect(workflow).toContain("Build every Android ABI through the Expo hook");
    expect(workflow).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(workflow).toContain("needs: [gate, javascript]");
    expect(workflow).toContain("Download JavaScript bundle for the Node smoke test");
    expect(workflow).toContain("Enable pnpm for the Expo compile fixture");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts pack");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts prepare-build");
    expect(workflow).toContain("node packages/embedded/scripts/publish.ts qualify-tarball");
    expect(workflow).toMatch(
      /name: Prepare and pack the verified Embedded package[\s\S]*?name: Qualify exact packed artifact[\s\S]*?qualify-tarball artifacts\/convex-embedded\.tgz/,
    );
    expect(workflow).toContain(
      "npm publish ./artifacts/convex-embedded.tgz --ignore-scripts --access public",
    );
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(workflow).toContain("Publish package preview prerelease");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("artifacts/convex-embedded.tgz");
    expect(workflow).toContain("tar -xOzf artifacts/convex-embedded.tgz package/package.json");
    expect(workflow).not.toContain("pkg-pr-new");
    expect(workflow).toContain("Prerelease and release modes require a v* tag");
    expect(workflow).toContain("options: [verify, preview, prerelease, release]");
    expect(workflow).toContain("dist_tag=latest");
    expect(workflow).not.toContain("dist_tag=preview");
    expect(workflow).toContain("CONVEX_EMBEDDED_PUBLISH_VERSION");
    expect(workflow).toContain("@estifanos-sh/convex-embedded");
    expect(workflow).not.toContain("get-convex/embedded");
    expect(workflow).not.toContain("github.repository ==");
    expect(workflow).toContain("Refusing to publish unexpected package");
    expect(workflow).toContain("Verify packaged Linux Node durability");
    expect(workflow).toContain(
      "Verify production WASM OPFS conformance, worker death, stress, and memory ceilings",
    );
    expect(workflow).toContain("candidate_cold_and_warm_stress_preserves_every_row");
    expect(workflow).toContain("result_only_cursor_updates_batch_projection_dependencies");
    expect(workflow).toContain("cargo test -p storage --features testkit --test migration");
    expect(workflow).toContain("cargo test -p mobile");
    expect(workflow).toContain("vp test run packages/embedded/tests/unit/expo.ts");
    expect(workflow).not.toContain('tags: ["v*"]');
    expect(workflow).not.toContain('[[ "$EVENT" == "push" ]]');
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("labels.*.name, 'npm package'");
    expect(workflow).toContain('PACKAGE_PREVIEW" == "true"');
    expect(workflow).toContain('INPUT_MODE" == "prerelease"');
    expect(workflow).toContain(
      'npm dist-tag add "${{ steps.release.outputs.package }}@${{ steps.release.outputs.version }}" preview',
    );
    expect(workflow).toContain("blacksmith-8vcpu-ubuntu-2404-arm");
    expect(workflow).toContain("This job is deliberately credential-free");
    expect(workflow).toContain("Package releases must dispatch the reviewed workflow from main.");
    expect(workflow).toContain("Download exact JavaScript and WASM artifact");
    expect(workflow).not.toContain("Build production Node and WASM artifacts");
    expect(workflow).toMatch(
      /name: Checkout exact source[\s\S]*?fetch-depth: 0[\s\S]*?name: Verify Preview2 baseline/,
    );
    expect(workflow).toMatch(/name: Assemble[\s\S]*?name: Checkout[\s\S]*?fetch-depth: 0/);
    expect(workflow).toContain("name: Qualify");
    expect(workflow).toContain("Bind packed artifact digest");
    expect(workflow).toContain("tarball_sha256: ${{ steps.tarball.outputs.sha256 }}");
    expect(workflow).toContain(
      "ASSEMBLED_TARBALL_SHA256: ${{ needs.assemble.outputs.tarball_sha256 }}",
    );
    expect(workflow).toContain("Embedded package SHA-256: $ASSEMBLED_TARBALL_SHA256");
    expect(workflow).toContain(
      "EXPECTED_TARBALL_SHA256: ${{ needs.release-tag.outputs.tarball_sha256 }}",
    );
    expect(workflow).toContain("Downloaded package digest $ACTUAL_TARBALL_SHA256");
    expect(workflow).toContain("needs: [gate, qualification, javascript, node, apple, android]");
    expect(workflow).toContain("name: Tag");
    expect(workflow).toContain("Credentials are deliberately removed from this job");
    expect(workflow).not.toContain("git fetch --no-tags origin main");
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(workflow).toContain("ref: ${{ needs.gate.outputs.sha }}");
    expect(workflow).toContain("EXPECTED_SHA: ${{ needs.gate.outputs.sha }}");
    expect(workflow).toContain("ASSEMBLED_SHA: ${{ needs.assemble.outputs.sha }}");
    expect(workflow).toContain("needs: [gate, qualification, assemble, release-tag]");
    expect(workflow).toContain("RELEASE_TAG: ${{ needs.release-tag.outputs.tag }}");
    expect(workflow).not.toContain("Tag merged release and start the trusted build");
  });

  test("ordinary CI uses Blacksmith and no longer publishes an incomplete JavaScript-only preview", () => {
    const workflow = readFileSync(join(root, ".github/workflows/preview.yml"), "utf8");
    const native = readFileSync(join(root, ".github/workflows/release-native.yml"), "utf8");
    const rust = readFileSync(join(root, ".github/actions/rust/action.yml"), "utf8");

    expect(workflow).not.toContain("pkg-pr-new publish");
    expect(workflow).not.toContain("Publish preview");
    expect(workflow).not.toContain("large-runner");
    expect(workflow).toContain("blacksmith-8vcpu-ubuntu-2404");
    expect(workflow).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(workflow).toContain("blacksmith-6vcpu-macos-15");
    expect(native).not.toContain("large-runner");
    expect(native).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(native).toContain("blacksmith-6vcpu-macos-15");
    expect(rust).toContain("toolchain: nightly-2026-06-09");
    expect(rust).toContain("wasm32-wasip1-threads");
  });
});
