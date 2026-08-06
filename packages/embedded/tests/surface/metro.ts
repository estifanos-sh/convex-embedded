import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

import { generateEmbedded } from "../../src/bundler";
import { toVirtualSourceId, VIRTUAL_MODULE_ID } from "../../src/bundler/virtual";
import { withConvexEmbedded } from "../../src/metro";
import { analyzeEmbeddedSchema, defineEmbeddedSchema } from "../../src/schema";

const fixtureSchema = defineEmbeddedSchema({});

interface TestMetroConfig {
  projectRoot: string;
  resolver: {
    resolveRequest(
      context: TestResolverContext,
      moduleName: string,
      platform: string | null,
    ): unknown;
  };
}

interface TestResolverContext {
  resolveRequest(
    context: TestResolverContext,
    moduleName: string,
    platform: string | null,
  ): unknown;
}

describe("embedded Metro adapter", () => {
  test("materializes deterministic modules and chains the existing resolver", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", embeddedEntrypoint());
      await file(convexDir, "helper.ts", "export const helper = true;\n");
      await file(
        convexDir,
        "messages.ts",
        `import "./helper";\n${canonical("replicated", "query", "list")}`,
      );
      const previous = vi.fn((_context, moduleName: string, _platform: string | null) => ({
        moduleName,
        source: "previous",
      }));
      const config: TestMetroConfig = { projectRoot: root, resolver: { resolveRequest: previous } };

      const first = await withConvexEmbedded(config, { schema: fixtureSchema });
      const cache = path.join(root, "node_modules", ".cache", "convex-embedded");
      const firstRegistry = await readFile(path.join(cache, "registry.js"), "utf8");
      const firstIdentity = await readFile(path.join(cache, "identity.js"), "utf8");
      await withConvexEmbedded(config, { schema: fixtureSchema });

      expect(await readFile(path.join(cache, "registry.js"), "utf8")).toBe(firstRegistry);
      expect(await readFile(path.join(cache, "identity.js"), "utf8")).toBe(firstIdentity);
      expect(firstRegistry).toContain("virtual:convex-embedded/source/");

      const fallback = vi.fn((_context, moduleName: string) => ({ moduleName, source: "default" }));
      const context = { resolveRequest: fallback };
      first.resolver.resolveRequest(context, VIRTUAL_MODULE_ID, "ios");
      expect(previous).toHaveBeenLastCalledWith(context, path.join(cache, "registry.js"), "ios");

      const source = path.join(convexDir, "messages.ts");
      first.resolver.resolveRequest(context, toVirtualSourceId(source), "android");
      expect(previous).toHaveBeenLastCalledWith(context, source, "android");
      const dependency = path.join(convexDir, "helper.ts");
      first.resolver.resolveRequest(context, toVirtualSourceId(dependency), "ios");
      expect(previous).toHaveBeenLastCalledWith(context, dependency, "ios");
      expect(() =>
        first.resolver.resolveRequest(
          context,
          toVirtualSourceId(path.join(convexDir, "_generated", "embedded.ts")),
          "android",
        ),
      ).toThrow("outside the generated module graph");
      expect(fallback).not.toHaveBeenCalled();

      expect(first.resolver.resolveRequest(context, "react", "ios")).toEqual({
        moduleName: "react",
        source: "previous",
      });
      expect(previous).toHaveBeenCalledWith(context, "react", "ios");
    });
  });

  test("materializes device-only modules from every root and resolves their sources", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", embeddedEntrypoint());
      const localDir = path.join(root, "local");
      const deviceDir = path.join(root, "device");
      const drafts = path.join(localDir, "sync/drafts.ts");
      await file(localDir, "sync/drafts.ts", localFunctions(2));
      await file(deviceDir, "prefs.ts", localFunctions());
      const previous = vi.fn((_context, moduleName: string, _platform: string | null) =>
        moduleName === "./setup"
          ? { filePath: drafts, moduleName, source: "previous" }
          : { moduleName, source: "previous" },
      );
      const config: TestMetroConfig = { projectRoot: root, resolver: { resolveRequest: previous } };

      const resolved = await withConvexEmbedded(config, {
        local: [localDir, deviceDir],
        schema: fixtureSchema,
      });
      const registry = await readFile(
        path.join(root, "node_modules", ".cache", "convex-embedded", "registry.js"),
        "utf8",
      );

      expect(registry).toContain(
        `"local/sync/drafts": () => import("${toVirtualSourceId(drafts)}")`,
      );
      expect(registry).toContain(
        `"local/prefs": () => import("${toVirtualSourceId(path.join(deviceDir, "prefs.ts"))}")`,
      );
      expect(registry).not.toContain("stampLocal");

      const fallback = vi.fn((_context, moduleName: string) => ({ moduleName, source: "default" }));
      const context = { resolveRequest: fallback };
      for (const source of [drafts, path.join(deviceDir, "prefs.ts")]) {
        resolved.resolver.resolveRequest(context, toVirtualSourceId(source), "ios");
        expect(previous).toHaveBeenLastCalledWith(context, source, "ios");
      }

      const imported = resolved.resolver.resolveRequest(context, "./setup", "ios") as {
        moduleName: string;
      };
      expect(imported.moduleName).toMatch(/node_modules\/\.cache\/convex-embedded\/local\/.+\.js$/);
      const shim = await readFile(imported.moduleName, "utf8");
      expect(shim).toContain(`import * as source from "${toVirtualSourceId(drafts)}"`);
      expect(shim).toContain('createLocalFacade("local/sync/drafts",');
      expect(shim).toContain('export const setCompact = embeddedLocal["setCompact"]');
      expect(shim).not.toContain("stampLocal");
      expect(shim).toContain(`export * from "${toVirtualSourceId(drafts)}"`);
    });
  });

  test("rejects encoded source paths outside the discovered graph", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", embeddedEntrypoint());
      await file(root, "secret.ts", "export const secret = true;\n");
      await generateFixture(root);
      const config = await withConvexEmbedded<TestMetroConfig>(
        {
          projectRoot: root,
          resolver: {
            resolveRequest: (context, moduleName, platform) =>
              context.resolveRequest(context, moduleName, platform),
          },
        },
        { schema: fixtureSchema },
      );
      const context = { resolveRequest: () => ({}) };

      expect(() =>
        config.resolver.resolveRequest(
          context,
          toVirtualSourceId(path.join(root, "secret.ts")),
          "ios",
        ),
      ).toThrow("outside the generated module graph");
    });
  });

  test("forwards a custom generated contract path", async () => {
    await withFixture(async ({ convexDir, root }) => {
      await file(convexDir, "schema.ts", "export default {};\n");
      await file(convexDir, "embedded.ts", embeddedEntrypoint());
      const generatedPath = "generated/device.ts";

      await expect(
        withConvexEmbedded({ projectRoot: root }, { generatedPath, schema: fixtureSchema }),
      ).resolves.toBeDefined();
      await expect(readFile(path.join(convexDir, generatedPath), "utf8")).resolves.toContain(
        "embeddedManifest",
      );
    });
  });

  test("returns the original config without scanning when disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "embedded-metro-disabled-"));
    try {
      const config = { projectRoot: root };
      await expect(
        withConvexEmbedded(config, { disabled: true, schema: fixtureSchema }),
      ).resolves.toBe(config);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function withFixture(
  run: (fixture: { convexDir: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "embedded-metro-"));
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

async function generateFixture(root: string): Promise<void> {
  await generateEmbedded({ analysis: analyzeEmbeddedSchema(fixtureSchema), root });
}

function embeddedEntrypoint(): string {
  return `export const pull = null;
export const push = null;
export const remote = null;
export const replicated = null;
`;
}

function canonical(
  placement: "replicated" | "remote",
  builder: "query" | "mutation",
  name: string,
): string {
  return `import { ${placement} } from "./embedded";
export const ${name} = ${placement}.${builder}({});
`;
}

function localFunctions(depth = 1): string {
  return `import { local } from "${"../".repeat(depth)}convex/_generated/embedded";

export const setCompact = local.mutation({ args: {}, handler: async () => null });
`;
}
