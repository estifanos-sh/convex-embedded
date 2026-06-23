import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const args = process.argv.slice(2);
const env = parseEnv(args);

if (args.includes("--browser-scale-matrix")) {
  runBrowserScaleMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--browser-scale-goal")) {
  runBrowserScaleGoalMatrix(env);
  process.exit(0);
}

if (args.includes("--browser-scale-stress")) {
  runBrowserScaleStressMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--metal-scale-matrix")) {
  runMetalScaleMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--metal-scale-goal")) {
  runMetalScaleGoalMatrix(env);
  process.exit(0);
}

if (args.includes("--metal-scale-stress")) {
  runMetalScaleStressMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--metal-reconnect-volume")) {
  env.EMBEDDED_METAL_BENCH_RECONNECT_VOLUME = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "metal",
      "tests/metal/reconnect.ts",
      "-t",
      "benchmarks metal reconnect with remote volume",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--metal-scale")) {
  env.EMBEDDED_METAL_BENCH_SCALE = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "metal",
      "tests/metal/scale.ts",
      "-t",
      "benchmarks metal remote scale sync",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--browser-scale")) {
  env.EMBEDDED_BROWSER_BENCH_SCALE = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "browser",
      "tests/bench/browser/scale.ts",
      "-t",
      "benchmarks browser scale fanout",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--browser-startup")) {
  env.EMBEDDED_BROWSER_BENCH_STARTUP = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "browser",
      "tests/browser/runtime.ts",
      "-t",
      "benchmarks browser startup and attach lifecycle",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--browser-remote")) {
  env.EMBEDDED_BROWSER_BENCH_REMOTE = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "browser",
      "tests/bench/browser/remote.ts",
      "-t",
      "compares hosted Embedded convergence with direct Convex",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--browser")) {
  env.EMBEDDED_BROWSER_BENCH = "1";
  buildBrowserArtifacts(env);
  const result = spawnSync(
    "vp",
    [
      "test",
      "run",
      "--project",
      "browser",
      "tests/browser/runtime.ts",
      "-t",
      "benchmarks browser real-world latency matrix",
    ],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (args.includes("--scale-matrix")) {
  runNodeScaleMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--scale-goal")) {
  runNodeScaleGoalMatrix(env);
  process.exit(0);
}

if (args.includes("--scale-stress")) {
  runNodeScaleStressMatrix(env, args.includes("--manual"));
  process.exit(0);
}

if (args.includes("--scale")) {
  env.EMBEDDED_BENCH_SCALE = "1";
  env.CONVEX_EMBEDDED_DEV_NATIVE ??= "1";
  if (process.env.CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD !== "1") {
    run("cargo", ["build", "-p", "node", "--release", "--locked"], repoRoot);
  }
  const result = spawnSync(
    "vp",
    ["test", "run", "--project", "bench", "--disableConsoleIntercept", "tests/bench/scale.ts"],
    {
      cwd: packageDir,
      env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (usesNativeLayers(args)) {
  env.CONVEX_EMBEDDED_DEV_NATIVE ??= "1";
  if (process.env.CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD !== "1") {
    run("cargo", ["build", "-p", "node", "--release", "--locked"], repoRoot);
  }
}

const result = spawnSync(
  "vp",
  ["test", "run", "--project", "bench", "--disableConsoleIntercept", "tests/bench/runtime.ts"],
  {
    cwd: packageDir,
    env,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);

function runNodeScaleMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  const cases = manual
    ? [
        { clients: 20, durationMs: 5_000, revs: 500_000, timeoutMs: 300_000 },
        { clients: 50, durationMs: 5_000, revs: 1_000_000, timeoutMs: 300_000 },
      ]
    : quickScaleCases(2_000, 300_000);
  env.CONVEX_EMBEDDED_DEV_NATIVE ??= "1";
  if (process.env.CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD !== "1") {
    run("cargo", ["build", "-p", "node", "--release", "--locked"], repoRoot);
  }
  for (const entry of cases) {
    runScaleCase(env, entry, "scale");
  }
}

function runNodeScaleGoalMatrix(env: NodeJS.ProcessEnv): void {
  env.CONVEX_EMBEDDED_DEV_NATIVE ??= "1";
  if (process.env.CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD !== "1") {
    run("cargo", ["build", "-p", "node", "--release", "--locked"], repoRoot);
  }
  runAdaptiveScaleCases(env, goalScaleCases(5_000, 300_000), "scale");
}

function runNodeScaleStressMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  env.CONVEX_EMBEDDED_DEV_NATIVE ??= "1";
  if (process.env.CONVEX_EMBEDDED_BENCH_SKIP_NATIVE_BUILD !== "1") {
    run("cargo", ["build", "-p", "node", "--release", "--locked"], repoRoot);
  }
  for (const entry of stressScaleCases(2_000, 300_000, manual)) {
    runScaleCase(env, entry, "scale");
  }
}

function runBrowserScaleMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  const cases = manual
    ? [
        { clients: 30, durationMs: 5_000, revs: 100_000 },
        { clients: 50, durationMs: 5_000, revs: 100_000 },
      ]
    : quickScaleCases(2_000);
  for (const entry of cases) {
    runScaleCase(env, entry, "browser-scale");
  }
}

function runBrowserScaleGoalMatrix(env: NodeJS.ProcessEnv): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  runAdaptiveScaleCases(env, goalScaleCases(5_000, 300_000), "browser-scale");
}

function runBrowserScaleStressMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  for (const entry of stressScaleCases(2_000, 300_000, manual)) {
    runScaleCase(env, entry, "browser-scale");
  }
}

function runMetalScaleMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  const cases = manual
    ? [
        { clients: 30, durationMs: 10_000, revs: 100_000, timeoutMs: 300_000 },
        { clients: 50, durationMs: 10_000, revs: 100_000, timeoutMs: 300_000 },
      ]
    : quickScaleCases(5_000, 300_000);
  for (const entry of cases) {
    runScaleCase(env, entry, "metal-scale");
  }
}

function runMetalScaleGoalMatrix(env: NodeJS.ProcessEnv): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  runAdaptiveScaleCases(env, goalScaleCases(10_000, 300_000), "metal-scale");
}

function runMetalScaleStressMatrix(env: NodeJS.ProcessEnv, manual: boolean): void {
  buildBrowserArtifacts(env);
  env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD = "1";
  for (const entry of stressScaleCases(10_000, 300_000, manual)) {
    runScaleCase(env, entry, "metal-scale");
  }
}

function goalScaleCases(
  durationMs: number,
  timeoutMs: number,
): Array<{
  clients: number;
  durationMs: number;
  revs: number;
  timeoutMs: number;
}> {
  const clients = [1, 2, 3, 5, 8, 10, 15, 20, 30, 40, 50, 75, 100];
  const revs = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000];
  const volume = revs.map((revCount) => ({
    clients: 1,
    durationMs,
    revs: revCount,
    timeoutMs,
  }));
  const fanout = clients.map((clientCount) => ({
    clients: clientCount,
    durationMs,
    revs: 10_000,
    timeoutMs,
  }));
  return [
    ...new Map(
      [...volume, ...fanout].map((entry) => [`${entry.clients}:${entry.revs}`, entry]),
    ).values(),
  ];
}

function quickScaleCases(
  durationMs: number,
  timeoutMs?: number,
): Array<{
  clients: number;
  durationMs: number;
  revs: number;
  timeoutMs?: number;
}> {
  return [
    { clients: 1, durationMs, revs: 1_000, timeoutMs },
    { clients: 1, durationMs, revs: 2_000, timeoutMs },
    { clients: 1, durationMs, revs: 5_000, timeoutMs },
    { clients: 2, durationMs, revs: 1_000, timeoutMs },
    { clients: 5, durationMs, revs: 1_000, timeoutMs },
  ];
}

function stressScaleCases(
  durationMs: number,
  timeoutMs: number,
  manual: boolean,
): Array<{
  clients: number;
  durationMs: number;
  revs: number;
  skipRevList: true;
  timeoutMs: number;
}> {
  const revs = manual
    ? [200_000, 500_000, 1_000_000, 2_000_000, 5_000_000]
    : [200_000, 500_000, 1_000_000];
  const volume = revs.map((revCount) => ({
    clients: 1,
    durationMs,
    revs: revCount,
    skipRevList: true as const,
    timeoutMs,
  }));
  return [
    ...volume,
    {
      clients: 100,
      durationMs,
      revs: 100_000,
      skipRevList: true as const,
      timeoutMs,
    },
  ];
}

function runScaleCase(
  env: NodeJS.ProcessEnv,
  entry: {
    clients: number;
    durationMs: number;
    revs: number;
    skipRevList?: boolean;
    timeoutMs?: number;
    writes?: number;
  },
  mode: "browser-scale" | "metal-scale" | "scale",
): string {
  const skipSuffix = entry.skipRevList === true ? "-skip-rev-list" : "";
  const volumeNoun = mode === "metal-scale" ? "revs" : "rows";
  const out = `tests/bench/.out/${mode}-${entry.clients}clients-${entry.revs}${volumeNoun}${skipSuffix}-${timestamp()}.json`;
  const args = [
    "run",
    "@convex-dev/embedded#bench",
    `--${mode}`,
    "--clients",
    String(entry.clients),
    mode === "metal-scale" ? "--revs" : "--rows",
    String(entry.revs),
    "--out",
    out,
  ];
  if (mode === "metal-scale") {
    args.push("--writes", String(entry.writes ?? 50));
  } else {
    args.push("--duration-ms", String(entry.durationMs));
  }
  if (mode === "scale") args.push("--operations", String(entry.writes ?? 1_000));
  if (entry.timeoutMs !== undefined) {
    args.push("--timeout-ms", String(entry.timeoutMs));
  }
  if (entry.skipRevList === true) {
    args.push("--skip-rev-list");
  }
  run("vp", args, packageDir);
  return resolve(packageDir, out);
}

interface ScaleSignal {
  meanMs: number;
  p95Ms: number;
}

function runAdaptiveScaleCases(
  env: NodeJS.ProcessEnv,
  cases: ReturnType<typeof goalScaleCases>,
  mode: "browser-scale" | "metal-scale" | "scale",
): void {
  const signals = new Map<number, ScaleSignal>();
  for (const entry of cases) {
    const out = runScaleCase(env, entry, mode);
    if (entry.clients === 1) signals.set(entry.revs, readScaleSignal(out));
  }
  const volumes = [...signals.keys()].sort((left, right) => left - right);
  for (let index = 1; index < volumes.length; index += 1) {
    const lower = volumes[index - 1]!;
    const upper = volumes[index]!;
    if (isScaleKnee(signals.get(lower)!, signals.get(upper)!)) {
      refineScaleKnee(env, mode, lower, upper, signals, cases[0]!);
    }
  }
}

function refineScaleKnee(
  env: NodeJS.ProcessEnv,
  mode: "browser-scale" | "metal-scale" | "scale",
  initialLower: number,
  initialUpper: number,
  signals: Map<number, ScaleSignal>,
  template: ReturnType<typeof goalScaleCases>[number],
): void {
  let lower = initialLower;
  let upper = initialUpper;
  while (upper - lower > Math.max(1_000, Math.floor(upper * 0.1))) {
    const midpoint = Math.round((lower + (upper - lower) / 2) / 1_000) * 1_000;
    if (midpoint <= lower || midpoint >= upper) return;
    const out = runScaleCase(env, { ...template, clients: 1, revs: midpoint }, mode);
    const signal = readScaleSignal(out);
    signals.set(midpoint, signal);
    if (isScaleKnee(signals.get(lower)!, signal)) upper = midpoint;
    else lower = midpoint;
  }
}

function readScaleSignal(out: string): ScaleSignal {
  const report = JSON.parse(readFileSync(out, "utf8")) as {
    results?: {
      mutation?: { write?: { meanMs?: number; p95Ms?: number } };
      revCycleMs?: { mean?: number; p95?: number };
      revCreateMs?: { mean?: number; p95?: number };
      writeMs?: { mean?: number; p95?: number };
    };
  };
  const meanMs =
    report.results?.mutation?.write?.meanMs ??
    report.results?.revCycleMs?.mean ??
    report.results?.revCreateMs?.mean ??
    report.results?.writeMs?.mean;
  const p95Ms =
    report.results?.mutation?.write?.p95Ms ??
    report.results?.revCycleMs?.p95 ??
    report.results?.revCreateMs?.p95 ??
    report.results?.writeMs?.p95;
  if (!Number.isFinite(meanMs) || !Number.isFinite(p95Ms)) {
    throw new Error(`Scale report ${out} does not contain finite write mean and p95 latency.`);
  }
  return { meanMs: meanMs!, p95Ms: p95Ms! };
}

function isScaleKnee(lower: ScaleSignal, upper: ScaleSignal): boolean {
  return upper.meanMs > lower.meanMs * 1.25 || upper.p95Ms > lower.p95Ms * 1.25;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildBrowserArtifacts(env: NodeJS.ProcessEnv): void {
  if (env.CONVEX_EMBEDDED_BENCH_SKIP_BROWSER_BUILD === "1") return;
  run("vp", ["pack"], packageDir);
  run("node", ["scripts/wasm.ts"], packageDir);
}

function parseEnv(args: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (args.includes("--smoke")) env.EMBEDDED_BENCH_SMOKE = "1";
  if (args.includes("--split")) env.EMBEDDED_BENCH_SPLIT = "1";
  if (args.includes("--full")) env.EMBEDDED_BROWSER_BENCH_PROFILE = "full";
  const compare = readString(args, "--compare");
  const rows = readString(args, "--rows");
  const iterations = readString(args, "--iterations");
  const layer = readString(args, "--layer");
  const out = readString(args, "--out");
  const tabs = readString(args, "--tabs");
  const warmups = readString(args, "--warmups");
  const clients = readString(args, "--clients");
  const revs = readString(args, "--revs");
  const writes = readString(args, "--writes");
  const operations = readString(args, "--operations");
  const seedBatch = readString(args, "--seed-batch");
  const durationMs = readString(args, "--duration-ms");
  const timeoutMs = readString(args, "--timeout-ms");
  const skipRevList = args.includes("--skip-rev-list");
  if (compare) env.EMBEDDED_BENCH_COMPARE = compare;
  if (rows) {
    env.EMBEDDED_BENCH_ROWS = rows;
    env.EMBEDDED_BROWSER_BENCH_ROWS = rows;
    env.EMBEDDED_BROWSER_BENCH_SCALE_ROWS = rows;
  }
  if (iterations) {
    env.EMBEDDED_BENCH_ITERATIONS = iterations;
    env.EMBEDDED_BROWSER_BENCH_ITERATIONS = iterations;
  }
  if (layer) env.EMBEDDED_BENCH_LAYER = layer;
  if (out) {
    env.EMBEDDED_BENCH_OUT = out;
    env.EMBEDDED_BROWSER_BENCH_OUT = out;
    env.EMBEDDED_METAL_BENCH_OUT = out;
  }
  if (clients) {
    env.EMBEDDED_BENCH_CLIENTS = clients;
    env.EMBEDDED_BROWSER_BENCH_CLIENTS = clients;
    env.EMBEDDED_METAL_BENCH_CLIENTS = clients;
  }
  if (revs) {
    env.EMBEDDED_METAL_BENCH_REVS = revs;
  }
  if (writes) env.EMBEDDED_METAL_BENCH_WRITES = writes;
  if (operations) env.EMBEDDED_BENCH_OPERATIONS = operations;
  if (seedBatch) env.EMBEDDED_BENCH_SEED_BATCH = seedBatch;
  if (durationMs) {
    env.EMBEDDED_BENCH_DURATION_MS = durationMs;
    env.EMBEDDED_BROWSER_BENCH_DURATION_MS = durationMs;
  }
  if (timeoutMs) {
    env.EMBEDDED_BENCH_TIMEOUT_MS = timeoutMs;
    env.EMBEDDED_BROWSER_BENCH_TIMEOUT_MS = timeoutMs;
    env.EMBEDDED_METAL_BENCH_TIMEOUT_MS = timeoutMs;
  }
  if (skipRevList) {
    env.EMBEDDED_METAL_BENCH_SKIP_REV_LIST = "1";
  }
  if (tabs) env.EMBEDDED_BROWSER_BENCH_TABS = tabs;
  if (warmups) {
    env.EMBEDDED_BENCH_WARMUPS = warmups;
    env.EMBEDDED_BROWSER_BENCH_WARMUPS = warmups;
  }
  return env;
}

function readString(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function usesNativeLayers(args: string[]): boolean {
  const layer = readString(args, "--layer");
  if (!layer) return true;
  const layers = layer.split(",").map((part) => part.trim());
  return layers.some((part) => part === "all" || part === "native");
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14);
}
