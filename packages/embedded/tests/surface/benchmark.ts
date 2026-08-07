import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("benchmark workflow", () => {
  test("exercises the release workload on Blacksmith without credentials", () => {
    const workflow = readFileSync(join(root, ".github/workflows/benchmark.yml"), "utf8");

    expect(workflow).toContain("name: Benchmark");
    expect(workflow).toContain("blacksmith-8vcpu-ubuntu-2404");
    expect(workflow).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(workflow).not.toContain("depot");
    expect(workflow).toContain("Build and exercise the runtime");
    expect(workflow).toContain("Build and compile all Android ABIs");
    expect(workflow).toContain("@estifanos-sh/convex-embedded#test:kill:node");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("contents: write");
  });
});
