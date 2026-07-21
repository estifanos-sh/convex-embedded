import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
  name: string;
};

/** The public entry points from package.json#exports that ship a `.d.mts`. */
const ENTRIES = typedExportEntries();
const NODE_SAFE_IMPORTS = new Set(["devtools", "devtools/vite", "metro"]);
const require = createRequire(import.meta.url);

interface ExportEntry {
  dts: string;
  name: string;
  specifier: string;
}

function typedExportEntries(): ExportEntry[] {
  return Object.entries(packageJson.exports).flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const types = declarationPath(record);
    if (types === undefined) return [];
    const name = key === "." ? "." : key.replace(/^\.\//, "");
    if (name.startsWith("internal/")) return [];
    const specifier = key === "." ? packageJson.name : `${packageJson.name}${key.slice(1)}`;
    return [{ dts: types.replace(/^\.\//, ""), name, specifier }];
  });
}

function declarationPath(record: Record<string, unknown>): string | undefined {
  if (typeof record.types === "string") return declarationFile(record.types);
  for (const condition of ["import", "require", "default"]) {
    const value = record[condition];
    if (typeof value !== "object" || value === null) continue;
    const types = (value as Record<string, unknown>).types;
    if (typeof types === "string") return declarationFile(types);
  }
  return undefined;
}

function declarationFile(value: string): string | undefined {
  return value.startsWith("./dist/") && /\.d\.[cm]ts$/.test(value) ? value : undefined;
}

function distDeclarationFiles(dir = join(packageRoot, "dist")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return distDeclarationFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".d.mts")) return [];
    return [fullPath];
  });
}

/** Extract the publicly exported identifiers from a `.d.mts` declaration file, sorted. */
function exportedNames(dts: string): string[] {
  const names = new Set<string>();

  for (const block of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of block[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliased = part.match(/\sas\s+(\w+)$/);
      names.add(aliased ? aliased[1] : part.split(/\s+/)[0]);
    }
  }
  const decl =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|enum|namespace|interface|type)\s+(\w+)/g;
  for (const m of dts.matchAll(decl)) names.add(m[1]);

  return [...names].sort();
}

describe("public package surface", () => {
  for (const entry of ENTRIES) {
    test(`${entry.name} entry exports only its intended surface`, () => {
      const dts = readFileSync(join(packageRoot, entry.dts), "utf8");
      expect(exportedNames(dts)).toMatchSnapshot();
    });
  }

  test("Node-safe package entries are safe to import", async () => {
    for (const entry of ENTRIES) {
      if (!NODE_SAFE_IMPORTS.has(entry.name)) continue;
      await import(entry.specifier);
    }
  });

  test("the Metro package entry is safe to require from CommonJS", () => {
    const metro = require("@convex-dev/embedded/metro") as Record<string, unknown>;
    expect(typeof metro.withConvexEmbedded).toBe("function");
  });

  test("schema-definition package entries are safe to require from CommonJS", () => {
    const schema = require("@convex-dev/embedded/schema") as Record<string, unknown>;
    const values = require("@convex-dev/embedded/values") as Record<string, unknown>;

    expect(typeof schema.defineEmbeddedSchema).toBe("function");
    expect(typeof schema.embeddedTable).toBe("function");
    expect(typeof schema.localTable).toBe("function");
    expect(values.e).toEqual(
      expect.objectContaining({
        count: expect.any(Function),
        local: expect.any(Function),
        omit: expect.any(Function),
        set: expect.any(Function),
        text: expect.any(Function),
      }),
    );
  });

  test("CommonJS schema artifacts and their shared chunks are published", () => {
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "dist/*-*.cjs",
        "dist/*-*.d.cts",
        "dist/schema.cjs",
        "dist/schema.d.cts",
        "dist/values.cjs",
        "dist/values.d.cts",
      ]),
    );
  });

  test("no test-only factory leaks into the public surface", () => {
    const leaked: string[] = [];
    for (const entry of ENTRIES) {
      const names = exportedNames(readFileSync(join(packageRoot, entry.dts), "utf8"));
      for (const name of names) {
        if (/^defineConformance$|^MemoryTransport$|TestKit/i.test(name)) {
          leaked.push(`${entry.name}: ${name}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  test("public declarations do not expose removed DX names", () => {
    const leaked: string[] = [];
    for (const path of distDeclarationFiles()) {
      const declarations = readFileSync(path, "utf8");
      const code = declarations.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const names = exportedNames(declarations).join("\n");
      const relativePath = path.slice(packageRoot.length + 1);
      for (const pattern of [/embedded\.generated/i, new RegExp("sync" + "able", "i")]) {
        if (pattern.test(code) || pattern.test(names) || pattern.test(relativePath)) {
          leaked.push(`${relativePath}: ${pattern}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});
