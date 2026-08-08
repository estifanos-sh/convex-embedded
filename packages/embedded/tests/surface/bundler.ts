import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { build } from "vite";
import { describe, expect, test } from "vite-plus/test";
import { v } from "convex/values";

import { createEmbeddedBundle, generateEmbedded, toModuleId } from "../../src/bundler";
import { toEmbeddedGeneratedSchema } from "../../src/bundler/generated";
import { maskCommentsAndStrings, readModuleEdges } from "../../src/bundler/scanner";
import { analyzeEmbeddedSchema, defineEmbeddedSchema, replicatedTable } from "../../src/schema";
import { convexEmbeddedUnplugin } from "../../src/unplugin";
import {
  fromVirtualFacadeId,
  fromVirtualSourceId,
  renderEmbeddedBundle,
  renderEmbeddedIdentity,
  toVirtualFacadeId,
  toVirtualSourceId,
  VIRTUAL_FACADE_MODULE_PREFIX,
  VIRTUAL_MODULE_ID,
  VIRTUAL_SOURCE_MODULE_PREFIX,
} from "../../src/bundler/virtual";
import { convexEmbedded } from "../../src/vite";

const convexServerPath = fileURLToPath(import.meta.resolve("convex/server"));
const convexValuesPath = fileURLToPath(import.meta.resolve("convex/values"));
const embeddedServerPath = fileURLToPath(new URL("../../src/server/index.ts", import.meta.url));
const fixtureSchema = defineEmbeddedSchema({});
const fixtureAnalysis = analyzeEmbeddedSchema(fixtureSchema);

interface BundlerPlugin {
  load: (id: string) => Promise<string | null> | string | null;
  resolveId: (id: string, importer?: string) => Promise<string | null> | string | null;
  transform: (code: string, id: string) => Promise<{ code: string } | null | undefined>;
}

describe("embedded bundler core", () => {
  test("masks lexical trivia without moving UTF-16 offsets", () => {
    const comment = "// export const ghost = /fake/;";
    const block = "/* export { missing }; */";
    const source = `\uFEFFconst emoji = "🚀";\r\n${comment}\r\n${block}\r\nexport const live = 6 / 2;\n`;
    const masked = maskCommentsAndStrings(source);

    expect(masked).toBe(
      `\uFEFFconst emoji =     ;\r\n${" ".repeat(comment.length)}\r\n${" ".repeat(
        block.length,
      )}\r\nexport const live = 6 / 2;\n`,
    );
    expect(masked.length).toBe(source.length);
    expect(masked.indexOf("export const live")).toBe(source.indexOf("export const live"));
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\r" || source[index] === "\n") {
        expect(masked[index]).toBe(source[index]);
      }
    }
  });

  test("masks strings, templates, and regex literals while retaining division", () => {
    const string = '"a \\"quoted\\" / fake"';
    const template = "`export const ghost = ${value}; /fake/`";
    const regex = "/a\\/b[\\/]/gi";
    const maskedTemplate = `${" ".repeat(template.indexOf("value"))}value${" ".repeat(
      template.length - template.indexOf("value") - "value".length,
    )}`;
    const source = `const string = ${string};
const template = ${template};
const regex = ${regex};
const division = numerator / 2 / divisor;
`;

    const masked = maskCommentsAndStrings(source);

    expect(masked).toBe(`const string = ${" ".repeat(string.length)};
const template = ${maskedTemplate};
const regex = ${" ".repeat(regex.length - 2)}gi;
const division = numerator / 2 / divisor;
`);
    expect(masked).toHaveLength(source.length);
    expect(masked.indexOf("value")).toBe(source.indexOf("value"));
  });

  test("reads only semantic module edges", () => {
    const decoys = `// import "./comment";
const string = 'import "./string";';
const template = \`import "./template";\`;
const regex = /import "\\.\\/regex"/;
`;

    expect(
      readModuleEdges(`${decoys}
import "./side-effect.js";
import type { Type } from "./types.js";
export { value } from "./named.js";
export type { Type } from "./exported-types.js";
export * from "./star.js";
import("./dynamic.js");
const template = \`text import("./template.js") \${import("./expression.js")}\`;
`),
    ).toEqual([
      { specifier: "./side-effect.js", typeOnly: false },
      { specifier: "./types.js", typeOnly: true },
      { specifier: "./named.js", typeOnly: false },
      { specifier: "./exported-types.js", typeOnly: true },
      { specifier: "./star.js", typeOnly: false },
      { specifier: "./dynamic.js", typeOnly: false },
      { specifier: "./expression.js", typeOnly: false },
    ]);
  });

  test("masks TSX text while retaining imports in JSX expression containers", () => {
    const source = `import { Static } from "./static-live.js";\r
const view = <section>\r
  It's documented at https://example.dev; don't import("./prose-decoy.js")\r
  import { Decoy } from "./static-decoy.js";\r
  import("./dynamic-decoy.js")\r
  {import("./expression-live.js")}\r
  <aside>{condition ? <strong>import("./nested-decoy.js")</strong> : import("./nested-live.js")}</aside>\r
  <Panel\r
    slot={<strong>import("./property-decoy.js")</strong>}\r
    fragment={<>Don't import("./fragment-decoy.js"){import("./property-live.js")}</>}\r
  />\r
</section>;\r
void Static;\r
`;
    const masked = maskCommentsAndStrings(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.indexOf("import(", source.indexOf('import("./expression-live.js")'))).toBe(
      source.indexOf('import("./expression-live.js")'),
    );
    expect(masked.indexOf("import(", source.indexOf('import("./nested-live.js")'))).toBe(
      source.indexOf('import("./nested-live.js")'),
    );
    expect(masked).not.toContain("static-decoy");
    expect(masked).not.toContain("dynamic-decoy");
    expect(masked).not.toContain("nested-decoy");
    expect(masked).not.toContain("prose-decoy");
    expect(masked).not.toContain("property-decoy");
    expect(masked).not.toContain("fragment-decoy");
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\r" || source[index] === "\n") {
        expect(masked[index]).toBe(source[index]);
      }
    }
    expect(readModuleEdges(source)).toEqual([
      { specifier: "./static-live.js", typeOnly: false },
      { specifier: "./expression-live.js", typeOnly: false },
      { specifier: "./nested-live.js", typeOnly: false },
      { specifier: "./property-live.js", typeOnly: false },
    ]);
  });

  test("keeps TypeScript operators and nested JSX lexical contexts distinct", () => {
    const source = `
const generic = <T extends object>(value: T) => import("./generic-live.js");
const comparison = left < right > import("./comparison-live.js");
const unary = void <span>import("./unary-decoy.js")</span>;
const quotient = value / <span>import("./operator-decoy.js")</span>;
const nested = <section>{
  /import\\(".\\/regex-decoy.js"\\)/.test("value")
    ? \`import("./template-decoy.js") \${import("./template-live.js")}\`
    : null
}{/* import("./comment-decoy.js") */}</section>;
void generic;
void comparison;
void unary;
void quotient;
void nested;
`;

    expect(readModuleEdges(source)).toEqual([
      { specifier: "./generic-live.js", typeOnly: false },
      { specifier: "./comparison-live.js", typeOnly: false },
      { specifier: "./template-live.js", typeOnly: false },
    ]);
  });

  test("discovers Convex modules and renders a lazy virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await file(
        convexDir,
        "admin/users.tsx",
        canonical("replicated", "query", "list", "../embedded"),
      );
      await file(convexDir, "_generated/api.ts", "export const api = {};\n");
      await file(convexDir, "ignored.d.ts", "export {};\n");

      const bundle = await createFixtureBundle(root);

      expect(bundle.schemaPath).toBe(path.join(convexDir, "schema.ts"));
      expect(bundle.modules).toEqual({
        "admin/users": path.join(convexDir, "admin/users.tsx"),
        messages: path.join(convexDir, "messages.ts"),
      });
      expect(bundle.manifest.messages?.list).toEqual({
        kind: "query",
        placement: "replicated",
        visibility: "public",
      });
      expect(JSON.stringify(bundle.modules)).not.toContain("_generated");
      expect(JSON.stringify(bundle)).not.toContain("ignored.d.ts");
    });
  });

  test("normalizes module ids relative to the Convex directory", () => {
    expect(toModuleId("/repo/convex", "/repo/convex/admin/users.ts")).toBe("admin/users");
  });

  test("binds the artifact hash to logical module ids as well as bytes", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = canonical("replicated", "query", "list");
      await file(convexDir, "first.ts", source);
      const first = await createFixtureBundle(root);

      await rm(path.join(convexDir, "first.ts"));
      await file(convexDir, "renamed.ts", source);
      const renamed = await createFixtureBundle(root);

      expect(renamed.moduleGraphHash).not.toBe(first.moduleGraphHash);
      expect(renamed.artifact.artifactHash).not.toBe(first.artifact.artifactHash);
      expect(renamed.artifact.modules.map((module) => module.id)).toContain(
        "app/convex/renamed.ts",
      );
    });
  });

  test("describes setup candidates from local action semantics and their source closures", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "helper.ts", 'export const phase = "one";\n');
      await file(
        localDir,
        "lifecycle.ts",
        `import { local } from "../convex/_generated/embedded";
import { phase } from "./helper";
export const namedSetup = local.internalMutation({ handler: () => phase });
export const openDevice = local.internalAction({ handler: () => null });
export const carryHistory = local.internalAction({ handler: () => null });
`,
      );
      await file(localDir, "entry.ts", 'export { openDevice as open } from "./lifecycle";\n');

      const first = await createFixtureBundle(root, localDir);
      expect(first.artifact.expectedBinding).toEqual({ mobileAbi: 10, storageAbi: 33 });
      expect(first.artifact.setups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "carryHistory",
            reference: "local/lifecycle:carryHistory",
          }),
          expect.objectContaining({
            name: "openDevice",
            reference: "local/lifecycle:openDevice",
          }),
          expect.objectContaining({
            name: "open",
            reference: "local/entry:open",
          }),
        ]),
      );
      expect(first.artifact.setups.map((setup) => setup.name)).not.toContain("namedSetup");
      const original = first.artifact.setups.find(
        (setup) => setup.reference === "local/lifecycle:openDevice",
      );
      expect(original?.closureHash).toMatch(/^[a-f0-9]{16}$/);

      await file(localDir, "helper.ts", 'export const phase = "two";\n');
      const second = await createFixtureBundle(root, localDir);
      const changed = second.artifact.setups.find(
        (setup) => setup.reference === "local/lifecycle:openDevice",
      );
      expect(changed?.closureHash).not.toBe(original?.closureHash);
    });
  });

  const moduleSegment = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);
  const moduleExtension = fc.constantFrom(
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  );

  test("recovers any module id from its file path, at any depth or extension", () => {
    fc.assert(
      fc.property(
        fc.array(moduleSegment, { minLength: 1, maxLength: 3 }),
        fc.array(moduleSegment, { minLength: 1, maxLength: 5 }),
        moduleExtension,
        (dirSegments, idSegments, extension) => {
          const convexDir = path.join(path.sep, ...dirSegments);
          const filePath = `${path.join(convexDir, ...idSegments)}${extension}`;
          expect(toModuleId(convexDir, filePath)).toBe(idSegments.join("/"));
        },
      ),
    );
  });

  test("strips only the final extension, preserving dotted module names", () => {
    fc.assert(
      fc.property(moduleSegment, moduleExtension, (name, extension) => {
        const convexDir = path.join(path.sep, "repo", "convex");
        const filePath = path.join(convexDir, `${name}.config${extension}`);
        expect(toModuleId(convexDir, filePath)).toBe(`${name}.config`);
      }),
    );
  });

  test("throws when files collide on the same Convex module id", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await file(convexDir, "messages.tsx", canonical("replicated", "query", "other"));

      await expect(createFixtureBundle(root)).rejects.toThrow(
        'Duplicate Convex module id "messages"',
      );
    });
  });

  test("throws a clear error when the schema file is missing", async () => {
    await withFixture(async ({ root }) => {
      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "Could not find Convex schema",
      );
    });
  });

  test("throws a clear error when the embedded entrypoint is missing", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");

      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "Could not find Convex embedded entrypoint",
      );
    });
  });

  test("fails closed when the generated contract is missing", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", "export const pull = null;\n");

      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "Could not find generated Embedded contract",
      );
    });
  });

  test("bootstraps a custom generated contract imported by device functions", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(
        convexDir,
        "embedded.ts",
        `import { embeddedManifest } from "./generated/embedded";
void embeddedManifest;
export const replicated = null;
`,
      );
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      const generatedPath = "generated/embedded.ts";

      const generated = await generateEmbedded({
        analysis: fixtureAnalysis,
        generatedPath,
        root,
      });
      const bundle = await createEmbeddedBundle({ analysis: fixtureAnalysis, generatedPath, root });

      expect(generated.path).toBe(path.join(convexDir, generatedPath));
      expect(bundle.modules).toEqual({ messages: path.join(convexDir, "messages.ts") });
      expect(bundle.sourceFiles).toContain(path.join(convexDir, "embedded.ts"));
      expect(bundle.sourceFiles).not.toContain(generated.path);
    });
  });

  test("does not rewrite an unchanged generated contract", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const input = { analysis: fixtureAnalysis, root };

      const generated = await generateEmbedded(input);
      const before = await stat(generated.path, { bigint: true });
      await generateEmbedded(input);
      const after = await stat(generated.path, { bigint: true });

      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
    });
  });

  test("rejects generated contracts stale for schema source or function manifest", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await createFixtureBundle(root);

      await file(convexDir, "schema.ts", "export default { changed: true };\n");
      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "stale for the current schema",
      );

      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "messages.ts", canonical("remote", "query", "list"));
      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "stale for the current function manifest",
      );
    });
  });

  test("rejects generated contracts with unsupported format versions", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await createFixtureBundle(root);
      const generatedPath = path.join(convexDir, "_generated", "embedded.ts");
      const generated = await readFile(generatedPath, "utf8");
      await writeFile(
        generatedPath,
        generated.replace('"formatVersion":4', '"formatVersion":999'),
        "utf8",
      );

      await expect(createEmbeddedBundle({ analysis: fixtureAnalysis, root })).rejects.toThrow(
        "format 999 is unsupported",
      );
    });
  });

  test("ignores declaration files for all TypeScript module extensions", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "helpers.d.mts", "export {};\n");
      await file(convexDir, "helpers.d.cts", "export {};\n");

      await expect(createFixtureBundle(root)).resolves.toMatchObject({
        modules: {},
      });
    });
  });

  test("excludes Convex system and transport entrypoints from local modules", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "convex.config.ts", "export default {};\n");
      await file(convexDir, "auth.config.ts", "export default {};\n");
      await file(convexDir, "crons.ts", "export default {};\n");
      await file(convexDir, "http.ts", "export default {};\n");
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({
        messages: path.join(convexDir, "messages.ts"),
      });
    });
  });

  test("excludes Node-runtime modules from the device worker graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "hosted.ts",
        `/* hosted only */\n"use strict";\n"use node";\nexport const run = null;\n`,
      );
      await file(convexDir, "device.ts", canonical("replicated", "query", "read"));

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({
        device: path.join(convexDir, "device.ts"),
      });
    });
  });

  test("rejects Convex modules that register with the removed local builders", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "device.ts",
        "declare const embedded: any;\nexport const read = embedded.local.query({});\n",
      );

      await expect(createFixtureBundle(root)).rejects.toThrow(
        "embedded.local builders were removed",
      );
    });
  });

  test("rejects Convex modules that import the device-only entrypoint", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "device.ts",
        `import { local } from "@estifanos-sh/convex-embedded/local";\nvoid local;\n`,
      );

      await expect(createFixtureBundle(root)).rejects.toThrow(
        "must not import @estifanos-sh/convex-embedded/local",
      );
    });
  });

  test("does not preflight static or dynamic imports written as TSX text", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.tsx",
        `const preview = <section>
  import { local } from "@estifanos-sh/convex-embedded/local";
  import("@estifanos-sh/convex-embedded/local")
</section>;
void preview;
${canonical("replicated", "query", "list")}`,
      );

      await expect(createFixtureBundle(root)).resolves.toMatchObject({
        modules: { feed: path.join(convexDir, "feed.tsx") },
      });
    });
  });

  test.each([
    ["comments", '// import "@estifanos-sh/convex-embedded/local";'],
    ["strings", "const decoy = 'import \"@estifanos-sh/convex-embedded/local\";';"],
    ["templates", 'const decoy = `import "@estifanos-sh/convex-embedded/local";`;'],
    ["regex literals", 'const decoy = /import "@estifanos-sh\\/convex-embedded\\/local"/;'],
  ])("does not preflight %s as device-only imports", async (_kind, decoy) => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "feed.ts", `${decoy}\n${canonical("replicated", "query", "list")}`);

      await expect(createFixtureBundle(root)).resolves.toMatchObject({
        modules: { feed: path.join(convexDir, "feed.ts") },
      });
    });
  });

  test("rejects multi-dot Convex modules that the Convex CLI would skip", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "device.helpers.ts", canonical("replicated", "query", "read"));

      await expect(createFixtureBundle(root)).rejects.toThrow("contains multiple dots");
    });
  });

  test("keeps multi-dot Convex modules without registrations in the graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `import { value } from "./feed.helpers";\nvoid value;\n${canonical(
          "replicated",
          "query",
          "list",
        )}`,
      );
      await file(convexDir, "feed.helpers.ts", "export const value = 1;\n");

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({ feed: path.join(convexDir, "feed.ts") });
      expect(bundle.sourceFiles).toContain(path.join(convexDir, "feed.helpers.ts"));
    });
  });

  test("keeps remote registrations in the manifest but out of the device graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "feed.ts", canonical("replicated", "query", "list"));
      await file(convexDir, "admin.ts", canonical("remote", "mutation", "remove"));

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({ feed: path.join(convexDir, "feed.ts") });
      expect(bundle.manifest.admin?.remove).toMatchObject({
        kind: "mutation",
        placement: "remote",
      });
      expect(JSON.stringify(bundle.modules)).not.toContain("admin.ts");
    });
  });

  test("rejects device dependency paths that reach remote modules", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `import "./admin";\n${canonical("replicated", "query", "list")}`,
      );
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));

      await expect(createFixtureBundle(root)).rejects.toThrow("imports a remote module");
    });
  });

  test.each([
    ["comments", '// import "./admin";'],
    ["strings", "const decoy = 'import \"./admin\";';"],
    ["templates", 'const decoy = `import "./admin";`;'],
    ["regex literals", 'const decoy = /import "\\.\\/admin"/;'],
  ])("does not follow %s as device dependencies", async (_kind, decoy) => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "feed.ts", `${decoy}\n${canonical("replicated", "query", "list")}`);
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({ feed: path.join(convexDir, "feed.ts") });
      expect(bundle.sourceFiles).not.toContain(path.join(convexDir, "admin.ts"));
    });
  });

  test("does not follow NodeNext imports written as TSX text", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.tsx",
        `const preview = <section>
  import "./admin.js";
  import("./admin.js")
</section>;
void preview;
${canonical("replicated", "query", "list")}`,
      );
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({ feed: path.join(convexDir, "feed.tsx") });
      expect(bundle.sourceFiles).not.toContain(path.join(convexDir, "admin.ts"));
    });
  });

  test.each([
    ["static imports", 'import { helper } from "./helper.js";\nvoid helper;'],
    ["named re-exports", 'export { helper } from "./helper.js";'],
    ["dynamic imports", 'void import("./helper.js");'],
    ["template-expression dynamic imports", 'const value = `${import("./helper.js")}`;'],
    ["dynamic imports with trailing comments", 'void import("./helper.js" /* helper */);'],
    ["dynamic imports with options", 'void import("./helper.js", { with: { type: "json" } });'],
  ])("follows live %s with NodeNext specifiers", async (_kind, edge) => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "feed.ts", `${edge}\n${canonical("replicated", "query", "list")}`);
      await file(convexDir, "helper.ts", "export const helper = 1;\n");

      const bundle = await createFixtureBundle(root);

      expect(bundle.sourceFiles).toContain(path.join(convexDir, "helper.ts"));
    });
  });

  test("follows live dynamic NodeNext imports in TSX expression containers", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.tsx",
        `const preview = <section>{import("./helper.js")}</section>;
void preview;
${canonical("replicated", "query", "list")}`,
      );
      await file(convexDir, "helper.ts", "export const helper = 1;\n");

      const bundle = await createFixtureBundle(root);

      expect(bundle.sourceFiles).toContain(path.join(convexDir, "helper.ts"));
    });
  });

  test("keeps type-only preflight and device graph behavior distinct", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `import type { Helper } from "../local/helper.js";\n${canonical(
          "replicated",
          "query",
          "list",
        )}`,
      );
      await file(localDir, "helper.ts", "export type Helper = string;\n");

      const bundle = await createFixtureBundle(root, localDir);

      expect(bundle.sourceFiles).toContain(path.join(localDir, "helper.ts"));
    });
  });

  test("rejects explicit-extension imports that reach remote modules", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `import "./admin.ts";\n${canonical("replicated", "query", "list")}`,
      );
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));

      await expect(createFixtureBundle(root)).rejects.toThrow("imports a remote module");
    });
  });

  test("rejects path aliases that reach remote or Node-only modules", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        root,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@convex/*": ["convex/*"] } },
        }),
      );
      await file(
        convexDir,
        "feed.ts",
        `import "@convex/admin";\n${canonical("replicated", "query", "list")}`,
      );
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));

      await expect(createFixtureBundle(root)).rejects.toThrow("imports a remote module");

      await file(convexDir, "admin.ts", `"use node";\nexport const audit = null;\n`);
      await expect(createFixtureBundle(root)).rejects.toThrow("imports a Node-only module");
    });
  });

  test("hashes all transitive project helpers in the module graph identity", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `import { value } from "./helper.ts";\nvoid value;\n${canonical(
          "replicated",
          "query",
          "list",
        )}`,
      );
      await file(convexDir, "helper.ts", "export const value = 1;\n");

      const beforeBundle = await createFixtureBundle(root);
      const before = renderEmbeddedIdentity(beforeBundle);
      expect(beforeBundle.sourceFiles).toContain(path.join(convexDir, "helper.ts"));

      await file(convexDir, "helper.ts", "export const value = 2;\n");
      const afterBundle = await createFixtureBundle(root);
      const after = renderEmbeddedIdentity(afterBundle);

      expect(after).not.toBe(before);
    });
  });

  test("rejects non-canonical embedded registrations", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "legacy.ts",
        "declare const embedded: any; export const list = embedded.query({});\n",
      );

      await expect(createFixtureBundle(root)).rejects.toThrow("must use a canonical replicated");
    });
  });

  test("rejects the namespaced embedded.<placement>.<builder> registration form", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "legacy.ts",
        `import { embedded } from "./embedded";
export const list = embedded.replicated.query({});
`,
      );

      await expect(createFixtureBundle(root)).rejects.toThrow("must use a canonical replicated");
    });
  });

  test("rejects bare-namespace registrations that never import the embedded module", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "loose.ts",
        "declare const replicated: any;\nexport const list = replicated.query({});\n",
      );

      await expect(createFixtureBundle(root)).rejects.toThrow(
        "imported from the Convex embedded module",
      );
    });
  });

  test("rejects typed or parenthesized registrations that evade the canonical form", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "typed.ts",
        `import { replicated } from "./embedded";
export const list: unknown = replicated.query({});
`,
      );

      await expect(createFixtureBundle(root)).rejects.toThrow("must use a canonical replicated");

      await file(
        convexDir,
        "typed.ts",
        `import { replicated } from "./embedded";
export const list = (replicated.query)({});
`,
      );
      await expect(createFixtureBundle(root)).rejects.toThrow("must use a canonical replicated");

      await file(
        convexDir,
        "typed.ts",
        `import { replicated } from "./embedded";
const deviceQuery = replicated.query;
export const list = deviceQuery({});
`,
      );
      await expect(createFixtureBundle(root)).rejects.toThrow("directly from its exported");
    });
  });

  test("keeps registrations that follow a regex literal containing quotes", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "pins.ts",
        `import { replicated } from "./embedded";
const quoted = /["']/g;
void quoted;
export const toggle = replicated.mutation({});
`,
      );

      const bundle = await createFixtureBundle(root);

      expect(bundle.manifest.pins?.toggle).toEqual({
        kind: "mutation",
        placement: "replicated",
        visibility: "public",
      });
      expect(bundle.modules).toEqual({ pins: path.join(convexDir, "pins.ts") });
    });
  });

  test("requires a live placement import, and accepts NodeNext specifiers", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "feed.ts",
        `// import { replicated } from "./embedded";
export const list = replicated.query({});
`,
      );

      await expect(createFixtureBundle(root)).rejects.toThrow(
        "imported from the Convex embedded module",
      );

      await file(
        convexDir,
        "feed.ts",
        `import { replicated } from "./embedded.js";
export const list = replicated.query({});
`,
      );
      const bundle = await createFixtureBundle(root);

      expect(bundle.manifest.feed?.list).toMatchObject({ kind: "query", placement: "replicated" });
    });
  });

  test("rejects only the embedded.local builder namespace", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "settings.ts",
        `import { replicated } from "./embedded";
declare const cache: { local: { query: (key: string) => unknown } };
export const list = replicated.query({});
void cache.local.query("recent");
`,
      );

      const bundle = await createFixtureBundle(root);

      expect(bundle.manifest.settings?.list).toBeDefined();
    });
  });

  test("enforces canonical registrations only inside the Convex directory", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const helper = `export const remote = { query: async () => [] };
export const readRows = async () => remote.query();
`;
      await file(root, "src/helpers.ts", helper);
      await file(
        localDir,
        "drafts.ts",
        `import { readRows } from "../src/helpers";\nvoid readRows;\n`,
      );

      await expect(createFixtureBundle(root, localDir)).resolves.toMatchObject({
        localModules: { "local/drafts": { file: path.join(localDir, "drafts.ts") } },
      });

      await file(convexDir, "helpers.ts", helper);
      await expect(createFixtureBundle(root, localDir)).rejects.toThrow(
        "directly from its exported canonical registration",
      );
    });
  });

  test("does not discover package component sources for the local runtime", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "convex.config.ts",
        `import { defineApp } from "convex/server";
import parent from "test-component/convex.config";
const app = defineApp();
app.use(parent, { name: "parent" });
export default app;
`,
      );
      await file(
        root,
        "node_modules/test-component/package.json",
        JSON.stringify({
          exports: {
            "./convex.config": {
              "@convex-dev/component-source": "./src/component/convex.config.ts",
              import: "./dist/component/convex.config.js",
            },
          },
          name: "test-component",
          type: "module",
        }),
      );
      await file(
        root,
        "node_modules/test-component/src/component/convex.config.ts",
        `import { defineComponent } from "convex/server";
import child from "child-component/convex.config";
const component = defineComponent("defaultParent");
component.use(child, { name: "child" });
export default component;
`,
      );
      await file(
        root,
        "node_modules/test-component/src/component/schema.ts",
        "export default {};\n",
      );
      await file(
        root,
        "node_modules/test-component/src/component/public.ts",
        "export const ping = null;\n",
      );
      await file(
        root,
        "node_modules/child-component/package.json",
        JSON.stringify({
          exports: {
            "./convex.config": {
              "@convex-dev/component-source": "./src/component/convex.config.ts",
              import: "./dist/component/convex.config.js",
            },
          },
          name: "child-component",
          type: "module",
        }),
      );
      await file(
        root,
        "node_modules/child-component/src/component/convex.config.ts",
        `import { defineComponent } from "convex/server";
export default defineComponent("defaultChild");
`,
      );
      await file(
        root,
        "node_modules/child-component/src/component/schema.ts",
        "export default {};\n",
      );
      await file(
        root,
        "node_modules/child-component/src/component/public.ts",
        "export const pong = null;\n",
      );

      const bundle = await createFixtureBundle(root);

      expect(bundle.modules).toEqual({});
      expect(JSON.stringify(bundle)).not.toContain("test-component");
      expect(JSON.stringify(bundle)).not.toContain("child-component");
    });
  });

  test("renders quoted keys for module ids that are not identifiers", () => {
    const source = renderEmbeddedBundle({
      artifact: {
        artifactHash: "artifact",
        executionHash: "graph",
        expectedBinding: { mobileAbi: 10, storageAbi: 33 },
        format: 1,
        modules: [],
        replicationHash: "manifest",
        schemaHash: "schema",
        setups: [],
      },
      embeddedSchema: toEmbeddedGeneratedSchema(fixtureAnalysis),
      generatedPath: "/repo/convex/_generated/embedded.ts",
      localModules: {
        "local/admin/drafts": { file: "/repo/local/admin/drafts.ts" },
      },
      localExports: { "local/admin/drafts": [] },
      manifest: {
        "admin/users": {
          list: { kind: "query", placement: "replicated", visibility: "public" },
        },
      },
      modules: { "admin/users": "/repo/convex/admin/users.ts" },
      sourceFiles: ["/repo/convex/admin/users.ts"],
      schemaPath: "/repo/convex/schema.ts",
      schemaSourceHash: "schema",
      manifestHash: "manifest",
      moduleGraphHash: "graph",
    });

    expect(source).toContain('"admin/users": () => import(');
    expect(source).toContain('"local/admin/drafts": () => import(');
  });
});

describe("embedded local modules", () => {
  test("discovers every device-only module under a root, including shared helpers", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await file(localDir, "sync/drafts.ts", localFunctions(2));
      await file(localDir, "shapes.ts", localExportShapes());
      await file(localDir, "_helpers.ts", "export const limit = 10;\n");
      await file(localDir, "ignored.d.ts", "export {};\n");

      const bundle = await createFixtureBundle(root, localDir);

      expect(bundle.localModules).toEqual({
        "local/_helpers": { file: path.join(localDir, "_helpers.ts") },
        "local/shapes": { file: path.join(localDir, "shapes.ts") },
        "local/sync/drafts": { file: path.join(localDir, "sync/drafts.ts") },
      });
      expect(bundle.manifest.messages?.list).toBeDefined();
      expect(JSON.stringify(bundle.manifest)).not.toContain("local/");
      expect(bundle.sourceFiles).toContain(path.join(localDir, "sync/drafts.ts"));
      expect(JSON.stringify(bundle)).not.toContain("ignored.d.ts");
    });
  });

  test("namespaces module ids per root when several roots are configured", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      const deviceDir = path.join(root, "device");
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "sync/drafts.ts", localFunctions(2));
      await file(deviceDir, "prefs.ts", localFunctions());

      const bundle = await createFixtureBundle(root, [localDir, deviceDir]);

      expect(bundle.localModules).toEqual({
        "local/prefs": { file: path.join(deviceDir, "prefs.ts") },
        "local/sync/drafts": { file: path.join(localDir, "sync/drafts.ts") },
      });
      expect(bundle.sourceFiles).toContain(path.join(deviceDir, "prefs.ts"));
    });
  });

  test("rejects a device-only module id claimed by two roots, naming both files", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      const deviceDir = path.join(root, "device");
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "prefs.ts", localFunctions());
      await file(deviceDir, "prefs.ts", localFunctions());

      await expect(createFixtureBundle(root, [localDir, deviceDir])).rejects.toThrow(
        `Duplicate local module id "local/prefs" from "${path.join(
          localDir,
          "prefs.ts",
        )}" and "${path.join(deviceDir, "prefs.ts")}".`,
      );
    });
  });

  test("keeps the local/ function namespace reserved inside the Convex directory", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "local/pins.ts",
        canonical("replicated", "query", "list", "../embedded"),
      );

      await expect(createFixtureBundle(root)).rejects.toThrow(
        "uses the reserved local/ function namespace",
      );
    });
  });

  test("watches every configured local root while loading the registry", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      const deviceDir = path.join(root, "device");
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "sync/drafts.ts", localFunctions(2));
      await file(deviceDir, "prefs.ts", localFunctions());
      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: [localDir, deviceDir],
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;
      const load = plugin.load as unknown as (
        this: { addWatchFile(id: string): void },
        id: string,
      ) => Promise<string | null>;
      const watched: string[] = [];

      await load.call({ addWatchFile: (id: string) => watched.push(id) }, `\0${VIRTUAL_MODULE_ID}`);

      expect(watched).toContain(convexDir);
      expect(watched).toContain(localDir);
      expect(watched).toContain(deviceDir);
      expect(watched).toContain(path.join(deviceDir, "prefs.ts"));
    });
  });

  test("renders lazy device-only thunks beside the Convex registry", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await file(localDir, "sync/drafts.ts", localFunctions(2));

      const source = renderEmbeddedBundle(await createFixtureBundle(root, localDir));

      expect(source).toContain(`messages: () => import("${VIRTUAL_SOURCE_MODULE_PREFIX}`);
      expect(source).toContain(
        `  "local/sync/drafts": () => import(${JSON.stringify(
          toVirtualSourceId(path.join(localDir, "sync/drafts.ts")),
        )}),`,
      );
    });
  });

  test("renders an empty local registry when no directory is configured", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);

      const bundle = await createFixtureBundle(root);

      expect(bundle.localModules).toEqual({});
      expect(renderEmbeddedBundle(bundle)).toContain("export const localModules = {");
    });
  });

  test("rejects star re-exports that cannot preserve immutable local references", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "helpers.ts", "export const helper = 1;\n");
      await file(
        localDir,
        "drafts.ts",
        `export * from "./helpers";
export default { setCompact: null };
const pref = 1;
export { pref as "compact pref" };
`,
      );

      await expect(createFixtureBundle(root, localDir)).rejects.toThrow(
        "generated local facades require named re-exports",
      );
    });
  });

  test("rejects device-only roots that overlap the Convex directory or each other", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);

      await expect(createFixtureBundle(root, path.join(convexDir, "local"))).rejects.toThrow(
        "must live outside the Convex directory",
      );
      await expect(createFixtureBundle(root, root)).rejects.toThrow(
        "must live outside the Convex directory",
      );
      await expect(
        createFixtureBundle(root, [localDir, path.join(localDir, "sync")]),
      ).rejects.toThrow("must not overlap");
      await expect(createFixtureBundle(root, [localDir, localDir])).rejects.toThrow(
        "must not overlap",
      );
    });
  });

  test("rejects device-only modules that reach remote or Node-only modules", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "admin.ts", canonical("remote", "query", "audit"));
      await file(localDir, "drafts.ts", `import "../convex/admin";\nexport const limit = 1;\n`);

      await expect(createFixtureBundle(root, localDir)).rejects.toThrow("imports a remote module");

      await file(convexDir, "admin.ts", `"use node";\nexport const audit = null;\n`);
      await expect(createFixtureBundle(root, localDir)).rejects.toThrow(
        "imports a Node-only module",
      );
    });
  });

  test("hashes device-only sources in the module graph identity", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "drafts.ts", `import { limit } from "./helpers";\nvoid limit;\n`);
      await file(localDir, "helpers.ts", "export const limit = 10;\n");

      const before = renderEmbeddedIdentity(await createFixtureBundle(root, localDir));

      await file(localDir, "helpers.ts", "export const limit = 20;\n");
      const after = renderEmbeddedIdentity(await createFixtureBundle(root, localDir));

      expect(after).not.toBe(before);
    });
  });
});

describe("embedded unplugin adapter", () => {
  const sourcePath = fc.stringMatching(/^\/[a-z0-9/._-]{0,40}$/);

  test("round-trips any source path through the virtual-source-id codec", () => {
    fc.assert(
      fc.property(sourcePath, (filePath) => {
        expect(fromVirtualSourceId(toVirtualSourceId(filePath))).toBe(path.resolve(filePath));
      }),
    );
  });

  test("decodes only ids carrying the virtual-source prefix", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        fc.pre(!id.startsWith(VIRTUAL_SOURCE_MODULE_PREFIX));
        expect(fromVirtualSourceId(id)).toBeUndefined();
      }),
    );
  });

  test("round-trips facade paths through the virtual facade codec", () => {
    fc.assert(
      fc.property(sourcePath, (filePath) => {
        expect(fromVirtualFacadeId(toVirtualFacadeId(filePath))).toBe(path.resolve(filePath));
      }),
    );
  });

  test("rejects wrong-prefix and malformed facade ids", () => {
    expect(fromVirtualFacadeId(toVirtualSourceId("/fixture/source.ts"))).toBeUndefined();
    expect(fromVirtualFacadeId(VIRTUAL_FACADE_MODULE_PREFIX)).toBeUndefined();
    expect(fromVirtualFacadeId(`${VIRTUAL_FACADE_MODULE_PREFIX}@@@`)).toBeUndefined();
  });

  test("rejects source and facade ids with inserted or appended invalid payload characters", () => {
    const source = toVirtualSourceId("/fixture/source.ts");
    const facade = toVirtualFacadeId("/fixture/facade.ts");

    expect(fromVirtualSourceId(`${source.slice(0, -1)}!${source.slice(-1)}`)).toBeUndefined();
    expect(fromVirtualSourceId(`${source}!`)).toBeUndefined();
    expect(fromVirtualFacadeId(`${facade.slice(0, -1)}!${facade.slice(-1)}`)).toBeUndefined();
    expect(fromVirtualFacadeId(`${facade}!`)).toBeUndefined();
  });

  test("resolves and loads the virtual embedded registry", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const resolved = await plugin.resolveId(VIRTUAL_MODULE_ID);
      expect(resolved).toBe(`\0${VIRTUAL_MODULE_ID}`);
      const source = await plugin.load(resolved!);
      expect(source).toContain("export const embeddedSchema = ");
      expect(source).toContain(`messages: () => import("${VIRTUAL_SOURCE_MODULE_PREFIX}`);
      expect(source).not.toContain("import.meta.glob");
      expect(source).not.toContain("/@fs/");
      expect(source).not.toContain("file://");
    });
  });

  test("inlines the fresh device schema and writes only the placement lockfile", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", "export const replicated = null;\n");
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      const schema = defineEmbeddedSchema({ messages: replicatedTable({ body: v.string() }) });
      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        schema,
      }) as unknown as BundlerPlugin;

      const resolved = await plugin.resolveId(VIRTUAL_MODULE_ID);
      const source = await plugin.load(resolved!);

      expect(source).toContain("export const embeddedSchema = ");
      expect(source).toContain("runtimeStoreSchema");
      expect(source).not.toMatch(/^import\s/m);
      const lockfile = await readFile(path.join(convexDir, "_generated", "embedded.ts"), "utf8");
      expect(lockfile).toContain("embeddedManifest");
      expect(lockfile).not.toContain("runtimeStoreSchema");
      expect(lockfile).not.toContain("embeddedSchema");
      expect(lockfile.length).toBeLessThan(1024);
    });
  });

  test("resolves virtual source ids to real Convex files", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      const modulePath = path.join(convexDir, "messages.ts");
      const sourceId = toVirtualSourceId(modulePath);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect(fromVirtualSourceId(sourceId)).toBe(modulePath);
      expect(await plugin.resolveId(sourceId)).toBe(modulePath);
    });
  });

  test("rejects virtual source ids outside discovered Convex files", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));
      await file(root, "secret.ts", "export const secret = true;\n");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect(await plugin.resolveId(toVirtualSourceId(path.join(root, "secret.ts")))).toBe(null);
    });
  });

  test("keeps Vite dev import-analysis directory probes pinned to schema", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "drafts.ts", localFunctions());

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect(await plugin.resolveId(convexDir, `\0${VIRTUAL_MODULE_ID}`)).toBe(
        path.join(convexDir, "schema.ts"),
      );
      expect(await plugin.resolveId(localDir, `\0${VIRTUAL_MODULE_ID}`)).toBe(
        path.join(convexDir, "schema.ts"),
      );
    });
  });

  test("ignores unrelated load ids without scanning for a schema", async () => {
    await withFixture(async ({ root }) => {
      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir: path.join(root, "missing-convex"),
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect(await plugin.load(path.join(root, "src/main.ts"))).toBe(null);
    });
  });

  test("does not mutate device-only modules during an app build", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = localFunctions(2);
      await file(localDir, "sync/drafts.ts", source);
      const modulePath = path.join(localDir, "sync/drafts.ts");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, modulePath);

      expect(transformed ?? null).toBe(null);
      expect((await plugin.transform(source, `${modulePath}?import`)) ?? null).toBe(null);
      const resolvedFacade = await plugin.resolveId(
        "./local/sync/drafts",
        path.join(root, "app.ts"),
      );
      const facadeId =
        typeof resolvedFacade === "string"
          ? resolvedFacade
          : (resolvedFacade as { id: string } | null)?.id;
      expect(facadeId?.startsWith("\0virtual:convex-embedded/facade/")).toBe(true);
      const facade = await plugin.load(facadeId!);
      expect(facade).toContain('createLocalFacade("local/sync/drafts",');
      expect(facade).toContain('export const readCompact = embeddedLocal["readCompact"]');
      expect(facade).not.toContain("stampLocal");
    });
  });

  test("keeps ordinary setup registrations in the unmodified source module", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = `import { local } from "../convex/_generated/embedded";
export const legacyRead = local.internalQuery({});
export const legacyDelete = local.internalMutation({});
export const currentWrite = local.internalMutation({});
export const setup = local.internalAction({});
`;
      const modulePath = path.join(localDir, "setup.ts");
      await file(localDir, "setup.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, modulePath);

      expect(transformed ?? null).toBe(null);
    });
  });

  test("wraps a named setup re-export in the immutable facade", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "setup.ts", localFunctions());
      await file(localDir, "entry.ts", 'export { setCompact as setup } from "./setup";\n');
      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const resolved = await plugin.resolveId("./local/entry", path.join(root, "app.ts"));
      const facadeId =
        typeof resolved === "string" ? resolved : (resolved as { id: string } | null)?.id;
      expect(facadeId?.startsWith("\0virtual:convex-embedded/facade/")).toBe(true);
      const facade = await plugin.load(facadeId!);
      expect(facade).toContain('export const setup = embeddedLocal["setup"]');
      expect(facade).not.toContain("stampLocal");
    });
  });

  test("never replaces a device-only module with a stub", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "sync/drafts.ts", localFunctions(2));
      const modulePath = path.join(localDir, "sync/drafts.ts");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect(await plugin.load(modulePath)).toBe(null);
      expect(await plugin.load(`${modulePath}?import`)).toBe(null);
      expect(await plugin.load(path.join(convexDir, "schema.ts"))).toBe(null);
      expect(await plugin.resolveId(toVirtualSourceId(modulePath))).toBe(modulePath);

      const vite = (
        convexEmbeddedUnplugin as unknown as {
          raw(options: unknown, meta: { framework: string }): BundlerPlugin;
        }
      ).raw({ convexDir, local: localDir, schema: fixtureSchema }, { framework: "vite" });
      expect(await vite.resolveId(toVirtualSourceId(modulePath))).toBe(modulePath);
      expect(await vite.load(modulePath)).toBe(null);
    });
  });

  test("keeps aliased exports untouched for the generated facade", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = `${localFunctions(2)}const __embeddedStampLocal = 1;
export { setCompact as delete, __embeddedStampLocal as marker };
`;
      await file(localDir, "sync/drafts.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, path.join(localDir, "sync/drafts.ts"));

      expect(transformed ?? null).toBe(null);
    });
  });

  test("skips exports the stamp cannot name, and modules with nothing to name", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const skipped = `export * from "./helpers";
export { helper } from "./helpers";
export type { Draft } from "./helpers";
const value = 1;
export { value as "compact pref", value as default };
`;
      await file(localDir, "helpers.ts", "export const helper = 1;\nexport type Draft = string;\n");
      await file(localDir, "drafts.ts", skipped);
      await file(localDir, "empty.ts", "const unused = 1;\nvoid unused;\n");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect((await plugin.transform(skipped, path.join(localDir, "drafts.ts"))) ?? null).toBe(
        null,
      );
      expect(
        (await plugin.transform(
          "const unused = 1;\nvoid unused;\n",
          path.join(localDir, "empty.ts"),
        )) ?? null,
      ).toBe(null);
    });
  });

  test("keeps source containing regex literals untouched", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = `import { local } from "../convex/_generated/embedded";

const quoted = /["']/g;
void quoted;

export const toggle = local.mutation({ args: {}, handler: async () => null });
`;
      await file(localDir, "pins.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, path.join(localDir, "pins.ts"));

      expect(transformed ?? null).toBe(null);
    });
  });

  test("keeps ambient declarations out of the emitted source transform", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = `import { local } from "../convex/_generated/embedded";

declare global {
  export const leakedGlobal: number;
}

declare module "virtual:pins" {
  export const leakedModule: number;
}

export const enum Flag {
  On = 1,
}

export const toggle = local.mutation({ args: {}, handler: async () => null });
`;
      await file(localDir, "pins.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, path.join(localDir, "pins.ts"));

      expect(transformed ?? null).toBe(null);
    });
  });

  test("does not rewrite destructuring exports", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = `const pair = { first: 1, second: 2 };

export const alpha = 1,
  beta: Record<string, number> = {};
export const { first, second } = pair;
export const [head, ...tail] = [1, 2, 3];
`;
      await file(localDir, "pins.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const transformed = await plugin.transform(source, path.join(localDir, "pins.ts"));

      expect(transformed ?? null).toBe(null);
    });
  });

  test("leaves CommonJS device modules unstamped but registered", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = localFunctions();
      await file(localDir, "legacy.cts", source);
      await file(localDir, "bridge.cjs", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect((await plugin.transform(source, path.join(localDir, "legacy.cts"))) ?? null).toBe(
        null,
      );
      expect((await plugin.transform(source, path.join(localDir, "bridge.cjs"))) ?? null).toBe(
        null,
      );
      await expect(createFixtureBundle(root, localDir)).resolves.toMatchObject({
        localModules: {
          "local/bridge": { file: path.join(localDir, "bridge.cjs") },
          "local/legacy": { file: path.join(localDir, "legacy.cts") },
        },
      });
    });
  });

  test("scans the project once and reuses the bundle across transforms", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = localFunctions(2);
      await file(localDir, "sync/drafts.ts", source);
      const modulePath = path.join(localDir, "sync/drafts.ts");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      const stamped = await plugin.transform(source, modulePath);
      await rm(path.join(convexDir, "schema.ts"));

      expect((await plugin.transform(source, modulePath))?.code).toBe(stamped?.code);
    });
  });

  test("leaves modules outside the local roots untransformed", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "drafts.ts", localFunctions());
      const source = canonical("replicated", "query", "list");
      await file(convexDir, "messages.ts", source);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as BundlerPlugin;

      expect((await plugin.transform(source, path.join(convexDir, "messages.ts"))) ?? null).toBe(
        null,
      );
    });
  });

  test("rejects Convex modules that import device-only modules from any root", async () => {
    await withFixture(async ({ convexDir, localDir, root }) => {
      const deviceDir = path.join(root, "device");
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(localDir, "prefs.ts", localFunctions());
      await file(deviceDir, "notes.ts", localFunctions());
      await file(
        convexDir,
        "documents.ts",
        `import { setCompact } from "../local/prefs";\nvoid setCompact;\n${canonical(
          "replicated",
          "query",
          "list",
        )}`,
      );

      await expect(createFixtureBundle(root, [localDir, deviceDir])).rejects.toThrow(
        "must not import device-only module",
      );

      await file(
        convexDir,
        "documents.ts",
        `import { setCompact } from "../device/notes";\nvoid setCompact;\n${canonical(
          "replicated",
          "query",
          "list",
        )}`,
      );
      await expect(createFixtureBundle(root, [localDir, deviceDir])).rejects.toThrow(
        "must not import device-only module",
      );
    });
  });

  test("keeps the default lockfile out of the scanned Convex module graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));

      const bundle = await createFixtureBundle(root);
      const lockfile = path.join(convexDir, "_generated", "embedded.ts");

      expect(bundle.generatedPath).toBe(lockfile);
      expect(Object.values(bundle.modules)).not.toContain(lockfile);
      expect(bundle.sourceFiles).not.toContain(lockfile);
      expect(bundle.manifest.embedded).toBeUndefined();
      await expect(readFile(lockfile, "utf8")).resolves.toContain("embeddedManifest");
    });
  });
});

describe("embedded Vite adapter", () => {
  test("installs cross-origin isolation headers for dev and preview", () => {
    const [configPlugin] = convexEmbedded({ schema: fixtureSchema });
    const config = (configPlugin as unknown as { config(): Record<string, unknown> }).config();

    expect(config).toMatchObject({
      preview: {
        headers: {
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      },
      server: {
        headers: {
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      },
    });
  });

  test("uses the same no-mutation module transform in app and worker builds", async () => {
    await withFixture(async ({ convexDir, localDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      const source = localFunctions(2);
      await file(localDir, "sync/drafts.ts", source);
      const modulePath = path.join(localDir, "sync/drafts.ts");

      const [configPlugin, appPlugin] = convexEmbedded({
        convexDir,
        local: localDir,
        schema: fixtureSchema,
      }) as unknown as Array<{
        config(): { worker: { plugins(): BundlerPlugin[] } };
        load(id: string): Promise<string | null>;
        transform(code: string, id: string): Promise<{ code: string } | null | undefined>;
      }>;
      const [workerPlugin] = configPlugin.config().worker.plugins();

      const transformed = await appPlugin.transform(source, modulePath);
      expect(transformed ?? null).toBe(null);
      expect((await workerPlugin.transform(source, modulePath)) ?? null).toBe(null);
      expect(await appPlugin.load(modulePath)).toBe(null);
    });
  });

  test("builds a fixture that imports the virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "messages.ts",
        `import { replicated } from "./embedded";
import { v } from "convex/values";

export const list = replicated.query({
  args: { channel: v.string() },
  handler: () => [],
});
`,
      );
      await file(
        root,
        "src/main.ts",
        `import { embeddedSchema, modules } from "virtual:convex-embedded";

void embeddedSchema;
void modules.messages;
`,
      );

      const output = await build({
        build: {
          rollupOptions: { input: path.join(root, "src/main.ts") },
          write: false,
        },
        logLevel: "silent",
        plugins: [convexEmbedded({ schema: fixtureSchema })],
        resolve: {
          alias: {
            "convex/server": convexServerPath,
            "convex/values": convexValuesPath,
            "@estifanos-sh/convex-embedded/server": embeddedServerPath,
          },
        },
        root,
      });

      expect(output).toBeDefined();
    });
  });

  test("builds the package-owned browser worker entry with the virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", canonical("replicated", "query", "list"));

      const output = await build({
        build: {
          rollupOptions: {
            input: fileURLToPath(new URL("../../dist/browser-embedded.mjs", import.meta.url)),
          },
          write: false,
        },
        logLevel: "silent",
        plugins: [convexEmbedded({ schema: fixtureSchema })],
        root,
        resolve: {
          alias: {
            "@estifanos-sh/convex-embedded/server": embeddedServerPath,
            "convex/server": convexServerPath,
            "convex/values": convexValuesPath,
          },
        },
      });

      type BuiltFile =
        | { fileName: string; source: string | Uint8Array; type: "asset" }
        | { code: string; fileName: string; type: "chunk" };
      const bundles = (Array.isArray(output) ? output : [output]) as unknown as Array<{
        output: BuiltFile[];
      }>;
      const generated = bundles.flatMap((bundle) => bundle.output);
      const worker = generated.find((file) => file.fileName.includes("browser-worker"));
      expect(worker).toBeDefined();
      expect(worker?.type).toBe("asset");
      if (worker?.type !== "asset") throw new Error("Expected an emitted thread worker asset.");
      const workerSource = String(worker.source);
      expect(workerSource).not.toMatch(/^\s*import\s/m);
      expect(workerSource).toContain("MessageHandler");

      const chunks = generated.filter((file) => file.type === "chunk");
      expect(chunks.some((chunk) => chunk.code.includes("data:text/javascript"))).toBe(false);
    });
  });
});

async function withFixture(
  run: (fixture: { convexDir: string; localDir: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "embedded-bundler-"));
  try {
    const convexDir = path.join(root, "convex");
    await run({ convexDir, localDir: path.join(root, "local"), root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function createFixtureBundle(root: string, local?: string | string[]) {
  await generateEmbedded({ analysis: fixtureAnalysis, local, root });
  return createEmbeddedBundle({ analysis: fixtureAnalysis, local, root });
}

function localFunctions(depth = 1): string {
  return `import { local } from "${"../".repeat(depth)}convex/_generated/embedded";

export const setCompact = local.mutation({ args: {}, handler: async () => null });
export const readCompact = local.query({ args: {}, handler: async () => null });
`;
}

function localExportShapes(): string {
  return `type Something = string;
const helper = 1;
const other = 2;

export const alpha = 1;
export function beta() {}
export async function gamma() {}
export class Draft {}
export { helper, other as epsilon };
export type { Something };
`;
}

async function file(root: string, relative: string, contents: string): Promise<void> {
  const fullPath = path.join(root, relative);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

async function embeddedEntrypoint(convexDir: string): Promise<void> {
  await file(convexDir, "_generated/api.ts", "export const components = { embedded: {} };\n");
  await file(
    convexDir,
    "_generated/server.ts",
    `import { mutationGeneric, queryGeneric } from "convex/server";
export const mutation = mutationGeneric;
export const query = queryGeneric;
`,
  );
  await file(
    convexDir,
    "embedded.ts",
    `import { defineEmbedded } from "@estifanos-sh/convex-embedded/server";
import { components } from "./_generated/api";
import schema from "./schema";
import { mutation, query } from "./_generated/server";

export const embedded = defineEmbedded({
  component: components.embedded,
  schema,
});

export const { pull, push } = embedded;
export const { remote, replicated } = embedded;
`,
  );
}

function canonical(
  placement: "replicated" | "remote",
  builder: "query" | "mutation" | "internalQuery" | "internalMutation",
  name: string,
  specifier = "./embedded",
): string {
  return `import { ${placement} } from "${specifier}";
export const ${name} = ${placement}.${builder}({});
`;
}
