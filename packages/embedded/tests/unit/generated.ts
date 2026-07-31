import { v } from "convex/values";
import { expect, test } from "vite-plus/test";

import { generateEmbedded, renderEmbeddedGenerated } from "../../src/bundler";
import { toEmbeddedGeneratedSchema } from "../../src/bundler/generated";
import { analyzeEmbeddedSchema, defineEmbeddedSchema, replicatedTable } from "../../src/schema";
import { e } from "../../src/values";

test("generated contract locks placements without carrying the device schema", () => {
  const schema = defineEmbeddedSchema({
    documents: replicatedTable({
      expanded: e.local(v.boolean()),
      secret: e.remote(v.string()),
      title: v.string(),
    }),
  });
  const source = renderEmbeddedGenerated({
    embeddedSchema: toEmbeddedGeneratedSchema(analyzeEmbeddedSchema(schema)),
    generatedPath: "/repo/convex/embedded.generated.ts",
    localModules: {
      "local/drafts": { file: "/repo/local/drafts.ts" },
    },
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

  expect(source).toContain("embeddedGeneratedFormatVersion = 2");
  expect(source).toContain(
    'embeddedGeneratedIdentity = {"formatVersion":2,"manifestHash":"manifest-hash","schemaSourceHash":"schema-source-hash"}',
  );
  expect(source).toContain(
    'embeddedManifest = {"documents":{"list":{"kind":"query","placement":"replicated","visibility":"public"}}}',
  );
  expect(source).not.toContain("embeddedSchema");
  expect(source).not.toContain("runtimeStoreSchema");
  expect(source).not.toContain("localApi");
  expect(source).not.toContain("local/drafts");
  expect(source).not.toContain("import schema");
  expect(source.length).toBeLessThan(2048);
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

    expect(result.path).toBe(path.join(convex, "embedded.generated.ts"));
    expect(result.bundle.embeddedSchema.runtimeStoreSchema.tables.length).toBeGreaterThan(0);
    await expect(readFile(result.path, "utf8")).resolves.toContain("embeddedManifest");
    expect(result.source).not.toContain("runtimeStoreSchema");
    expect(result.source).not.toContain("localApi");
    expect(result.source).not.toContain("makeFunctionReference");
    expect(result.source).not.toContain("type LocalReference");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
