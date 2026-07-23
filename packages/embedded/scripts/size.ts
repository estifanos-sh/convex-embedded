import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { sizeBrotliQuality } from "../../../config/build.ts";

interface SizeEntry {
  brotli: number;
  gzip: number;
  path: string;
  raw: number;
}

interface SizeReport {
  cargo: Record<string, string>;
  entries: SizeEntry[];
  generatedAt: string;
  package: {
    exports: string[];
    files: string[];
  };
  profiles: Record<string, SizeEntry>;
  totals: Record<string, SizeEntry>;
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const args = process.argv.slice(2);
const writeJson = readArg("--out");
const comparePath = readArg("--compare");
const printJson = args.includes("--json");
const includeCargo = !args.includes("--no-cargo");
const brotliQualityArg = readArg("--brotli-quality");
const brotliQuality =
  brotliQualityArg === undefined ? sizeBrotliQuality() : Number(brotliQualityArg);

const report = buildReport();
if (writeJson) writeFileSync(writeJson, `${JSON.stringify(report, null, 2)}\n`);

if (printJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
  if (comparePath) printCompare(report, readReport(comparePath));
}

function buildReport(): SizeReport {
  const entries = artifactEntries();
  const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
    files?: string[];
  };
  return {
    cargo: includeCargo ? cargoEvidence() : {},
    entries,
    generatedAt: new Date().toISOString(),
    package: {
      exports: Object.keys(packageJson.exports ?? {}).sort(),
      files: packageJson.files ?? [],
    },
    profiles: profiles(entries),
    totals: totals(entries),
  };
}

function artifactEntries(): SizeEntry[] {
  const dist = resolve(packageDir, "dist");
  if (!existsSync(dist)) return [];
  return walk(dist)
    .filter((file) => /\.(?:wasm|node|mjs|js|d\.mts)$/.test(file))
    .filter((file) => isShippedRootArtifact(relative(packageDir, file)))
    .map((file) => sizeEntry(file))
    .sort((a, b) => b.raw - a.raw || a.path.localeCompare(b.path));
}

function isShippedRootArtifact(path: string): boolean {
  if (path.startsWith("dist/native/")) return false;
  if (path === "dist/node.mjs" || path === "dist/node.d.mts") return false;
  if (path === "dist/native.mjs" || path === "dist/native.d.mts") return false;
  return true;
}

function sizeEntry(file: string): SizeEntry {
  const bytes = readFileSync(file);
  return {
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
    }).byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    path: relative(packageDir, file),
    raw: bytes.byteLength,
  };
}

function totals(entries: SizeEntry[]): Record<string, SizeEntry> {
  const groups: Record<string, string[]> = {
    dist: ["dist/"],
    js: [".mjs", ".js"],
    native: ["dist/native/"],
    types: [".d.mts"],
    wasm: ["dist/wasm/"],
  };
  return Object.fromEntries(
    Object.entries(groups).map(([name, matchers]) => [
      name,
      sum(
        name === "dist"
          ? entries
          : entries.filter((entry) =>
              matchers.some((matcher) =>
                matcher.startsWith(".")
                  ? entry.path.endsWith(matcher)
                  : entry.path.startsWith(matcher),
              ),
            ),
        name,
      ),
    ]),
  );
}

function profiles(entries: SizeEntry[]): Record<string, SizeEntry> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    "browser-runtime": sumEntries(runtimeClosure(["dist/browser.mjs"], byPath), "browser-runtime"),
    "install-payload": sumEntries(entries, "install-payload"),
  };
}

function runtimeClosure(seedPaths: string[], byPath: Map<string, SizeEntry>): SizeEntry[] {
  const seen = new Set<string>();
  const pending = [...seedPaths];
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!path.endsWith(".mjs") && !path.endsWith(".js")) continue;
    const file = resolve(packageDir, path);
    if (!existsSync(file)) continue;
    for (const dependency of relativeRuntimeDependencies(path, readFileSync(file, "utf8"))) {
      if (byPath.has(dependency) && !seen.has(dependency)) pending.push(dependency);
    }
  }
  return [...seen].flatMap((path) => {
    const entry = byPath.get(path);
    return entry ? [entry] : [];
  });
}

function relativeRuntimeDependencies(path: string, source: string): string[] {
  const dependencies: string[] = [];
  const dir = dirname(path);
  const pattern =
    /(?:\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?|import\(\s*|new URL\(\s*)["'](\.\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1].split(/[?#]/, 1)[0];
    dependencies.push(relative(packageDir, resolve(packageDir, dir, specifier)));
  }
  return dependencies;
}

function sumEntries(entries: SizeEntry[], name: string): SizeEntry {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  return sum(unique, name);
}

function sum(entries: SizeEntry[], name: string): SizeEntry {
  return {
    brotli: entries.reduce((n, entry) => n + entry.brotli, 0),
    gzip: entries.reduce((n, entry) => n + entry.gzip, 0),
    path: name,
    raw: entries.reduce((n, entry) => n + entry.raw, 0),
  };
}

function cargoEvidence(): Record<string, string> {
  return {
    duplicates: cargo(["tree", "-p", "node", "--target", "wasm32-wasip1-threads", "-d"]),
    loro: cargo([
      "tree",
      "-p",
      "storage",
      "--target",
      "wasm32-wasip1-threads",
      "-i",
      "loro",
      "-e",
      "features",
    ]),
    turso: cargo([
      "tree",
      "-p",
      "storage",
      "--target",
      "wasm32-wasip1-threads",
      "-i",
      "turso_core",
      "-e",
      "features",
    ]),
  };
}

function cargo(command: string[]): string {
  const result = spawnSync("cargo", command, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  return [result.stdout, result.stderr].join("").trim();
}

function printReport(value: SizeReport): void {
  console.log(`Embedded size report (${value.generatedAt}, brotli q${brotliQuality})`);
  console.log("");
  console.log("Package surface");
  console.log(`  files: ${value.package.files.join(", ")}`);
  console.log(`  exports: ${value.package.exports.join(", ")}`);
  console.log("");
  console.log("Totals");
  for (const name of ["dist", "wasm", "native", "js", "types"]) {
    printEntry(value.totals[name]);
  }
  console.log("");
  console.log("Payload profiles");
  for (const name of ["browser-runtime", "install-payload"]) {
    printEntry(value.profiles[name]);
  }
  console.log("");
  console.log("Largest files");
  for (const entry of value.entries.slice(0, 12)) {
    printEntry(entry);
  }
  if (Object.keys(value.cargo).length) {
    console.log("");
    console.log("Cargo evidence");
    for (const [name, output] of Object.entries(value.cargo)) {
      console.log(`  ${name}: ${firstLines(output, 10).replace(/\n/g, "\n    ")}`);
    }
  }
}

function printCompare(current: SizeReport, previous: SizeReport): void {
  console.log("");
  console.log(`Compared with ${comparePath}`);
  for (const name of ["dist", "wasm", "native", "js", "types"]) {
    const next = current.totals[name];
    const prev = previous.totals[name];
    if (!next || !prev) continue;
    console.log(
      `  ${name}: raw ${delta(next.raw, prev.raw)}, gzip ${delta(next.gzip, prev.gzip)}, brotli ${delta(next.brotli, prev.brotli)}`,
    );
  }
}

function printEntry(entry: SizeEntry | undefined): void {
  if (!entry) return;
  console.log(
    `  ${entry.path}: raw ${formatBytes(entry.raw)}, gzip ${formatBytes(entry.gzip)}, brotli ${formatBytes(entry.brotli)}`,
  );
}

function readReport(path: string): SizeReport {
  return JSON.parse(readFileSync(path, "utf8")) as SizeReport;
}

function firstLines(value: string, limit: number): string {
  const lines = value.split(/\r?\n/);
  const suffix = lines.length > limit ? `\n... ${lines.length - limit} more lines` : "";
  return `${lines.slice(0, limit).join("\n")}${suffix}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function delta(next: number, prev: number): string {
  const diff = next - prev;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${formatBytes(diff)} (${sign}${((diff / prev) * 100).toFixed(1)}%)`;
}

function readArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = join(root, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}
