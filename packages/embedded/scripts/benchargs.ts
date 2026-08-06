/** Maps the node benchmark CLI to the environment shared by its test projects. */
export function benchEnv(
  args: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (args.includes("--smoke")) env.EMBEDDED_BENCH_SMOKE = "1";
  if (args.includes("--split")) env.EMBEDDED_BENCH_SPLIT = "1";
  if (args.includes("--full")) env.EMBEDDED_BROWSER_BENCH_PROFILE = "full";
  const compare = benchValue(args, "--compare");
  const rows = benchValue(args, "--rows");
  const iterations = benchValue(args, "--iterations");
  const layer = benchValue(args, "--layer");
  const out = benchValue(args, "--out");
  const tabs = benchValue(args, "--tabs");
  const trials = benchValue(args, "--trials");
  const warmups = benchValue(args, "--warmups");
  const clients = benchValue(args, "--clients");
  const revs = benchValue(args, "--revs");
  const writes = benchValue(args, "--writes");
  const operations = benchValue(args, "--operations");
  const seedBatch = benchValue(args, "--seed-batch");
  const durationMs = benchValue(args, "--duration-ms");
  const timeoutMs = benchValue(args, "--timeout-ms");
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
  if (trials) env.EMBEDDED_BENCH_TRIALS = trials;
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
  if (revs) env.EMBEDDED_METAL_BENCH_REVS = revs;
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
  if (skipRevList) env.EMBEDDED_METAL_BENCH_SKIP_REV_LIST = "1";
  if (tabs) env.EMBEDDED_BROWSER_BENCH_TABS = tabs;
  if (warmups) {
    env.EMBEDDED_BENCH_WARMUPS = warmups;
    env.EMBEDDED_BROWSER_BENCH_WARMUPS = warmups;
  }
  return env;
}

export function benchValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
