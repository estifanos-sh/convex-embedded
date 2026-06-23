import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

const packageRoot = resolve(import.meta.dirname, "../../..");
const repoRoot = resolve(packageRoot, "../..");
const thisFile = resolve(import.meta.filename);

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = resolve(root, entry);
    if (file === thisFile) continue;
    const stat = statSync(file);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules" || entry === ".out") continue;
      out.push(...sourceFiles(file));
      continue;
    }
    if (/\.(?:rs|ts|tsx)$/.test(entry)) out.push(file);
  }
  return out;
}

function rel(file: string) {
  return relative(repoRoot, file);
}

describe("v5 server opacity", () => {
  test("component and server code do not import Loro or CRDT compute libraries", () => {
    const files = [
      ...sourceFiles(resolve(packageRoot, "src/component")),
      ...sourceFiles(resolve(packageRoot, "src/server")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (/\bfrom\s+["'](?!\.)[^"']*(?:loro|crdt)[^"']*["']/.test(source)) {
        offenders.push(rel(file));
      }
      if (/\bimport\s+["'](?!\.)[^"']*(?:loro|crdt)[^"']*["']/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("v5 architecture boundary", () => {
  test("active code, tests, and benches do not retain old migration namespaces", () => {
    const files = [
      ...sourceFiles(resolve(packageRoot, "src")),
      ...sourceFiles(resolve(packageRoot, "tests")),
      ...sourceFiles(resolve(repoRoot, "crates/storage/src")),
      ...sourceFiles(resolve(repoRoot, "crates/storage/tests")),
      ...sourceFiles(resolve(repoRoot, "crates/storage/benches")),
      ...sourceFiles(resolve(repoRoot, "crates/remote/src")),
      ...sourceFiles(resolve(repoRoot, "crates/node/src")),
    ];
    const forbidden = [
      /\bserver-v2\b/i,
      /\bserver v2\b/i,
      /\bcomponent:server-v2\b/i,
      /\bsha256:server-v2\b/i,
      /\bembedded:v1:/i,
      /\bembedded:app:v1:/i,
      /\bembedded v1\b/i,
      /\bEmbeddedLoro\b/,
      /\blocal_outbox\b/i,
      /\bwrite_loro\b/i,
      /\boutboxRecords\b/,
      /\boutbox_records\b/,
      /__embedded_outbox/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${rel(file)} matched ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("component/server code treats opaque CRDT bytes as opaque metadata", () => {
    const files = [
      ...sourceFiles(resolve(packageRoot, "src/component")),
      ...sourceFiles(resolve(packageRoot, "src/server")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (/\bfrom\s+["'](?!\.)[^"']*(?:crdt|loro)[^"']*["']/.test(source)) {
        offenders.push(`${rel(file)} imports CRDT/Loro code`);
      }
      if (/\b(?:decode|parse|fold|merge)\w*\s*\([^)]*opaqueOps/.test(source)) {
        offenders.push(`${rel(file)} appears to interpret opaqueOps`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
