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
const toolRequiredFiles = new Set([
  "src/component/convex.config.ts",
  "tests/browser/vite-env.d.ts",
  "tests/fixture/convex/convex.config.ts",
]);
const generatedPaths = new Set([
  "src/browser/coordinator/contract.ts",
  "src/contract",
  "src/expo/contract.ts",
  "src/storage/contract.ts",
  "tests/bench/results/artifacts",
  "tests/browser/convex/embedded.generated.ts",
  "tests/metal/convex/embedded.generated.ts",
]);
const rawTimeAllowedFiles = new Set([
  "crates/storage/src/clock.rs",
  "convex/time.ts",
  "packages/embedded/src/component/time.ts",
  "packages/embedded/tests/fixture/convex/time.ts",
  "packages/embedded/tests/testkit/time.ts",
]);
const nativePlatformSymbols = new Set(["sync_url"]);
const testFiles = new Set([
  "tests/runtime/client.ts",
  "tests/runtime/runtime.ts",
  "tests/runtime/schema.ts",
  "tests/storage/storage.ts",
  "tests/surface/browser.ts",
  "tests/surface/bundler.ts",
]);
const bannedTsNames: BannedName[] = [
  { pattern: /^collect[A-Z]/, replacement: "reserve collect for Convex query terminals" },
  { pattern: /^find[A-Z]/, replacement: "use read" },
  { pattern: /^lookup[A-Z]/, replacement: "use read" },
  { pattern: /^put[A-Z]/, replacement: "use write" },
  { pattern: /^upsert[A-Z]/, replacement: "use write" },
  { pattern: /^update[A-Z]/, replacement: "use write" },
  { pattern: /^modify[A-Z]/, replacement: "use write" },
  { pattern: /^persist[A-Z]/, replacement: "use write" },
  { pattern: /^make[A-Z]/, replacement: "use the domain noun and an approved verb" },
  { pattern: /^fmt[A-Z]/, replacement: "use encode for a codec" },
  { pattern: /^unsub[A-Z]/, replacement: "use the owning noun and write or delete" },
  { pattern: /^sync[A-Z]/, replacement: "use push or pull for replication" },
  { pattern: /^resolve[A-Z]/, replacement: "use read or decode" },
];
const bannedRustNames: BannedName[] = [
  { pattern: /^collect_/, replacement: "reserve collect for Convex query terminals" },
  { pattern: /^find_/, replacement: "use read" },
  { pattern: /^lookup_/, replacement: "use read" },
  { pattern: /^put_/, replacement: "use write" },
  { pattern: /^upsert_/, replacement: "use write" },
  { pattern: /^update_/, replacement: "use write" },
  { pattern: /^modify_/, replacement: "use write" },
  { pattern: /^persist_/, replacement: "use write" },
  { pattern: /^make_/, replacement: "use the domain noun and an approved verb" },
  { pattern: /^fmt_/, replacement: "use encode for a codec" },
  { pattern: /^unsub_/, replacement: "use the owning noun and write or delete" },
  { pattern: /^sync_/, replacement: "use push or pull for replication" },
  { pattern: /^resolve_/, replacement: "use read or decode" },
];

const violations: Violation[] = [];

for (const root of authoredRoots) {
  auditPathNames(resolve(packageDir, root));
}
for (const file of walk(resolve(packageDir, "src"), (path) => path.endsWith(".ts"))) {
  if (statSync(file).isDirectory()) continue;
  auditTsExports(file);
}
for (const crateRoot of ["crates/storage/src", "crates/remote/src", "crates/node/src"]) {
  for (const file of walk(resolve(repoDir, crateRoot), (path) => path.endsWith(".rs"))) {
    if (statSync(file).isDirectory()) continue;
    auditRustPublicSymbols(file);
  }
}
auditRawTimeCalls();
auditVersionedNames();
auditDeprecatedTerms();

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
    if (isGeneratedPath(rel) || generatedFiles.has(name) || toolRequiredFiles.has(rel)) continue;
    const stats = statSync(path);
    const stem = stats.isDirectory() ? name : fileStem(name);
    if (rel.startsWith("tests/bench/") && name.endsWith(".bench.ts")) continue;
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

function auditRawTimeCalls(): void {
  const banned = [
    { name: `${"Date"}.now`, pattern: new RegExp(`\\b${"Date"}\\.now\\s*\\(`) },
    {
      name: `${"performance"}.timeOrigin`,
      pattern: new RegExp(`\\b${"performance"}\\.timeOrigin\\b`),
    },
    { name: `${"SystemTime"}::now`, pattern: new RegExp(`\\b${"SystemTime"}::now\\s*\\(`) },
  ];
  const roots = [
    resolve(packageDir, "src"),
    resolve(packageDir, "tests"),
    resolve(packageDir, "scripts"),
    resolve(packageDir, "vite.config.ts"),
    resolve(repoDir, "convex"),
    resolve(repoDir, "demos/browser/vite/src"),
    resolve(repoDir, "demos/browser/vite/vite.config.ts"),
    resolve(repoDir, "vite.config.ts"),
    resolve(repoDir, "crates/storage/src"),
    resolve(repoDir, "crates/remote/src"),
    resolve(repoDir, "crates/node/src"),
  ];
  for (const root of roots) {
    for (const file of walk(root, isAuditedSource)) {
      if (statSync(file).isDirectory()) continue;
      const rel = relative(repoDir, file);
      if (isGeneratedPath(rel) || rawTimeAllowedFiles.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const rule of banned) {
        if (!rule.pattern.test(source)) continue;
        violations.push({
          file: rel,
          message: `direct ${rule.name} reads are banned; absolute time is the storage HLC, elapsed time is getTimerTime()`,
        });
      }
    }
  }
}

function auditVersionedNames(): void {
  const roots = [
    resolve(packageDir, "src"),
    resolve(packageDir, "tests"),
    resolve(packageDir, "scripts"),
    resolve(repoDir, "convex"),
    resolve(repoDir, "demos/browser/vite/src"),
    resolve(repoDir, "crates/storage/src"),
    resolve(repoDir, "crates/remote/src"),
    resolve(repoDir, "crates/node/src"),
  ];
  const pattern = /\b(?:embedded)?[vV]\d+[A-Z_][A-Za-z0-9_]*\b/g;
  for (const root of roots) {
    for (const file of walk(root, isAuditedSource)) {
      if (statSync(file).isDirectory()) continue;
      const rel = relative(repoDir, file);
      if (isGeneratedPath(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        violations.push({
          file: rel,
          message: `implementation name "${match[0]}" contains a design version; use the stable domain name`,
        });
      }
    }
  }
}

function auditDeprecatedTerms(): void {
  const roots = [
    resolve(packageDir, "src"),
    resolve(packageDir, "tests"),
    resolve(packageDir, "scripts"),
    resolve(repoDir, "convex"),
    resolve(repoDir, "demos/browser/vite/src"),
    resolve(repoDir, "crates/storage/src"),
    resolve(repoDir, "crates/remote/src"),
    resolve(repoDir, "crates/node/src"),
  ];
  const terms = [
    // The physical `__embedded_bootstrap` table and its v1 record names are a frozen on-disk ABI.
    // Keep that compatibility vocabulary out of this source-symbol deprecation list.
    deprecated("remote_" + "push_settle", "use remote_settlement_write"),
    deprecated("remote_" + "pull_page", "use remote_page_write"),
    deprecated("remote_" + "settlement_ack", "use remote_receipt"),
    deprecated("remote_" + "read_cursor", "use remote_cursor_read"),
    deprecated("remote_" + "write_cursor", "use remote_cursor_write"),
    deprecated("commitOne" + "Upsert", "use commitOneDocWrite"),
    deprecated("exact" + "ScanBounds", "use hasExactBounds"),
    deprecated("schedule_" + "due_read", "use schedule_lease_read"),
    deprecated("cleanup" + "Follower", "use followerDelete"),
    deprecated("pruneArtifact" + "Copies", "use artifactCopyDelete"),
    deprecated("replay" + "Sweep", "use replayDelete"),
    deprecated("EmbeddedData" + "Upsert", "use EmbeddedDataWrite"),
  ];
  for (const root of roots) {
    for (const file of walk(root, isAuditedSource)) {
      if (statSync(file).isDirectory()) continue;
      const rel = relative(repoDir, file);
      if (isGeneratedPath(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const term of terms) {
        for (const match of source.matchAll(term.pattern)) {
          violations.push({
            file: rel,
            message: `deprecated term "${match[0]}"; ${term.replacement}`,
          });
        }
      }
    }
  }
}

function deprecated(name: string, replacement: string): { pattern: RegExp; replacement: string } {
  return { pattern: new RegExp(`\\b${name}\\b`, "g"), replacement };
}

function auditSymbol(file: string, name: string, banned: BannedName[]): void {
  if (nativePlatformSymbols.has(name)) return;
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

function isAuditedSource(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|rs)$/.test(path);
}

function isGeneratedPath(path: string): boolean {
  return (
    [...generatedPaths].some(
      (generated) => path === generated || path.startsWith(`${generated}/`),
    ) || path.split("/").some((segment) => segment.startsWith(".") || generatedDirs.has(segment))
  );
}
