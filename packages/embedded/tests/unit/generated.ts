import { v } from "convex/values";
import { expect, test } from "vite-plus/test";

import { generateEmbedded, renderEmbeddedGenerated } from "../../src/bundler";
import { analyzeEmbeddedSchema, defineEmbeddedSchema, embeddedTable } from "../../src/schema";
import { e } from "../../src/values";

test("generated contract contains literal placement schema and typed local references", () => {
  const schema = defineEmbeddedSchema({
    documents: embeddedTable({
      expanded: e.local(v.boolean()),
      secret: e.omit(v.string()),
      title: v.string(),
    }),
  });
  const source = renderEmbeddedGenerated({
    analysis: analyzeEmbeddedSchema(schema),
    bundle: {
      generatedPath: "/repo/convex/_generated/embedded.ts",
      manifest: {
        "documents.local": {
          expanded: { kind: "query", placement: "local", visibility: "public" },
        },
        documents: {
          list: { kind: "query", placement: "replicated", visibility: "public" },
        },
      },
      manifestHash: "manifest-hash",
      modules: { documents: "/repo/convex/documents.ts" },
      schemaHash: "schema-hash",
      schemaPath: "/repo/convex/schema.ts",
      schemaSourceHash: "schema-source-hash",
      sourceFiles: ["/repo/convex/documents.ts"],
    },
  });

  expect(source).toContain("embeddedGeneratedFormatVersion = 1");
  expect(source).toContain('"expanded":{"type":"boolean"}');
  expect(source).toContain('makeFunctionReference<"query">("documents.local:expanded")');
  expect(source).toContain('LocalReference<typeof import("../documents.local")["expanded"]>');
  expect(source).not.toContain("import schema");
});

test("generator atomically creates the contract needed by bundler builds", async () => {
  const schema = defineEmbeddedSchema({
    documents: embeddedTable({ title: v.string() }),
  });
  const root = await mkdtemp(path.join(tmpdir(), "embedded-generate-"));
  try {
    const convex = path.join(root, "convex");
    await mkdir(convex, { recursive: true });
    await writeFile(path.join(convex, "schema.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(convex, "embedded.ts"), "export const pull = null;\n", "utf8");
    await writeFile(
      path.join(convex, "documents.ts"),
      "declare const embedded: any; export const list = embedded.replicated.query({});\n",
      "utf8",
    );
    const result = await generateEmbedded({
      analysis: analyzeEmbeddedSchema(schema),
      root,
    });

    expect(result.path).toBe(path.join(convex, "_generated/embedded.ts"));
    await expect(readFile(result.path, "utf8")).resolves.toContain("runtimeStoreSchema");
    expect(result.source).not.toContain("makeFunctionReference");
    expect(result.source).not.toContain("type LocalReference");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
