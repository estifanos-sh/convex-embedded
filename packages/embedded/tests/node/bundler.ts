import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, test } from "vite-plus/test";

import { createEmbeddedBundle, toModuleId } from "../../src/bundler";
import {
  convexEmbeddedUnplugin,
  fromVirtualSourceId,
  renderEmbeddedBundle,
  toVirtualSourceId,
  VIRTUAL_MODULE_ID,
  VIRTUAL_SOURCE_MODULE_PREFIX,
} from "../../src/unplugin";
import { convexEmbedded } from "../../src/vite";

const convexServerPath = fileURLToPath(import.meta.resolve("convex/server"));
const convexValuesPath = fileURLToPath(import.meta.resolve("convex/values"));

describe("embedded bundler core", () => {
  test("discovers Convex modules and renders a lazy virtual registry", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
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

  test("throws when files collide on the same Convex module id", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
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

  test("ignores declaration files for all TypeScript module extensions", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "helpers.d.mts", "export {};\n");
      await file(convexDir, "helpers.d.cts", "export {};\n");

      await expect(createEmbeddedBundle({ root })).resolves.toMatchObject({ modules: {} });
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
  test("resolves and loads the virtual embedded registry", async () => {
    await withFixture(async ({ convexDir }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
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
      await file(
        convexDir,
        "_generated/server.ts",
        `import { queryGeneric } from "convex/server";
export const query = queryGeneric;
`,
      );
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
      });

      expect(output).toBeDefined();
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
