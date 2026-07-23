import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { makeFunctionReference } from "convex/server";
import { expect, test } from "vite-plus/test";

import { benchDefaults } from "../../../../config/bench.js";
import {
  benchModules,
  benchSchema,
  benchId,
  nativeModule,
  removeTemporaryStore,
  runtimeBenchRevs,
  seedNativeVolume,
  temporaryStorePath,
} from "./harness";
import {
  createConvexEmbeddedClientForTest,
  type ConvexEmbeddedClient,
} from "../../src/node/client";
import { getTimerTime } from "../../src/time";

interface ScaleOptions {
  clients: number;
  durationMs: number;
  operations: number;
  out?: string;
  rows: number;
  seedBatchSize: number;
  smoke: boolean;
}

interface ScaleSample {
  maxMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  samples: number;
}

interface ScaleReport {
  generatedAt: string;
  node: string;
  notes: string[];
  options: ScaleOptions;
  results: {
    lifecycle: {
      constructMs: number;
      databaseBytes: number;
      readyQueryMs: number;
      seedMs: number;
    };
    fanout: {
      clients: number;
      finalObserved: boolean;
      updates: number;
      write: ScaleSample;
    };
    mutation: {
      write: ScaleSample;
      writes: number;
    };
  };
  runtime: "node";
  version: 4;
}

const TOTAL_BUDGET_MS = 300_000;
const SEED_BUDGET_MS = 210_000;

const insert = makeFunctionReference<
  "mutation",
  { body: string; channel: string; sequence: number },
  string
>(runtimeBenchRevs.insert);
const patch = makeFunctionReference<
  "mutation",
  { body: string; id: string; updated: number },
  null
>(runtimeBenchRevs.patch);
const get = makeFunctionReference<"query", { id: string }, { _id: string } | null>(
  runtimeBenchRevs.get,
);
const listByChannel = makeFunctionReference<
  "query",
  { channel: string; limit: number },
  Array<{ body: string }>
>(runtimeBenchRevs.listByChannel);

test.skipIf(process.env.EMBEDDED_BENCH_SCALE !== "1")(
  "scale benchmark measures local mutation volume and query fanout",
  async () => {
    const options = parseOptions();
    const path = temporaryStorePath();
    const runStartedAt = performance.now();
    const channel = `scale-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    let client: ConvexEmbeddedClient | undefined;
    try {
      const seedStartedAt = performance.now();
      await seedNativeVolume({
        channel,
        batchSize: options.seedBatchSize,
        deadlineMs: runStartedAt + SEED_BUDGET_MS,
        path,
        rows: options.rows,
      });
      const seedMs = performance.now() - seedStartedAt;
      const databaseBytes = storeBytes(path);

      const constructStartedAt = performance.now();
      client = createClient(path);
      const constructMs = performance.now() - constructStartedAt;
      const firstQueryStartedAt = performance.now();
      const initial = await client.query(listByChannel, { channel, limit: 1 });
      const readyQueryMs = performance.now() - firstQueryStartedAt;
      expect(initial.length).toBe(options.rows === 0 ? 0 : 1);
      const id =
        options.rows === 0
          ? await client.mutation(insert, { body: "scale-control", channel, sequence: 0 })
          : benchId(0);
      const seeded = await client.query(get, { id });
      expect(seeded?._id).toBe(id);

      const writeSamples: number[] = [];
      for (let index = 0; index < options.operations; index += 1) {
        assertWithinRunBudget(runStartedAt);
        const startedAt = performance.now();
        await client.mutation(patch, {
          id,
          body: `scale-rev-${index}`,
          updated: index,
        });
        writeSamples.push(performance.now() - startedAt);
      }

      const fanout = await runFanout(client, channel, id, options, runStartedAt);
      const report: ScaleReport = {
        generatedAt: new Date().toISOString(),
        node: process.version,
        notes: [
          "remote is disabled; the benchmark uses the local Node native store only",
          "row volume is seeded through benchmark-only batched storage commits before the client opens",
          "seed time is reported separately and excluded from lifecycle and operation latency",
          "operation count is independent from row volume and uses the ordinary typed mutation API",
          "clients is modeled as independent watchQuery subscribers on one local client",
        ],
        options,
        results: {
          fanout,
          lifecycle: {
            constructMs,
            databaseBytes,
            readyQueryMs,
            seedMs,
          },
          mutation: {
            write: summarize(writeSamples),
            writes: options.operations,
          },
        },
        runtime: "node",
        version: 4,
      };

      printReport(report);
      if (options.out) writeReport(options.out, report);

      expect(report.results.mutation.write.samples).toBe(options.operations);
      expect(report.results.fanout.clients).toBe(options.clients);
      expect(report.results.fanout.write.samples).toBeGreaterThan(0);
      expect(report.results.fanout.finalObserved).toBe(true);
    } finally {
      try {
        await client?.close();
      } finally {
        removeTemporaryStore(path);
      }
    }
  },
  scaleTimeoutMs(),
);

function createClient(path: string): ConvexEmbeddedClient {
  return createConvexEmbeddedClientForTest(
    {
      modules: { messages: benchModules },
      path,
      schema: benchSchema,
    },
    nativeModule(),
  );
}

function scaleTimeoutMs(): number {
  const raw = process.env.EMBEDDED_BENCH_TIMEOUT_MS;
  if (raw === undefined) return TOTAL_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("EMBEDDED_BENCH_TIMEOUT_MS must be a positive number");
  }
  return Math.min(TOTAL_BUDGET_MS, Math.floor(parsed));
}

async function runFanout(
  client: ConvexEmbeddedClient,
  channel: string,
  id: string,
  options: ScaleOptions,
  runStartedAt: number,
): Promise<ScaleReport["results"]["fanout"]> {
  const tracker = createWatchTracker(options.clients);
  const stops = Array.from({ length: options.clients }, () =>
    client.watchQuery(listByChannel, { channel, limit: 1_000 }).onUpdate(() => tracker.callback()),
  );
  try {
    await tracker.waitForInitial();
    const samples: number[] = [];
    const deadline = performance.now() + options.durationMs;
    let updates = 0;
    do {
      assertWithinRunBudget(runStartedAt);
      updates += 1;
      const settled = tracker.waitForNext();
      const startedAt = performance.now();
      await client.mutation(patch, {
        body: `scale-fanout-${updates}`,
        id,
        updated: updates,
      });
      await settled;
      samples.push(performance.now() - startedAt);
    } while (performance.now() < deadline);

    const final = await client.query(listByChannel, { channel, limit: 1 });
    return {
      clients: options.clients,
      finalObserved: final[0]?.body === `scale-fanout-${updates}`,
      updates,
      write: summarize(samples),
    };
  } finally {
    for (const stop of stops) stop();
  }
}

function createWatchTracker(expected: number): {
  callback(): void;
  waitForInitial(): Promise<void>;
  waitForNext(): Promise<void>;
} {
  let initialSeen = 0;
  let initialResolve: (() => void) | undefined;
  const initial = new Promise<void>((resolve) => {
    initialResolve = resolve;
  });
  let remaining = 0;
  let nextResolve: (() => void) | undefined;
  return {
    callback() {
      if (initialSeen < expected) {
        initialSeen += 1;
        if (initialSeen === expected) initialResolve?.();
        return;
      }
      if (!remaining) return;
      remaining -= 1;
      if (!remaining) nextResolve?.();
    },
    waitForInitial: () => initial,
    waitForNext() {
      if (remaining) throw new Error("scale fanout already has a pending update");
      remaining = expected;
      return new Promise<void>((resolve) => {
        nextResolve = resolve;
      });
    },
  };
}

function parseOptions(): ScaleOptions {
  const smoke = process.env.EMBEDDED_BENCH_SMOKE === "1";
  const scale = benchDefaults.node.scale;
  return {
    clients: readNumber("EMBEDDED_BENCH_CLIENTS") ?? (smoke ? scale.smokeClients : scale.clients),
    durationMs:
      readNumber("EMBEDDED_BENCH_DURATION_MS") ??
      (smoke ? scale.smokeDurationMs : scale.durationMs),
    operations:
      readNumber("EMBEDDED_BENCH_OPERATIONS") ?? (smoke ? scale.smokeOperations : scale.operations),
    out: process.env.EMBEDDED_BENCH_OUT,
    rows: readCount("EMBEDDED_BENCH_ROWS") ?? (smoke ? scale.smokeRows : scale.rows),
    seedBatchSize: readNumber("EMBEDDED_BENCH_SEED_BATCH") ?? scale.seedBatchSize,
    smoke,
  };
}

function assertWithinRunBudget(runStartedAt: number): void {
  if (performance.now() - runStartedAt >= TOTAL_BUDGET_MS - 5_000) {
    throw new Error("scale benchmark exhausted its five-minute wall-clock budget");
  }
}

function readNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(parsed);
}

function readCount(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function summarize(values: number[]): ScaleSample {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sum / Math.max(1, sorted.length),
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    samples: values.length,
  };
}

function percentile(sorted: number[], percent: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)] ?? 0;
}

function writeReport(out: string, report: ScaleReport): void {
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

function printReport(report: ScaleReport): void {
  console.log("\nScale benchmark");
  console.log(
    `  volume: ${report.options.rows.toLocaleString()} rows in ${report.options.seedBatchSize.toLocaleString()}-row batches, ${format(report.results.lifecycle.seedMs)}ms, ${formatBytes(report.results.lifecycle.databaseBytes)}`,
  );
  console.log(
    `  lifecycle: ${format(report.results.lifecycle.constructMs)}ms construct, ${format(report.results.lifecycle.readyQueryMs)}ms ready query`,
  );
  console.log(
    `  mutation: ${format(report.results.mutation.write.meanMs)}ms mean, ${format(
      report.results.mutation.write.p90Ms,
    )}ms p90 over ${report.results.mutation.write.samples} writes`,
  );
  console.log(
    `  fanout: ${report.results.fanout.clients} clients, ${report.results.fanout.updates} writes, ${format(
      report.results.fanout.write.p90Ms,
    )}ms p90`,
  );
}

function format(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2);
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function storeBytes(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`].reduce((total, file) => {
    try {
      return total + statSync(file).size;
    } catch {
      return total;
    }
  }, 0);
}
