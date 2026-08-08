import { v } from "convex/values";
import { expect, test } from "vite-plus/test";

import { generateEmbedded, renderEmbeddedGenerated } from "../../src/bundler";
import { toEmbeddedGeneratedSchema } from "../../src/bundler/generated";
import { createLocalFacade, localGraphHash, localReferenceName } from "../../src/local/internal";
import { analyzeEmbeddedSchema, defineEmbeddedSchema, replicatedTable } from "../../src/schema";
import { e } from "../../src/values";

test("generated contract exports schema-bound local builders without carrying the device schema", () => {
  const schema = defineEmbeddedSchema({
    documents: replicatedTable({
      expanded: e.local(v.boolean()),
      secret: e.remote(v.string()),
      title: v.string(),
    }),
  });
  const source = renderEmbeddedGenerated({
    artifact: {
      artifactHash: "artifact-hash",
      executionHash: "graph-hash",
      expectedBinding: { mobileAbi: 10, storageAbi: 33 },
      format: 1,
      modules: [],
      replicationHash: "manifest-hash",
      schemaHash: "schema-hash",
      setups: [],
    },
    embeddedSchema: toEmbeddedGeneratedSchema(analyzeEmbeddedSchema(schema)),
    generatedPath: "/repo/convex/_generated/embedded.ts",
    localModules: {
      "local/drafts": { file: "/repo/local/drafts.ts" },
    },
    localExports: { "local/drafts": [] },
    manifest: {
      documents: {
        list: { kind: "query", placement: "replicated", visibility: "public" },
      },
    },
    manifestHash: "manifest-hash",
    moduleGraphHash: "graph-hash",
    modules: { documents: "/repo/convex/documents.ts" },
    schemaPath: "/repo/convex/schema.ts",
    schemaSourceHash: "schema-source-hash",
    sourceFiles: ["/repo/convex/documents.ts"],
  });

  expect(source).toContain("embeddedGeneratedFormatVersion = 4");
  expect(source).toContain(
    'embeddedGeneratedIdentity = {"formatVersion":4,"manifestHash":"manifest-hash","schemaSourceHash":"schema-source-hash"}',
  );
  expect(source).toContain(
    'embeddedManifest = {"documents":{"list":{"kind":"query","placement":"replicated","visibility":"public"}}}',
  );
  expect(source).toContain(
    'import { defineLocal } from "@estifanos-sh/convex-embedded/internal/local";',
  );
  expect(source).toContain('import schema from "../schema.js";');
  expect(source).toContain("export const local = defineLocal(schema);");
  expect(source).not.toContain("Register");
  expect(source).not.toContain('"@estifanos-sh/convex-embedded/local"');
  expect(source).not.toContain("embeddedSchema");
  expect(source).not.toContain("runtimeStoreSchema");
  expect(source).not.toContain("localApi");
  expect(source).not.toContain("local/drafts");
  expect(source.length).toBeLessThan(2048);
});

test("generated local facades freeze an artifact-bound clone without changing the source export", () => {
  const source = {
    setup: {
      __embeddedPlacement: "local",
      handler: () => undefined,
      kind: "action",
      placement: "local",
      visibility: "internal",
    },
  };

  const facade = createLocalFacade("local/setup", "artifact", source);

  expect(facade.setup).not.toBe(source.setup);
  expect(Object.isFrozen(facade)).toBe(true);
  expect(Object.isFrozen(facade.setup)).toBe(true);
  expect(localReferenceName(facade.setup)).toBe("local/setup:setup");
  expect(localGraphHash(facade.setup)).toBe("artifact");
  expect(localReferenceName(source.setup)).toBeUndefined();
  expect(localGraphHash(source.setup)).toBeUndefined();
});

test("generator atomically creates the contract needed by bundler builds", async () => {
  const schema = defineEmbeddedSchema({
    documents: replicatedTable({ title: v.string() }),
  });
  const root = await mkdtemp(path.join(tmpdir(), "embedded-generate-"));
  try {
    const convex = path.join(root, "convex");
    await mkdir(convex, { recursive: true });
    await writeFile(path.join(convex, "schema.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(convex, "embedded.ts"), "export const pull = null;\n", "utf8");
    await writeFile(
      path.join(convex, "documents.ts"),
      'import { replicated } from "./embedded";\nexport const list = replicated.query({});\n',
      "utf8",
    );
    const result = await generateEmbedded({
      analysis: analyzeEmbeddedSchema(schema),
      root,
    });

    expect(result.path).toBe(path.join(convex, "_generated", "embedded.ts"));
    expect(result.bundle.embeddedSchema.runtimeStoreSchema.tables.length).toBeGreaterThan(0);
    await expect(readFile(result.path, "utf8")).resolves.toContain("embeddedManifest");
    expect(result.source).not.toContain("runtimeStoreSchema");
    expect(result.source).not.toContain("localApi");
    expect(result.source).not.toContain("makeFunctionReference");
    expect(result.source).not.toContain("type LocalReference");
    expect(result.source).toContain('from "@estifanos-sh/convex-embedded/internal/local"');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
