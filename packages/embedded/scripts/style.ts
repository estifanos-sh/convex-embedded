import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Violation = {
  file?: string;
  message: string;
};

type BannedName = {
  pattern: RegExp;
  replacement: string;
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const authoredRoots = ["src", "tests", "scripts"];
const generatedDirs = new Set([
  "_generated",
  "__screenshots__",
  "__snapshots__",
  "dist",
  "node_modules",
]);
const generatedFiles = new Set(["package.json", "Cargo.toml", "tsconfig.json", "vite.config.ts"]);
const testFiles = new Set([
  "tests/node/browser.ts",
  "tests/node/bundler.ts",
  "tests/node/client.ts",
  "tests/node/runtime.ts",
  "tests/node/schema.ts",
  "tests/node/storage.ts",
]);
const bannedTsNames: BannedName[] = [
  { pattern: /^collect[A-Z]/, replacement: "reserve collect for Convex query terminals" },
  { pattern: /^find[A-Z]/, replacement: "use gather, read, or get" },
  { pattern: /^lookup[A-Z]/, replacement: "use read or get" },
  { pattern: /^put[A-Z]/, replacement: "use insert, store, or write" },
  { pattern: /^upsert[A-Z]/, replacement: "use insert, patch, store, or write" },
  { pattern: /^update[A-Z]/, replacement: "use patch or write" },
  { pattern: /^modify[A-Z]/, replacement: "use patch or write" },
  { pattern: /^persist[A-Z]/, replacement: "use store or write" },
  { pattern: /^make[A-Z]/, replacement: "use create or build" },
  { pattern: /^fmt[A-Z]/, replacement: "use format" },
  { pattern: /^unsub[A-Z]/, replacement: "use unsubscribe" },
  { pattern: /^sync[A-Z]/, replacement: "use replicate or pull for replication" },
  { pattern: /^resolve[A-Z]/, replacement: "use read, load, or to" },
];
const bannedRustNames: BannedName[] = [
  { pattern: /^collect_/, replacement: "reserve collect for Convex query terminals" },
  { pattern: /^find_/, replacement: "use gather, read, or get" },
  { pattern: /^lookup_/, replacement: "use read or get" },
  { pattern: /^put_/, replacement: "use insert, store, or write" },
  { pattern: /^upsert_/, replacement: "use insert, patch, store, or write" },
  { pattern: /^update_/, replacement: "use patch or write" },
  { pattern: /^modify_/, replacement: "use patch or write" },
  { pattern: /^persist_/, replacement: "use store or write" },
  { pattern: /^make_/, replacement: "use create or build" },
  { pattern: /^fmt_/, replacement: "use format" },
  { pattern: /^unsub_/, replacement: "use unsubscribe" },
  { pattern: /^sync_/, replacement: "use replicate or pull for replication" },
  { pattern: /^resolve_/, replacement: "use read, load, or to" },
];

const violations: Violation[] = [];

for (const root of authoredRoots) {
  auditPathNames(resolve(packageDir, root));
}
for (const file of walk(resolve(packageDir, "src"), (path) => path.endsWith(".ts"))) {
  if (statSync(file).isDirectory()) continue;
  auditTsExports(file);
}
for (const crateRoot of ["crates/storage/src", "crates/node/src"]) {
  for (const file of walk(resolve(repoDir, crateRoot), (path) => path.endsWith(".rs"))) {
    if (statSync(file).isDirectory()) continue;
    auditRustPublicSymbols(file);
  }
}

if (violations.length > 0) {
  console.error("Style audit failed:");
  for (const violation of violations) {
    const location = violation.file ? `${violation.file}: ` : "";
    console.error(`- ${location}${violation.message}`);
  }
  process.exit(1);
}

console.log("Style audit passed.");

function auditPathNames(root: string): void {
  for (const path of walk(root, () => true)) {
    const rel = relative(packageDir, path);
    const name = basename(path);
    if (isGeneratedPath(rel) || generatedFiles.has(name)) continue;
    const stats = statSync(path);
    const stem = stats.isDirectory() ? name : fileStem(name);
    if (!/^[a-z][a-z0-9]*$/.test(stem)) {
      violations.push({
        file: rel,
        message: "authored file and folder names must be one lowercase word",
      });
    }
  }
}

function auditTsExports(file: string): void {
  const rel = relative(packageDir, file);
  if (testFiles.has(rel)) return;
  const source = readFileSync(file, "utf8");
  const matcher =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(matcher)) {
    auditSymbol(rel, match[1], bannedTsNames);
  }
}

function auditRustPublicSymbols(file: string): void {
  const rel = relative(repoDir, file);
  const source = readFileSync(file, "utf8");
  const matcher =
    /\bpub\s+(?:\([^)]*\)\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]+"\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(matcher)) {
    auditSymbol(rel, match[1], bannedRustNames);
  }
}

function auditSymbol(file: string, name: string, banned: BannedName[]): void {
  for (const rule of banned) {
    if (rule.pattern.test(name)) {
      violations.push({
        file,
        message: `exported/public symbol "${name}" violates the verb lexicon; ${rule.replacement}`,
      });
    }
  }
}

function* walk(root: string, include: (path: string) => boolean): Generator<string> {
  const name = basename(root);
  if (name.startsWith(".") || generatedDirs.has(name)) return;
  const stats = statSync(root);
  if (stats.isDirectory()) {
    yield root;
    for (const child of readdirSync(root)) {
      yield* walk(join(root, child), include);
    }
    return;
  }
  if (include(root)) yield root;
}

function fileStem(name: string): string {
  if (name.endsWith(".d.ts")) return name.slice(0, -".d.ts".length);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function isGeneratedPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") || generatedDirs.has(segment));
}
