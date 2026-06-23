import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { build } from "vite";
import { describe, expect, test } from "vite-plus/test";

import { createEmbeddedBundle, toModuleId } from "../../src/bundler";
import { convexEmbeddedUnplugin } from "../../src/unplugin";
import {
  fromVirtualSourceId,
  renderEmbeddedBundle,
  toVirtualSourceId,
  VIRTUAL_MODULE_ID,
  VIRTUAL_SOURCE_MODULE_PREFIX,
} from "../../src/bundler/virtual";
import { convexEmbedded } from "../../src/vite";

const convexServerPath = fileURLToPath(import.meta.resolve("convex/server"));
const convexValuesPath = fileURLToPath(import.meta.resolve("convex/values"));
const embeddedServerPath = fileURLToPath(new URL("../../src/server/index.ts", import.meta.url));

describe("embedded bundler core", () => {
  test("discovers Convex modules and renders a lazy virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");
      await file(convexDir, "admin/users.tsx", "export const list = null;\n");
      await file(convexDir, "_generated/api.ts", "export const api = {};\n");
      await file(convexDir, "ignored.d.ts", "export {};\n");

      const bundle = await createEmbeddedBundle({ root });

      expect(bundle.schemaPath).toBe(path.join(convexDir, "schema.ts"));
      expect(bundle.modules).toEqual({
        "admin/users": path.join(convexDir, "admin/users.tsx"),
        messages: path.join(convexDir, "messages.ts"),
      });
      expect(JSON.stringify(bundle)).not.toContain("_generated");
      expect(JSON.stringify(bundle)).not.toContain("ignored.d.ts");
    });
  });

  test("normalizes module ids relative to the Convex directory", () => {
    expect(toModuleId("/repo/convex", "/repo/convex/admin/users.ts")).toBe("admin/users");
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
      await file(convexDir, "messages.ts", "export const list = null;\n");
      await file(convexDir, "messages.tsx", "export const other = null;\n");

      await expect(createEmbeddedBundle({ root })).rejects.toThrow(
        'Duplicate Convex module id "messages"',
      );
    });
  });

  test("throws a clear error when the schema file is missing", async () => {
    await withFixture(async ({ root }) => {
      await expect(createEmbeddedBundle({ root })).rejects.toThrow("Could not find Convex schema");
    });
  });

  test("throws a clear error when the embedded entrypoint is missing", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");

      await expect(createEmbeddedBundle({ root })).rejects.toThrow(
        "Could not find Convex embedded entrypoint",
      );
    });
  });

  test("ignores declaration files for all TypeScript module extensions", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "helpers.d.mts", "export {};\n");
      await file(convexDir, "helpers.d.cts", "export {};\n");

      await expect(createEmbeddedBundle({ root })).resolves.toMatchObject({
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
      await file(convexDir, "messages.ts", "export const list = null;\n");

      const bundle = await createEmbeddedBundle({ root });

      expect(bundle.modules).toEqual({
        messages: path.join(convexDir, "messages.ts"),
      });
    });
  });

  test("excludes Node-runtime modules from the local worker graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "hosted.ts",
        `/* hosted only */\n"use strict";\n"use node";\nexport const run = null;\n`,
      );
      await file(convexDir, "local.ts", `export const read = null;\n`);

      const bundle = await createEmbeddedBundle({ root });

      expect(bundle.modules).toEqual({
        local: path.join(convexDir, "local.ts"),
      });
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

      const bundle = await createEmbeddedBundle({ root });

      expect(bundle.modules).toEqual({});
      expect(JSON.stringify(bundle)).not.toContain("test-component");
      expect(JSON.stringify(bundle)).not.toContain("child-component");
    });
  });

  test("renders quoted keys for module ids that are not identifiers", () => {
    const source = renderEmbeddedBundle({
      modules: { "admin/users": "/repo/convex/admin/users.ts" },
      schemaPath: "/repo/convex/schema.ts",
    });

    expect(source).toContain('"admin/users": () => import(');
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

  test("resolves and loads the virtual embedded registry", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
      }) as {
        load(id: string): Promise<string | null>;
        resolveId(id: string): Promise<string | null>;
      };

      const resolved = await plugin.resolveId(VIRTUAL_MODULE_ID);
      expect(resolved).toBe(`\0${VIRTUAL_MODULE_ID}`);
      const source = await plugin.load(resolved!);
      expect(source).toContain(`from "${VIRTUAL_SOURCE_MODULE_PREFIX}`);
      expect(source).toContain(`messages: () => import("${VIRTUAL_SOURCE_MODULE_PREFIX}`);
      expect(source).not.toContain("import.meta.glob");
      expect(source).not.toContain("/@fs/");
      expect(source).not.toContain("file://");
    });
  });

  test("resolves virtual source ids to real Convex files", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");
      const modulePath = path.join(convexDir, "messages.ts");
      const sourceId = toVirtualSourceId(modulePath);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
      }) as {
        resolveId(id: string): Promise<string | null>;
      };

      expect(fromVirtualSourceId(sourceId)).toBe(modulePath);
      await expect(plugin.resolveId(sourceId)).resolves.toBe(modulePath);
    });
  });

  test("rejects virtual source ids outside discovered Convex files", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");
      await file(root, "secret.ts", "export const secret = true;\n");

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
      }) as {
        resolveId(id: string): Promise<string | null>;
      };

      await expect(plugin.resolveId(toVirtualSourceId(path.join(root, "secret.ts")))).resolves.toBe(
        null,
      );
    });
  });

  test("keeps Vite dev import-analysis directory probes pinned to schema", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);

      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir,
      }) as {
        resolveId(id: string, importer?: string): Promise<string | null>;
      };

      await expect(plugin.resolveId(convexDir, `\0${VIRTUAL_MODULE_ID}`)).resolves.toBe(
        path.join(convexDir, "schema.ts"),
      );
    });
  });

  test("ignores unrelated load ids without scanning for a schema", async () => {
    await withFixture(async ({ root }) => {
      const plugin = convexEmbeddedUnplugin.rollup({
        convexDir: path.join(root, "missing-convex"),
      }) as {
        load(id: string): Promise<string | null>;
      };

      await expect(plugin.load(path.join(root, "src/main.ts"))).resolves.toBe(null);
    });
  });

  test("does not write a generated embedded registry file", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");

      await createEmbeddedBundle({ root });

      await expect(
        import("node:fs/promises").then(({ stat }) =>
          stat(path.join(convexDir, "_generated/embedded.ts")),
        ),
      ).rejects.toThrow();
    });
  });
});

describe("embedded Vite adapter", () => {
  test("installs cross-origin isolation headers for dev and preview", () => {
    const [configPlugin] = convexEmbedded();
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

  test("builds a fixture that imports the virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await embeddedEntrypoint(convexDir);
      await file(
        convexDir,
        "_generated/server.ts",
        `import { mutationGeneric, queryGeneric } from "convex/server";
export const mutation = mutationGeneric;
export const query = queryGeneric;
`,
      );
      await file(convexDir, "_generated/api.ts", "export const components = { embedded: {} };\n");
      await file(
        convexDir,
        "messages.ts",
        `import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { channel: v.string() },
  handler: () => [],
});
`,
      );
      await file(
        root,
        "src/main.ts",
        `import { modules, schema } from "virtual:convex-embedded";

void schema;
void modules.messages;
`,
      );

      const output = await build({
        build: {
          rollupOptions: { input: path.join(root, "src/main.ts") },
          write: false,
        },
        logLevel: "silent",
        plugins: [convexEmbedded()],
        resolve: {
          alias: {
            "convex/server": convexServerPath,
            "convex/values": convexValuesPath,
            "@convex-dev/embedded/server": embeddedServerPath,
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
      await file(
        convexDir,
        "_generated/server.ts",
        `import { mutationGeneric, queryGeneric } from "convex/server";
export const mutation = mutationGeneric;
export const query = queryGeneric;
`,
      );
      await file(convexDir, "_generated/api.ts", "export const components = { embedded: {} };\n");
      await embeddedEntrypoint(convexDir);
      await file(convexDir, "messages.ts", "export const list = null;\n");

      const output = await build({
        build: {
          rollupOptions: {
            input: fileURLToPath(new URL("../../dist/browser-embedded.mjs", import.meta.url)),
          },
          write: false,
        },
        logLevel: "silent",
        plugins: [convexEmbedded()],
        root,
        resolve: {
          alias: {
            "@convex-dev/embedded/server": embeddedServerPath,
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
  run: (fixture: { convexDir: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "embedded-bundler-"));
  try {
    const convexDir = path.join(root, "convex");
    await run({ convexDir, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function file(root: string, relative: string, contents: string): Promise<void> {
  const fullPath = path.join(root, relative);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

async function embeddedEntrypoint(convexDir: string): Promise<void> {
  await file(
    convexDir,
    "embedded.ts",
    `import { defineEmbedded } from "@convex-dev/embedded/server";
import { components } from "./_generated/api";
import schema from "./schema";
import { mutation, query } from "./_generated/server";

const embedded = defineEmbedded({
  component: components.embedded,
  schema,
});

export const { pull, push } = embedded;
`,
  );
}
