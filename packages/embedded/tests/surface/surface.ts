import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  name: string;
};

/** The public entry points from package.json#exports that ship a `.d.mts`. */
const ENTRIES = typedExportEntries();
const NODE_SAFE_IMPORTS = new Set(["devtools", "devtools/vite"]);

interface ExportEntry {
  dts: string;
  name: string;
  specifier: string;
}

function typedExportEntries(): ExportEntry[] {
  return Object.entries(packageJson.exports).flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.types !== "string") return [];
    if (!record.types.startsWith("./dist/") || !record.types.endsWith(".d.mts")) return [];
    const name = key === "." ? "." : key.replace(/^\.\//, "");
    if (name.startsWith("internal/")) return [];
    const specifier = key === "." ? packageJson.name : `${packageJson.name}${key.slice(1)}`;
    return [{ dts: record.types.replace(/^\.\//, ""), name, specifier }];
  });
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

  test("devtools package entries are safe to import in Node", async () => {
    for (const entry of ENTRIES) {
      if (!NODE_SAFE_IMPORTS.has(entry.name)) continue;
      await import(entry.specifier);
    }
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
