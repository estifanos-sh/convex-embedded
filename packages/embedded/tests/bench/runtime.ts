import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { makeFunctionReference } from "convex/server";
import { expect, test } from "vite-plus/test";

import { benchDefaults } from "../../../../config/bench.js";
import {
  adapterWrite,
  benchModules,
  benchSchema,
  benchId,
  bindingEq,
  bindingWrite,
  createAdapterBenchHarness,
  createBindingBenchHarness,
  createNativeRuntimeBenchHarness,
  createRuntimeBenchHarness,
  nativeModule,
  type AdapterBenchHarness,
  type BindingBenchHarness,
  type RuntimeBenchHarness,
  type RuntimeBenchHarnessOptions,
  runtimeBenchRevs,
  runtimeBenchStoreSchema,
  temporaryStorePath,
} from "./harness";
import {
  trialAggregate,
  trialRead,
  type TrialAggregate,
  type TrialMeasurement,
} from "./harness/trials";
import {
  createConvexEmbeddedClientForTest,
  type ConvexEmbeddedClient,
} from "../../src/node/client";
import { readDevtoolsBridge } from "../../src/devtools/bridge";
import type {
  BindingCommitOptions,
  BindingCountSpec,
  BindingReadSpec,
  BindingWriteBatch,
  ReadCacheStats,
  StoreBinding,
} from "../../src/storage/binding";
import type { OneDocWriteCommit, WriteBatch } from "../../src/storage/types";
import type { RunMutationOptions, RunMutationTiming } from "../../src/runtime/runner";
import { freezeNormalizedTreeWithEstimate, reviveDoc } from "../../src/runtime/codec";

type BenchLayer =
  | "adapter"
  | "binding"
  | "client"
  | "memory"
  | "runtime-cold"
  | "runtime-hot"
  | "runtime-insert";
type BenchRunResult =
  | Promise<unknown>
  | bigint
  | boolean
  | null
  | number
  | object
  | string
  | symbol
  | undefined;

interface BenchOptions {
  compare?: string;
  iterations: number;
  layers: BenchLayer[];
  out?: string;
  rows: number;
  smoke: boolean;
  split: boolean;
  trials: number;
  warmups: number;
  watcherFanout: number;
}

interface BenchResult extends TrialMeasurement {
  baselineHz?: number;
  baselineName?: string;
  baselineRatio?: number;
  iterations: number;
  layer: BenchLayer;
  name: string;
  trialAggregate?: TrialAggregate;
}

interface BenchReport {
  comparisons?: BenchComparison[];
  iterations: number;
  node: string;
  results: BenchResult[];
  rows: number;
  runtime: "typescript";
  semanticNotes: string[];
  smoke: boolean;
  split: boolean;
  timestamp: string;
  trials?: number;
  version: 3;
  warmups: number;
}

interface MeasureOptions {
  baseline?: { hz: number; name: string };
  beforeEach?: () => void;
  phases?: { means(): Partial<Record<string, number>> | undefined; reset(): void };
  readStats?: () => ReadCacheStats;
}

interface BenchBaseline {
  capturedAt: string;
  notes: string[];
  source: string;
  summaries: BenchSummary[];
  version: 1;
}

interface BenchSummary {
  gate?: boolean;
  hz: number;
  layer: string;
  meanMs: number;
  name: string;
  p95Ms: number;
}

interface BenchComparison {
  baselineHz: number;
  baselineName: string;
  currentHz: number;
  layer: BenchLayer;
  medianRatio: number;
  name: string;
  ratio: number;
  status: "fail" | "inconclusive" | "pass";
  trimmedRatio: number;
}

type MutationTimingPhase = Exclude<keyof RunMutationTiming, "mutationId">;

interface MutationTimingRecorder {
  readonly callback?: (timing: RunMutationTiming) => void;
  means(): Partial<Record<string, number>> | undefined;
  reset(): void;
}

const mutationTimingPhases = [
  "prepareMs",
  "argsEncodeMs",
  "beginMs",
  "handlerMs",
  "batchMs",
  "resultEncodeMs",
  "commitMs",
  "notifyMs",
  "totalMs",
] as const satisfies readonly MutationTimingPhase[];

const clientInsert = makeFunctionReference<
  "mutation",
  { body: string; channel: string; sequence: number },
  string
>(runtimeBenchRevs.insert);
const clientPatch = makeFunctionReference<
  "mutation",
  { body: string; id: string; updated: number },
  null
>(runtimeBenchRevs.patch);
const clientSeed = makeFunctionReference<"mutation", { channel: string; rows: number }, string[]>(
  runtimeBenchRevs.seed,
);
const clientSeedBatchRows = 8_192;

let benchmarkWarmups = 10;

test("typescript runtime benchmark", async () => {
  const options = parseOptions();
  benchmarkWarmups = options.warmups;
  const results = await runTrials(options);

  const report: BenchReport = {
    iterations: options.iterations,
    node: process.version,
    results,
    rows: options.rows,
    runtime: "typescript",
    semanticNotes: [
      "read/query old-baseline ratios are directly comparable",
      "write old-baseline ratios compare against the old async-persist path; embedded resolves mutations after durable projection plus dirty-head commit",
      "runtime write scenarios measure commit resolution, not downstream watcher reruns",
      "heap KB is net heap delta over measured iterations; heapBytesPerOp is recorded in JSON",
      ...(options.trials > 1
        ? [
            "comparison gates use the median metric from fresh, serial trials; pooled raw metrics remain diagnostic in trialAggregate",
            "cross-revision qualification must alternate current and baseline trials externally (for example, ABBA)",
          ]
        : [
            "comparison gates use one trial's raw mean throughput; a mean miss with passing trimmed/median throughput is reported as inconclusive rather than a proven regression",
          ]),
      ...(options.split
        ? [
            "split timings are diagnostic and intentionally opt-in because timing probes add overhead",
          ]
        : []),
    ],
    smoke: options.smoke,
    split: options.split,
    timestamp: new Date().toISOString(),
    trials: options.trials > 1 ? options.trials : undefined,
    version: 3,
    warmups: options.warmups,
  };

  const baseline = options.compare ? readComparisonBaseline(options.compare) : undefined;
  const comparisons = baseline ? compareToBaseline(report, baseline) : [];
  if (comparisons.length) report.comparisons = comparisons;

  printReport(report, options.layers, comparisons);
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${options.out}`);
  }

  expect(report.results.length).toBeGreaterThan(0);
  for (const result of report.results) {
    expect(Number.isFinite(result.hz)).toBe(true);
    expect(result.iterations).toBe(options.iterations);
    expect(result.trialAggregate?.count ?? 1).toBe(options.trials);
  }
  const failures = comparisons.filter((comparison) => comparison.status === "fail");
  expect(
    failures.map(
      (failure) =>
        `${failure.layer} ${failure.name}: ${formatRatio(failure.ratio)} vs ${failure.baselineName}`,
    ),
  ).toEqual([]);
}, 300_000);

async function runTrials(options: BenchOptions): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const layer of options.layers) {
    const trials: BenchResult[][] = [];
    for (let trial = 0; trial < options.trials; trial += 1) {
      // Each layer owns and closes its harnesses, so every trial gets a fresh store.
      trials.push(await runLayer(layer, options));
    }
    results.push(...trialResults(trials));
  }
  return results;
}

function trialResults(trials: readonly BenchResult[][]): BenchResult[] {
  const first = trials[0];
  if (!first) return [];
  if (trials.length === 1) return first;

  for (const trial of trials.slice(1)) {
    if (trial.length !== first.length) {
      throw new Error("Benchmark trial scenarios changed between runs.");
    }
  }

  return first.map((result, index) => {
    const runs = trials.map((trial) => trial[index]!);
    if (runs.some((run) => run.layer !== result.layer || run.name !== result.name)) {
      throw new Error("Benchmark trial scenario order changed between runs.");
    }
    const aggregate = trialAggregate(runs);
    return {
      ...result,
      ...aggregate.metrics,
      baselineRatio: result.baselineHz ? aggregate.metrics.hz / result.baselineHz : undefined,
      trialAggregate: aggregate.aggregate,
    };
  });
}

async function runLayer(layer: BenchLayer, options: BenchOptions): Promise<BenchResult[]> {
  switch (layer) {
    case "memory":
      return runRuntimeScenarios(layer, options, createRuntimeBenchHarness, "hot");
    case "runtime-hot":
      return runRuntimeScenarios(layer, options, createNativeRuntimeBenchHarness, "hot");
    case "runtime-insert":
      return runRuntimeInsertScenarios(layer, options, createNativeRuntimeBenchHarness);
    case "runtime-cold":
      return runRuntimeScenarios(layer, options, createNativeRuntimeBenchHarness, "cold");
    case "adapter":
      return runAdapterScenarios(layer, options);
    case "binding":
      return runBindingScenarios(layer, options);
    case "client":
      return runClientScenarios(layer, options);
  }
}

async function runRuntimeInsertScenarios(
  layer: BenchLayer,
  options: BenchOptions,
  createHarness: (options?: RuntimeBenchHarnessOptions) => Promise<RuntimeBenchHarness>,
): Promise<BenchResult[]> {
  const harnesses: RuntimeBenchHarness[] = [];
  try {
    const results: BenchResult[] = [];
    const insertHarness = await createHarness({ seedRows: 0 });
    harnesses.push(insertHarness);
    let sequence = 0;
    const insertPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.insert",
        options.iterations,
        () =>
          insertHarness.runner.runMutation(
            runtimeBenchRevs.insert,
            {
              body: `inserted-${sequence}`,
              channel: insertHarness.channel,
              sequence: sequence++,
            },
            mutationTimingOption(insertPhases),
          ),
        {
          baseline: oldBaselines.mutationInsert,
          phases: insertPhases,
          readStats: insertHarness.readCacheStats,
        },
      ),
    );

    const productionInsertHarness = await createHarness({ seedRows: 0 });
    harnesses.push(productionInsertHarness);
    let productionSequence = 0;
    const productionInsertPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.insert.with_id",
        options.iterations,
        () => {
          const id = productionSequence++;
          return productionInsertHarness.runner.runMutation(
            runtimeBenchRevs.insert,
            {
              body: `inserted-with-id-${id}`,
              channel: productionInsertHarness.channel,
              sequence: id,
            },
            mutationIdTimingOption(`bench:${id}`, productionInsertPhases),
          );
        },
        {
          baseline: oldBaselines.mutationInsert,
          phases: productionInsertPhases,
          readStats: productionInsertHarness.readCacheStats,
        },
      ),
    );

    const storageInsertHarness = await createHarness({ seedRows: 0 });
    harnesses.push(storageInsertHarness);
    const storageInserts: OneDocWriteCommit[] = Array.from(
      { length: options.iterations + options.warmups },
      (_, index) => ({
        fresh: true,
        docWrite: adapterWrite(benchId(index), storageInsertHarness.channel, index),
      }),
    );
    let storageInsertSequence = 0;
    results.push(
      await measure(
        layer,
        "storage.one_doc_write.no_handler",
        options.iterations,
        () => {
          const commit = storageInserts[storageInsertSequence++ % storageInserts.length]!;
          return storageInsertHarness.store.commitOneDocWrite!(commit, {
            changes: "omit",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: storageInsertHarness.readCacheStats },
      ),
    );

    const storageWithIdHarness = await createHarness({ seedRows: 0 });
    harnesses.push(storageWithIdHarness);
    const storageWithIdInserts = Array.from(
      { length: options.iterations + options.warmups },
      (_, index) => {
        const id = benchId(index);
        return {
          args: `{"body":"inserted-with-id-${index}","channel":"${storageWithIdHarness.channel}","sequence":${index}}`,
          commit: {
            fresh: true,
            docWrite: adapterWrite(
              id,
              storageWithIdHarness.channel,
              index,
              `inserted-with-id-${index}`,
            ),
          } satisfies OneDocWriteCommit,
          mutationId: `bench:${index}`,
          result: `"${id}"`,
        };
      },
    );
    let storageWithIdSequence = 0;
    results.push(
      await measure(
        layer,
        "storage.one_doc_write.no_handler.with_id",
        options.iterations,
        () => {
          const item = storageWithIdInserts[storageWithIdSequence++ % storageWithIdInserts.length]!;
          return storageWithIdHarness.store.commitOneDocWrite!(item.commit, {
            changes: "omit",
            mutationArgs: item.args,
            mutationIsFresh: true,
            mutationId: item.mutationId,
            mutation: "terminal",
            mutationName: "messages:insert",
            mutationResult: item.result,
            source: "local",
          });
        },
        { readStats: storageWithIdHarness.readCacheStats },
      ),
    );
    if (storageWithIdHarness.store.mutation) {
      const storageWithLookupHarness = await createHarness({ seedRows: 0 });
      harnesses.push(storageWithLookupHarness);
      const mutation = storageWithLookupHarness.store.mutation;
      if (!mutation) throw new Error("storage lookup benchmark requires mutation storage");
      const storageWithLookupInserts = Array.from(
        { length: options.iterations + options.warmups },
        (_, index) => {
          const id = benchId(index);
          return {
            args: `{"body":"inserted-with-lookup-${index}","channel":"${storageWithLookupHarness.channel}","sequence":${index}}`,
            commit: {
              fresh: true,
              docWrite: adapterWrite(
                id,
                storageWithLookupHarness.channel,
                index,
                `inserted-with-lookup-${index}`,
              ),
            } satisfies OneDocWriteCommit,
            mutationId: `bench-lookup:${index}`,
            result: `"${id}"`,
          };
        },
      );
      for (const item of storageWithLookupInserts) {
        await mutation.write({
          args: item.args,
          mutationId: item.mutationId,
          name: "messages:insert",
        });
      }
      let storageWithLookupSequence = 0;
      results.push(
        await measure(
          layer,
          "storage.one_doc_write.no_handler.with_id.lookup",
          options.iterations,
          () => {
            const item =
              storageWithLookupInserts[
                storageWithLookupSequence++ % storageWithLookupInserts.length
              ]!;
            return storageWithLookupHarness.store.commitOneDocWrite!(item.commit, {
              changes: "omit",
              mutationArgs: item.args,
              mutationIsFresh: false,
              mutationId: item.mutationId,
              mutation: "terminal",
              mutationName: "messages:insert",
              mutationResult: item.result,
              source: "local",
            });
          },
          { readStats: storageWithLookupHarness.readCacheStats },
        ),
      );
    }
    return results;
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
  }
}

async function runRuntimeScenarios(
  layer: BenchLayer,
  options: BenchOptions,
  createHarness: (options?: RuntimeBenchHarnessOptions) => Promise<RuntimeBenchHarness>,
  temperature: "cold" | "hot",
): Promise<BenchResult[]> {
  const harnesses: RuntimeBenchHarness[] = [];
  try {
    const results: BenchResult[] = [];
    const readHarness = await createHarness({ seedRows: options.rows });
    harnesses.push(readHarness);
    const cacheState = temperature === "hot" ? "cache_hit" : "cache_miss";
    let cursor = 0;
    results.push(
      await measure(
        layer,
        `query.get.${cacheState}`,
        options.iterations,
        () =>
          readHarness.runner.runQuery(runtimeBenchRevs.get, {
            id: readHarness.ids[cursor++ % readHarness.ids.length],
          }),
        {
          beforeEach: coldBeforeEach(readHarness, temperature),
          readStats: readHarness.readCacheStats,
        },
      ),
    );
    results.push(
      await measure(
        layer,
        `query.index.take20.${cacheState}`,
        options.iterations,
        () =>
          readHarness.runner.runQuery(runtimeBenchRevs.listByChannel, {
            channel: readHarness.channel,
            limit: 20,
          }),
        {
          baseline: oldBaselines.indexedTake20,
          beforeEach: coldBeforeEach(readHarness, temperature),
          readStats: readHarness.readCacheStats,
        },
      ),
    );
    results.push(
      await measure(
        layer,
        `query.index.take100.${cacheState}`,
        options.iterations,
        () =>
          readHarness.runner.runQuery(runtimeBenchRevs.listByChannel, {
            channel: readHarness.channel,
            limit: 100,
          }),
        {
          beforeEach: coldBeforeEach(readHarness, temperature),
          readStats: readHarness.readCacheStats,
        },
      ),
    );
    results.push(
      await measure(
        layer,
        `query.index.take1000.${cacheState}`,
        options.iterations,
        () =>
          readHarness.runner.runQuery(runtimeBenchRevs.listByChannel, {
            channel: readHarness.channel,
            limit: 1_000,
          }),
        {
          beforeEach: coldBeforeEach(readHarness, temperature),
          readStats: readHarness.readCacheStats,
        },
      ),
    );
    results.push(
      await measure(
        layer,
        `query.index.count.${cacheState}`,
        options.iterations,
        () =>
          readHarness.runner.runQuery(runtimeBenchRevs.countByChannel, {
            channel: readHarness.channel,
          }),
        {
          beforeEach: coldBeforeEach(readHarness, temperature),
          readStats: readHarness.readCacheStats,
        },
      ),
    );

    const writeHarness = await createHarness({ seedRows: options.rows });
    harnesses.push(writeHarness);
    let patchIndex = 0;
    const patchPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.patch",
        options.iterations,
        () =>
          writeHarness.runner.runMutation(
            runtimeBenchRevs.patch,
            {
              body: `patched-${patchIndex}`,
              id: writeHarness.ids[patchIndex++ % writeHarness.ids.length],
              updated: patchIndex,
            },
            mutationTimingOption(patchPhases),
          ),
        { phases: patchPhases, readStats: writeHarness.readCacheStats },
      ),
    );

    const productionPatchHarness = await createHarness({ seedRows: options.rows });
    harnesses.push(productionPatchHarness);
    let productionPatchIndex = 0;
    const productionPatchPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.patch.with_id",
        options.iterations,
        () => {
          const id = productionPatchIndex++;
          return productionPatchHarness.runner.runMutation(
            runtimeBenchRevs.patch,
            {
              body: `patched-with-id-${id}`,
              id: productionPatchHarness.ids[id % productionPatchHarness.ids.length],
              updated: id,
            },
            mutationIdTimingOption(`bench-patch:${id}`, productionPatchPhases),
          );
        },
        { phases: productionPatchPhases, readStats: productionPatchHarness.readCacheStats },
      ),
    );

    const rewriteHarness = await createHarness({ seedRows: 1 });
    harnesses.push(rewriteHarness);
    let rewriteSequence = 0;
    const rewritePhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.rewrite_same_row",
        options.iterations,
        () => {
          rewriteSequence += 1;
          return rewriteHarness.runner.runMutation(
            runtimeBenchRevs.patch,
            {
              body: `rewrite-${rewriteSequence}`,
              id: rewriteHarness.ids[0]!,
              updated: rewriteSequence,
            },
            mutationTimingOption(rewritePhases),
          );
        },
        { phases: rewritePhases, readStats: rewriteHarness.readCacheStats },
      ),
    );

    const insertHarness = await createHarness({ seedRows: 0 });
    harnesses.push(insertHarness);
    let sequence = 0;
    const insertPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.insert",
        options.iterations,
        () =>
          insertHarness.runner.runMutation(
            runtimeBenchRevs.insert,
            {
              body: `inserted-${sequence}`,
              channel: insertHarness.channel,
              sequence: sequence++,
            },
            mutationTimingOption(insertPhases),
          ),
        {
          baseline: oldBaselines.mutationInsert,
          phases: insertPhases,
          readStats: insertHarness.readCacheStats,
        },
      ),
    );

    const productionInsertHarness = await createHarness({ seedRows: 0 });
    harnesses.push(productionInsertHarness);
    let productionSequence = 0;
    const productionInsertPhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.insert.with_id",
        options.iterations,
        () => {
          const id = productionSequence++;
          return productionInsertHarness.runner.runMutation(
            runtimeBenchRevs.insert,
            {
              body: `inserted-with-id-${id}`,
              channel: productionInsertHarness.channel,
              sequence: id,
            },
            mutationIdTimingOption(`bench:${id}`, productionInsertPhases),
          );
        },
        {
          baseline: oldBaselines.mutationInsert,
          phases: productionInsertPhases,
          readStats: productionInsertHarness.readCacheStats,
        },
      ),
    );

    const readWriteHarness = await createHarness({ seedRows: 0 });
    harnesses.push(readWriteHarness);
    let readWriteSequence = 0;
    const readWritePhases = createMutationTimingRecorder(options.split);
    results.push(
      await measure(
        layer,
        "mutation.read_your_writes",
        options.iterations,
        () =>
          readWriteHarness.runner.runMutation(
            runtimeBenchRevs.readYourWrites,
            {
              body: `ryw-${readWriteSequence}`,
              channel: readWriteHarness.channel,
              sequence: readWriteSequence++,
            },
            mutationTimingOption(readWritePhases),
          ),
        { phases: readWritePhases, readStats: readWriteHarness.readCacheStats },
      ),
    );

    if (options.watcherFanout > 0) {
      const sameQueryWatch = await createSameQueryWatchBench(createHarness, options.watcherFanout);
      harnesses.push(sameQueryWatch.harness);
      results.push(
        await measure(
          layer,
          `watch.same_query_fanout.${options.watcherFanout}`,
          options.iterations,
          () => sameQueryWatch.run(),
          { readStats: sameQueryWatch.harness.readCacheStats },
        ),
      );

      const distinctQueryWatch = await createDistinctQueryWatchBench(
        createHarness,
        options.watcherFanout,
      );
      harnesses.push(distinctQueryWatch.harness);
      results.push(
        await measure(
          layer,
          `watch.distinct_query_fanout.${options.watcherFanout}`,
          options.iterations,
          () => distinctQueryWatch.run(),
          { readStats: distinctQueryWatch.harness.readCacheStats },
        ),
      );

      const hiddenDataOnlyWatch = await createHiddenDataOnlyWatchBench(
        createHarness,
        options.watcherFanout,
      );
      harnesses.push(hiddenDataOnlyWatch.harness);
      results.push(
        await measure(
          layer,
          `watch.hidden_data_only_fanout.${options.watcherFanout}`,
          options.iterations,
          () => hiddenDataOnlyWatch.run(),
          { readStats: hiddenDataOnlyWatch.harness.readCacheStats },
        ),
      );
    }

    return results;
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
  }
}

interface WatchBench {
  harness: RuntimeBenchHarness;
  run(): Promise<void>;
}

async function createSameQueryWatchBench(
  createHarness: (options?: RuntimeBenchHarnessOptions) => Promise<RuntimeBenchHarness>,
  subscribers: number,
): Promise<WatchBench> {
  const harness = await createHarness({ seedRows: 20 });
  const tracker = createWatchTracker(subscribers);
  const stops = Array.from({ length: subscribers }, () =>
    harness.runner.onUpdate(
      runtimeBenchRevs.listByChannel,
      { channel: harness.channel, limit: 20 },
      () => tracker.callback(),
    ),
  );
  await tracker.waitForInitial();

  let sequence = 0;
  return {
    harness: {
      ...harness,
      close: async () => {
        for (const stop of stops) stop();
        await harness.close();
      },
    },
    run: async () => {
      sequence += 1;
      const settled = tracker.waitForNext();
      await harness.runner.runMutation(runtimeBenchRevs.patch, {
        body: `watch-same-${sequence}`,
        id: harness.ids[0]!,
        updated: sequence,
      });
      await settled;
    },
  };
}

async function createDistinctQueryWatchBench(
  createHarness: (options?: RuntimeBenchHarnessOptions) => Promise<RuntimeBenchHarness>,
  watchers: number,
): Promise<WatchBench> {
  const rows = Math.max(20, watchers);
  const harness = await createHarness({ seedRows: rows });
  const tracker = createWatchTracker(watchers);
  const stops = Array.from({ length: watchers }, (_, index) =>
    harness.runner.onUpdate(
      runtimeBenchRevs.listByChannel,
      { channel: harness.channel, limit: index + 1 },
      () => tracker.callback(),
    ),
  );
  await tracker.waitForInitial();

  let sequence = 0;
  return {
    harness: {
      ...harness,
      close: async () => {
        for (const stop of stops) stop();
        await harness.close();
      },
    },
    run: async () => {
      sequence += 1;
      const settled = tracker.waitForNext();
      await harness.runner.runMutation(runtimeBenchRevs.patch, {
        body: `watch-distinct-${sequence}`,
        id: harness.ids[0]!,
        updated: sequence,
      });
      await settled;
    },
  };
}

async function createHiddenDataOnlyWatchBench(
  createHarness: (options?: RuntimeBenchHarnessOptions) => Promise<RuntimeBenchHarness>,
  watchers: number,
): Promise<WatchBench> {
  const rows = Math.max(200, watchers * 2);
  const harness = await createHarness({ seedRows: rows });
  let unexpectedCallbacks = 0;
  const tracker = createWatchTracker(watchers);
  const stops = Array.from({ length: watchers }, (_, index) =>
    harness.runner.onUpdate(
      runtimeBenchRevs.listByChannel,
      { channel: harness.channel, limit: index + 1 },
      () => {
        const wasInitialized = tracker.initialized();
        tracker.callback();
        if (wasInitialized) unexpectedCallbacks += 1;
      },
    ),
  );
  await tracker.waitForInitial();

  let sequence = 0;
  return {
    harness: {
      ...harness,
      close: async () => {
        for (const stop of stops) stop();
        await harness.close();
      },
    },
    run: async () => {
      sequence += 1;
      await harness.runner.runMutation(runtimeBenchRevs.patch, {
        body: `watch-hidden-${sequence}`,
        id: harness.ids[harness.ids.length - 1]!,
        updated: sequence,
      });
      if (unexpectedCallbacks) {
        throw new Error(
          `hidden data-only watch unexpectedly delivered ${unexpectedCallbacks} callbacks`,
        );
      }
    },
  };
}

function createWatchTracker(expected: number): {
  callback(): void;
  initialized(): boolean;
  waitForInitial(): Promise<void>;
  waitForNext(): Promise<void>;
} {
  let initialSeen = 0;
  let initialResolve: (() => void) | undefined;
  const initial = new Promise<void>((resolve) => {
    initialResolve = resolve;
  });
  let remaining = 0;
  let resolveNext: (() => void) | undefined;
  return {
    callback() {
      if (initialSeen < expected) {
        initialSeen += 1;
        if (initialSeen === expected) initialResolve?.();
        return;
      }
      if (!remaining) return;
      remaining -= 1;
      if (!remaining) resolveNext?.();
    },
    initialized: () => initialSeen >= expected,
    waitForInitial: () => initial,
    waitForNext() {
      if (remaining) throw new Error("watch benchmark already waiting for an update");
      remaining = expected;
      return new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    },
  };
}

async function runAdapterScenarios(
  layer: BenchLayer,
  options: BenchOptions,
): Promise<BenchResult[]> {
  const harnesses: AdapterBenchHarness[] = [];
  try {
    const results: BenchResult[] = [];
    const readHarness = await createAdapterBenchHarness({ seedRows: options.rows });
    harnesses.push(readHarness);
    let cursor = 0;
    results.push(
      await measure(
        layer,
        "adapter.doc.read",
        options.iterations,
        () =>
          readHarness.store.doc.read(
            "messages",
            readHarness.ids[cursor++ % readHarness.ids.length],
          ),
        { readStats: readHarness.readCacheStats },
      ),
    );
    results.push(
      await measure(
        layer,
        "adapter.doc.page.read20",
        options.iterations,
        () =>
          readHarness.store.doc.page.read({
            table: "messages",
            index: "by_channel",
            bounds: [{ kind: "eq", value: readHarness.channel }],
            order: "asc",
            pageSize: 20,
          }),
        { baseline: oldBaselines.indexedTake20, readStats: readHarness.readCacheStats },
      ),
    );
    results.push(
      await measure(
        layer,
        "adapter.doc.page.read100",
        options.iterations,
        () =>
          readHarness.store.doc.page.read({
            table: "messages",
            index: "by_channel",
            bounds: [{ kind: "eq", value: readHarness.channel }],
            order: "asc",
            pageSize: 100,
          }),
        { readStats: readHarness.readCacheStats },
      ),
    );
    results.push(
      await measure(
        layer,
        "adapter.doc.page.read1000",
        options.iterations,
        () =>
          readHarness.store.doc.page.read({
            table: "messages",
            index: "by_channel",
            bounds: [{ kind: "eq", value: readHarness.channel }],
            order: "asc",
            pageSize: 1_000,
          }),
        { readStats: readHarness.readCacheStats },
      ),
    );
    let resumeSequence = 0;
    const resumeMax = Math.max(1, readHarness.ids.length - 1_002);
    results.push(
      await measure(
        layer,
        "adapter.doc.page.read1000.resume",
        options.iterations,
        () => {
          const index = resumeSequence++ % resumeMax;
          return readHarness.store.doc.page.read({
            table: "messages",
            index: "by_channel",
            bounds: [{ kind: "eq", value: readHarness.channel }],
            order: "asc",
            pageSize: 1_000,
            resumeAfterKey: [readHarness.channel, index + 1, benchId(index)],
          });
        },
        { readStats: readHarness.readCacheStats },
      ),
    );
    results.push(
      await measure(
        layer,
        "adapter.doc.count",
        options.iterations,
        () =>
          readHarness.store.doc.count.read({
            table: "messages",
            index: "by_channel",
            bounds: [{ kind: "eq", value: readHarness.channel }],
          }),
        { readStats: readHarness.readCacheStats },
      ),
    );

    const writeHarness = await createAdapterBenchHarness({ seedRows: options.rows });
    harnesses.push(writeHarness);
    const warmups = options.warmups;
    const patchBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, batchIndex) => {
        const index = batchIndex % writeHarness.ids.length;
        return {
          docWrites: [
            adapterWrite(
              writeHarness.ids[index]!,
              writeHarness.channel,
              index,
              `patched-${batchIndex + 1}`,
            ),
          ],
          dataOnlyIds: [{ table: "messages", id: writeHarness.ids[index]! }],
          deletes: [],
        };
      },
    );
    let patchIndex = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.patch.data_only",
        options.iterations,
        () => {
          const batch = patchBatches[patchIndex++ % patchBatches.length]!;
          return writeHarness.store.commit(batch, {
            changes: "include",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: writeHarness.readCacheStats },
      ),
    );
    const fullPatchBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, batchIndex) => {
        const index = batchIndex % writeHarness.ids.length;
        return {
          docWrites: [
            adapterWrite(
              writeHarness.ids[index]!,
              writeHarness.channel,
              index,
              `full-patched-${batchIndex + 1}`,
            ),
          ],
          deletes: [],
        };
      },
    );
    let fullPatchIndex = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.patch.full_index",
        options.iterations,
        () => {
          const batch = fullPatchBatches[fullPatchIndex++ % fullPatchBatches.length]!;
          return writeHarness.store.commit(batch, {
            changes: "include",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: writeHarness.readCacheStats },
      ),
    );

    const rewriteHarness = await createAdapterBenchHarness({ seedRows: 1 });
    harnesses.push(rewriteHarness);
    const rewriteBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [
          adapterWrite(rewriteHarness.ids[0]!, rewriteHarness.channel, 0, `rewrite-${index + 1}`),
        ],
        dataOnlyIds: [{ table: "messages", id: rewriteHarness.ids[0]! }],
        deletes: [],
      }),
    );
    let rewriteSequence = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.rewrite_same_row.data_only",
        options.iterations,
        () => {
          const batch = rewriteBatches[rewriteSequence++ % rewriteBatches.length]!;
          return rewriteHarness.store.commit(batch, {
            changes: "include",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: rewriteHarness.readCacheStats },
      ),
    );

    const insertHarness = await createAdapterBenchHarness({ seedRows: 0 });
    harnesses.push(insertHarness);
    const insertBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [adapterWrite(benchId(index), insertHarness.channel, index)],
        freshIds: [{ table: "messages", id: benchId(index) }],
        deletes: [],
      }),
    );
    let sequence = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.insert",
        options.iterations,
        () => {
          const batch = insertBatches[sequence++ % insertBatches.length]!;
          return insertHarness.store.commit(batch, {
            changes: "include",
            mutation: "none",
            source: "local",
          });
        },
        { baseline: oldBaselines.mutationInsert, readStats: insertHarness.readCacheStats },
      ),
    );

    const oneDocWriteInsertHarness = await createAdapterBenchHarness({ seedRows: 0 });
    harnesses.push(oneDocWriteInsertHarness);
    const oneDocWriteInserts: OneDocWriteCommit[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        fresh: true,
        docWrite: adapterWrite(benchId(index), oneDocWriteInsertHarness.channel, index),
      }),
    );
    let oneDocWriteInsertSequence = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.insert.one_doc_write",
        options.iterations,
        () => {
          const commit =
            oneDocWriteInserts[oneDocWriteInsertSequence++ % oneDocWriteInserts.length]!;
          return oneDocWriteInsertHarness.store.commitOneDocWrite(commit, {
            changes: "include",
            mutation: "none",
            source: "local",
          });
        },
        {
          baseline: oldBaselines.mutationInsert,
          readStats: oneDocWriteInsertHarness.readCacheStats,
        },
      ),
    );

    const oneDocWriteNoChangesHarness = await createAdapterBenchHarness({ seedRows: 0 });
    harnesses.push(oneDocWriteNoChangesHarness);
    const oneDocWriteNoChanges: OneDocWriteCommit[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        fresh: true,
        docWrite: adapterWrite(benchId(index), oneDocWriteNoChangesHarness.channel, index),
      }),
    );
    let oneDocWriteNoChangesSequence = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.insert.one_doc_write.no_changes",
        options.iterations,
        () => {
          const commit =
            oneDocWriteNoChanges[oneDocWriteNoChangesSequence++ % oneDocWriteNoChanges.length]!;
          return oneDocWriteNoChangesHarness.store.commitOneDocWrite(commit, {
            changes: "omit",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: oneDocWriteNoChangesHarness.readCacheStats },
      ),
    );

    const insertNoChangesHarness = await createAdapterBenchHarness({ seedRows: 0 });
    harnesses.push(insertNoChangesHarness);
    const insertNoChangesBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [adapterWrite(benchId(index), insertNoChangesHarness.channel, index)],
        freshIds: [{ table: "messages", id: benchId(index) }],
        deletes: [],
      }),
    );
    let noChangesSequence = 0;
    results.push(
      await measure(
        layer,
        "adapter.commit.insert.no_changes",
        options.iterations,
        () => {
          const batch =
            insertNoChangesBatches[noChangesSequence++ % insertNoChangesBatches.length]!;
          return insertNoChangesHarness.store.commit(batch, {
            changes: "omit",
            mutation: "none",
            source: "local",
          });
        },
        { readStats: insertNoChangesHarness.readCacheStats },
      ),
    );

    const remoteInsertHarness = await createAdapterBenchHarness({ seedRows: 0 });
    harnesses.push(remoteInsertHarness);
    const remoteInsertBatches: WriteBatch[] = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [adapterWrite(benchId(index), remoteInsertHarness.channel, index)],
        freshIds: [{ table: "messages", id: benchId(index) }],
        deletes: [],
      }),
    );
    let remoteSequence = 0;
    results.push(
      await measure(layer, "adapter.commit.insert.remote", options.iterations, () => {
        const batch = remoteInsertBatches[remoteSequence++ % remoteInsertBatches.length]!;
        return remoteInsertHarness.store.commit(batch, { changes: "include", source: "remote" });
      }),
    );
    return results;
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
  }
}

interface ClientBenchHarness {
  channel: string;
  client: ConvexEmbeddedClient;
  close(): Promise<void>;
  ids: string[];
}

async function createClientBenchHarness(
  options: RuntimeBenchHarnessOptions = {},
): Promise<ClientBenchHarness> {
  const client = createConvexEmbeddedClientForTest(
    {
      modules: { messages: benchModules },
      path: temporaryStorePath(),
      schema: benchSchema,
    },
    nativeModule(),
  );
  try {
    await client.open();
    const channel = options.channel ?? "general";
    const ids = await seedClientRows(client, channel, options.seedRows ?? 0);
    readDevtoolsBridge(client).clearActivity();
    return {
      channel,
      client,
      close: () => client.close(),
      ids,
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Preserve the setup error after a best-effort cleanup of a partially opened client.
    }
    throw error;
  }
}

async function seedClientRows(
  client: ConvexEmbeddedClient,
  channel: string,
  rows: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let remaining = rows; remaining > 0; remaining -= clientSeedBatchRows) {
    ids.push(
      ...(await client.mutation(clientSeed, {
        channel,
        rows: Math.min(remaining, clientSeedBatchRows),
      })),
    );
  }
  return ids;
}

async function runClientScenarios(
  layer: BenchLayer,
  options: BenchOptions,
): Promise<BenchResult[]> {
  const harnesses: ClientBenchHarness[] = [];
  try {
    const results: BenchResult[] = [];

    const insertHarness = await createClientBenchHarness({ seedRows: 0 });
    harnesses.push(insertHarness);
    let sequence = 0;
    results.push(
      await measure(
        layer,
        "client.mutation.insert",
        options.iterations,
        () =>
          insertHarness.client.mutation(clientInsert, {
            body: `client-inserted-${sequence}`,
            channel: insertHarness.channel,
            sequence: sequence++,
          }),
        { baseline: oldBaselines.mutationInsert },
      ),
    );

    const patchHarness = await createClientBenchHarness({ seedRows: options.rows });
    harnesses.push(patchHarness);
    let patchIndex = 0;
    results.push(
      await measure(
        layer,
        "client.mutation.patch",
        options.iterations,
        () =>
          patchHarness.client.mutation(clientPatch, {
            body: `client-patched-${patchIndex}`,
            id: patchHarness.ids[patchIndex++ % patchHarness.ids.length]!,
            updated: patchIndex,
          }),
        {},
      ),
    );

    return results;
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
  }
}

async function runBindingScenarios(
  layer: BenchLayer,
  options: BenchOptions,
): Promise<BenchResult[]> {
  const harnesses: BindingBenchHarness[] = [];
  try {
    const results: BenchResult[] = [];
    const readHarness = await createBindingBenchHarness({ seedRows: options.rows });
    harnesses.push(readHarness);
    let cursor = 0;
    results.push(
      await measure(layer, "binding.docRead", options.iterations, () =>
        bindingDocRead(
          readHarness,
          "messages",
          readHarness.ids[cursor++ % readHarness.ids.length]!,
        ),
      ),
    );
    results.push(
      await measure(
        layer,
        "binding.docPageRead20",
        options.iterations,
        () =>
          bindingDocPageRead(readHarness, {
            table: "messages",
            index: "by_channel",
            bounds: [bindingEq(readHarness.channel)],
            order: "asc",
            pageSize: 20,
          }),
        { baseline: oldBaselines.indexedTake20 },
      ),
    );
    results.push(
      await measure(layer, "binding.docPageRead100", options.iterations, () =>
        bindingDocPageRead(readHarness, {
          table: "messages",
          index: "by_channel",
          bounds: [bindingEq(readHarness.channel)],
          order: "asc",
          pageSize: 100,
        }),
      ),
    );
    results.push(
      await measure(layer, "binding.docPageRead1000", options.iterations, () =>
        bindingDocPageRead(readHarness, {
          table: "messages",
          index: "by_channel",
          bounds: [bindingEq(readHarness.channel)],
          order: "asc",
          pageSize: 1_000,
        }),
      ),
    );
    let bindingResumeSequence = 0;
    const bindingResumeMax = Math.max(1, readHarness.ids.length - 1_002);
    results.push(
      await measure(layer, "binding.docPageRead1000.resume", options.iterations, () => {
        const index = bindingResumeSequence++ % bindingResumeMax;
        return bindingDocPageRead(readHarness, {
          table: "messages",
          index: "by_channel",
          bounds: [bindingEq(readHarness.channel)],
          order: "asc",
          pageSize: 1_000,
          resumeAfterKey: [
            { text: readHarness.channel },
            { real: index + 1 },
            { text: benchId(index) },
          ],
        });
      }),
    );
    const textSamples = await bindingPageTextSamples(readHarness, bindingResumeMax);
    let parseSequence = 0;
    results.push(
      await measure(layer, "js.page.parse1000", options.iterations, () => {
        const text = textSamples[parseSequence++ % textSamples.length]!;
        return (JSON.parse(text) as unknown[]).length;
      }),
    );
    let parseReviveSequence = 0;
    results.push(
      await measure(layer, "js.page.parse_revive1000", options.iterations, () => {
        const text = textSamples[parseReviveSequence++ % textSamples.length]!;
        return parseReviveDocs(text).length;
      }),
    );
    let parseReviveFreezeSequence = 0;
    results.push(
      await measure(layer, "js.page.parse_revive_freeze1000", options.iterations, () => {
        const text = textSamples[parseReviveFreezeSequence++ % textSamples.length]!;
        const docs = parseReviveDocs(text);
        freezeNormalizedTreeWithEstimate({ cursor: null, docs });
        return docs.length;
      }),
    );
    results.push(
      await measure(layer, "binding.docCountRead", options.iterations, () =>
        bindingDocCountRead(readHarness, {
          table: "messages",
          index: "by_channel",
          bounds: [bindingEq(readHarness.channel)],
        }),
      ),
    );
    results.push(
      await measure(layer, "binding.clock.next", options.iterations, () =>
        readHarness.binding.clockRead(),
      ),
    );

    const writeHarness = await createBindingBenchHarness({ seedRows: options.rows });
    harnesses.push(writeHarness);
    const warmups = options.warmups;
    const patchBatches = Array.from({ length: options.iterations + warmups }, (_, batchIndex) => {
      const index = batchIndex % writeHarness.ids.length;
      return {
        docWrites: [
          bindingWrite(
            writeHarness.ids[index]!,
            writeHarness.channel,
            index,
            `patched-${batchIndex + 1}`,
          ),
        ],
        deletes: [],
        dataOnlyIds: [{ table: "messages", id: writeHarness.ids[index]! }],
        freshIds: [],
        idMappings: [],
      };
    });
    let patchIndex = 0;
    results.push(
      await measure(layer, "binding.commit.patch.data_only", options.iterations, () => {
        const batch = patchBatches[patchIndex++ % patchBatches.length]!;
        return bindingCommit(writeHarness, batch, { source: "local" });
      }),
    );
    const fullPatchBatches = Array.from(
      { length: options.iterations + warmups },
      (_, batchIndex) => {
        const index = batchIndex % writeHarness.ids.length;
        return {
          docWrites: [
            bindingWrite(
              writeHarness.ids[index]!,
              writeHarness.channel,
              index,
              `full-patched-${batchIndex + 1}`,
            ),
          ],
          deletes: [],
          freshIds: [],
          idMappings: [],
        };
      },
    );
    let fullPatchIndex = 0;
    results.push(
      await measure(layer, "binding.commit.patch.full_index", options.iterations, () => {
        const batch = fullPatchBatches[fullPatchIndex++ % fullPatchBatches.length]!;
        return bindingCommit(writeHarness, batch, { source: "local" });
      }),
    );

    const rewriteHarness = await createBindingBenchHarness({ seedRows: 1 });
    harnesses.push(rewriteHarness);
    const rewriteBatches = Array.from({ length: options.iterations + warmups }, (_, index) => ({
      docWrites: [
        bindingWrite(rewriteHarness.ids[0]!, rewriteHarness.channel, 0, `rewrite-${index + 1}`),
      ],
      dataOnlyIds: [{ table: "messages", id: rewriteHarness.ids[0]! }],
      deletes: [],
      freshIds: [],
      idMappings: [],
    }));
    let rewriteSequence = 0;
    results.push(
      await measure(layer, "binding.commit.rewrite_same_row.data_only", options.iterations, () => {
        const batch = rewriteBatches[rewriteSequence++ % rewriteBatches.length]!;
        return bindingCommit(rewriteHarness, batch, { source: "local" });
      }),
    );

    const insertHarness = await createBindingBenchHarness({ seedRows: 0 });
    harnesses.push(insertHarness);
    const insertBatches = Array.from({ length: options.iterations + warmups }, (_, index) => ({
      docWrites: [bindingWrite(benchId(index), insertHarness.channel, index)],
      deletes: [],
      freshIds: [{ table: "messages", id: benchId(index) }],
      idMappings: [],
    }));
    let sequence = 0;
    results.push(
      await measure(
        layer,
        "binding.commit.insert",
        options.iterations,
        () => {
          const batch = insertBatches[sequence++ % insertBatches.length]!;
          return bindingCommit(insertHarness, batch, { source: "local" });
        },
        { baseline: oldBaselines.mutationInsert },
      ),
    );

    const mutationCacheWriteHarness = await createBindingBenchHarness({ seedRows: 0 });
    harnesses.push(mutationCacheWriteHarness);
    let mutationCacheWriteSequence = 0;
    results.push(
      await measure(layer, "binding.mutation.fresh", options.iterations, () => {
        const index = mutationCacheWriteSequence++;
        const mutationId = `bench-mutation:${index}`;
        return mutationCacheWriteHarness.binding.mutationCacheWrite!({
          args: `{"body":"message ${index}","channel":"${mutationCacheWriteHarness.channel}","sequence":${index}}`,
          mutationId,
          name: "messages:send",
        });
      }),
    );

    if (insertHarness.binding.commitOneDocWrite) {
      const oneDocWriteHarness = await createBindingBenchHarness({ seedRows: 0 });
      harnesses.push(oneDocWriteHarness);
      const oneDocWriteBatches = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          docWrites: [bindingWrite(benchId(index), oneDocWriteHarness.channel, index)],
          deletes: [],
          freshIds: [{ table: "messages", id: benchId(index) }],
          idMappings: [],
        }),
      );
      let oneDocWriteSequence = 0;
      results.push(
        await measure(layer, "binding.commit.insert.one_doc_write_sync", options.iterations, () => {
          const batch = oneDocWriteBatches[oneDocWriteSequence++ % oneDocWriteBatches.length]!;
          return bindingCommitOneDocWrite(oneDocWriteHarness, batch, { source: "local" });
        }),
      );
    }

    if (insertHarness.binding.commitOneDocWrite) {
      const inlineWithMutationHarness = await createBindingBenchHarness({ seedRows: 0 });
      harnesses.push(inlineWithMutationHarness);
      const inlineWithMutationBatches = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          docWrites: [bindingWrite(benchId(index), inlineWithMutationHarness.channel, index)],
          deletes: [],
          freshIds: [{ table: "messages", id: benchId(index) }],
          idMappings: [],
        }),
      );
      const inlineWithMutationMetadata = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          args: `{"body":"message ${index}","channel":"${inlineWithMutationHarness.channel}","sequence":${index}}`,
          id: `bench-commit-precomputed:${index}`,
          result: `"${benchId(index)}"`,
        }),
      );
      let inlineWithMutationSequence = 0;
      results.push(
        await measure(layer, "binding.commit.insert.inline.with_id", options.iterations, () => {
          const index = inlineWithMutationSequence++;
          const batch = inlineWithMutationBatches[index % inlineWithMutationBatches.length]!;
          const mutationId = `bench-commit:${index}`;
          return bindingCommitOneDocWrite(inlineWithMutationHarness, batch, {
            includeChanges: false,
            mutationArgs: `{"body":"message ${index}","channel":"${inlineWithMutationHarness.channel}","sequence":${index}}`,
            mutationId,
            mutationName: "messages:send",
            mutationResult: `"${benchId(index)}"`,
            mutationIsFresh: true,
            source: "local",
          });
        }),
      );
      let inlineWithMutationPrecomputedSequence = 0;
      results.push(
        await measure(
          layer,
          "binding.commit.insert.inline.with_id.precomputed",
          options.iterations,
          () => {
            const index = inlineWithMutationPrecomputedSequence++;
            const batch = inlineWithMutationBatches[index % inlineWithMutationBatches.length]!;
            const metadata = inlineWithMutationMetadata[index % inlineWithMutationMetadata.length]!;
            return bindingCommitOneDocWrite(inlineWithMutationHarness, batch, {
              includeChanges: false,
              mutationArgs: metadata.args,
              mutationId: metadata.id,
              mutationName: "messages:send",
              mutationResult: metadata.result,
              mutationIsFresh: true,
              source: "local",
            });
          },
        ),
      );
      let inlineWithMutationPrecomputedArgsSequence = 0;
      results.push(
        await measure(
          layer,
          "binding.commit.insert.inline.with_id.precomputed_args",
          options.iterations,
          () => {
            const index = inlineWithMutationPrecomputedArgsSequence++;
            const batch = inlineWithMutationBatches[index % inlineWithMutationBatches.length]!;
            const metadata = inlineWithMutationMetadata[index % inlineWithMutationMetadata.length]!;
            return bindingCommitOneDocWrite(inlineWithMutationHarness, batch, {
              includeChanges: false,
              mutationArgs: metadata.args,
              mutationId: `bench-commit-precomputed-args:${index}`,
              mutationName: "messages:send",
              mutationResult: `"${benchId(index)}"`,
              mutationIsFresh: true,
              source: "local",
            });
          },
        ),
      );
      let inlineWithMutationPrecomputedResultSequence = 0;
      results.push(
        await measure(
          layer,
          "binding.commit.insert.inline.with_id.precomputed_result",
          options.iterations,
          () => {
            const index = inlineWithMutationPrecomputedResultSequence++;
            const batch = inlineWithMutationBatches[index % inlineWithMutationBatches.length]!;
            const metadata = inlineWithMutationMetadata[index % inlineWithMutationMetadata.length]!;
            return bindingCommitOneDocWrite(inlineWithMutationHarness, batch, {
              includeChanges: false,
              mutationArgs: `{"body":"message ${index}","channel":"${inlineWithMutationHarness.channel}","sequence":${index}}`,
              mutationId: `bench-commit-precomputed-result:${index}`,
              mutationName: "messages:send",
              mutationResult: metadata.result,
              mutationIsFresh: true,
              source: "local",
            });
          },
        ),
      );

      const inlineWithMutationLookupHarness = await createBindingBenchHarness({ seedRows: 0 });
      harnesses.push(inlineWithMutationLookupHarness);
      const inlineWithMutationLookupBatches = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          docWrites: [bindingWrite(benchId(index), inlineWithMutationLookupHarness.channel, index)],
          deletes: [],
          freshIds: [{ table: "messages", id: benchId(index) }],
          idMappings: [],
        }),
      );
      let inlineWithMutationLookupSequence = 0;
      results.push(
        await measure(
          layer,
          "binding.commit.insert.inline.with_id.lookup",
          options.iterations,
          () => {
            const index = inlineWithMutationLookupSequence++;
            const batch =
              inlineWithMutationLookupBatches[index % inlineWithMutationLookupBatches.length]!;
            const mutationId = `bench-commit-lookup:${index}`;
            return bindingCommitOneDocWrite(inlineWithMutationLookupHarness, batch, {
              includeChanges: false,
              mutationArgs: `{"body":"message ${index}","channel":"${inlineWithMutationLookupHarness.channel}","sequence":${index}}`,
              mutationId,
              mutationName: "messages:send",
              mutationResult: `"${benchId(index)}"`,
              source: "local",
            });
          },
        ),
      );
    }

    const insertNoChangesHarness = await createBindingBenchHarness({ seedRows: 0 });
    harnesses.push(insertNoChangesHarness);
    const insertNoChangesBatches = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [bindingWrite(benchId(index), insertNoChangesHarness.channel, index)],
        deletes: [],
        freshIds: [{ table: "messages", id: benchId(index) }],
        idMappings: [],
      }),
    );
    let noChangesSequence = 0;
    results.push(
      await measure(layer, "binding.commit.insert.no_changes", options.iterations, () => {
        const batch = insertNoChangesBatches[noChangesSequence++ % insertNoChangesBatches.length]!;
        return bindingCommit(insertNoChangesHarness, batch, {
          includeChanges: false,
          source: "local",
        });
      }),
    );

    if (insertHarness.binding.commitOneDocWrite) {
      const inlineInsertHarness = await createBindingBenchHarness({ seedRows: 0 });
      harnesses.push(inlineInsertHarness);
      const inlineInsertBatches = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          docWrites: [bindingWrite(benchId(index), inlineInsertHarness.channel, index)],
          deletes: [],
          freshIds: [{ table: "messages", id: benchId(index) }],
          idMappings: [],
        }),
      );
      let inlineSequence = 0;
      results.push(
        await measure(layer, "binding.commit.insert.inline", options.iterations, () => {
          const batch = inlineInsertBatches[inlineSequence++ % inlineInsertBatches.length]!;
          return bindingCommitOneDocWrite(inlineInsertHarness, batch, { source: "local" });
        }),
      );
    }

    if (insertHarness.binding.commitOneDocWrite) {
      const inlineNoChangesHarness = await createBindingBenchHarness({ seedRows: 0 });
      harnesses.push(inlineNoChangesHarness);
      const inlineNoChangesBatches = Array.from(
        { length: options.iterations + warmups },
        (_, index) => ({
          docWrites: [bindingWrite(benchId(index), inlineNoChangesHarness.channel, index)],
          deletes: [],
          freshIds: [{ table: "messages", id: benchId(index) }],
          idMappings: [],
        }),
      );
      let inlineNoChangesSequence = 0;
      results.push(
        await measure(layer, "binding.commit.insert.inline.no_changes", options.iterations, () => {
          const batch =
            inlineNoChangesBatches[inlineNoChangesSequence++ % inlineNoChangesBatches.length]!;
          return bindingCommitOneDocWrite(inlineNoChangesHarness, batch, {
            includeChanges: false,
            source: "local",
          });
        }),
      );
    }

    const remoteInsertHarness = await createBindingBenchHarness({ seedRows: 0 });
    harnesses.push(remoteInsertHarness);
    const remoteInsertBatches = Array.from(
      { length: options.iterations + warmups },
      (_, index) => ({
        docWrites: [bindingWrite(benchId(index), remoteInsertHarness.channel, index)],
        deletes: [],
        freshIds: [{ table: "messages", id: benchId(index) }],
        idMappings: [],
      }),
    );
    let remoteSequence = 0;
    results.push(
      await measure(layer, "binding.commit.insert.remote", options.iterations, () => {
        const batch = remoteInsertBatches[remoteSequence++ % remoteInsertBatches.length]!;
        return bindingCommit(remoteInsertHarness, batch, { source: "remote" });
      }),
    );
    const emptyHarness = await createBindingBenchHarness({ seedRows: 0 });
    harnesses.push(emptyHarness);
    const emptyBatch: BindingWriteBatch = {
      docWrites: [],
      deletes: [],
      freshIds: [],
      idMappings: [],
    };
    results.push(
      await measure(layer, "binding.commit.empty", options.iterations, () =>
        bindingCommit(emptyHarness, emptyBatch, { source: "remote" }),
      ),
    );
    results.push(
      await measure(layer, "binding.commit.empty.local", options.iterations, () =>
        bindingCommit(emptyHarness, emptyBatch, {
          includeChanges: false,
          source: "local",
        }),
      ),
    );
    let emptyWithMutationSequence = 0;
    results.push(
      await measure(layer, "binding.commit.empty.with_id", options.iterations, () => {
        const index = emptyWithMutationSequence++;
        return bindingCommit(emptyHarness, emptyBatch, {
          includeChanges: false,
          mutationArgs: `{"sequence":${index}}`,
          mutationId: `bench-empty-commit:${index}`,
          mutationName: "messages:noop",
          mutationResult: "null",
          mutationIsFresh: true,
          source: "local",
        });
      }),
    );
    results.push(...(await runBindingOpenSetupScenarios(layer, options)));
    return results;
  } finally {
    await Promise.all(harnesses.map((harness) => harness.close()));
  }
}

async function runBindingOpenSetupScenarios(
  layer: BenchLayer,
  options: BenchOptions,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const Store = nativeModule().Store;
  const warmPath = temporaryStorePath();
  const warmStore = (await Store.open(warmPath)) as StoreBinding;
  await warmStore.setup(runtimeBenchStoreSchema);
  await Promise.resolve(warmStore.close());

  results.push(
    await measure(layer, "binding.open.cold", options.iterations, async () => {
      const binding = (await Store.open(temporaryStorePath())) as StoreBinding;
      await Promise.resolve(binding.close());
    }),
  );
  results.push(
    await measure(layer, "binding.open.warm", options.iterations, async () => {
      const binding = (await Store.open(warmPath)) as StoreBinding;
      await Promise.resolve(binding.close());
    }),
  );
  results.push(
    await measure(layer, "binding.open_setup.cold", options.iterations, async () => {
      const binding = (await Store.open(temporaryStorePath())) as StoreBinding;
      try {
        await binding.setup(runtimeBenchStoreSchema);
      } finally {
        await Promise.resolve(binding.close());
      }
    }),
  );
  results.push(
    await measure(layer, "binding.open_setup.warm", options.iterations, async () => {
      const binding = (await Store.open(warmPath)) as StoreBinding;
      try {
        await binding.setup(runtimeBenchStoreSchema);
      } finally {
        await Promise.resolve(binding.close());
      }
    }),
  );
  return results;
}

function bindingDocRead(harness: BindingBenchHarness, table: string, id: string) {
  return harness.binding.docRead(table, id);
}

function bindingDocPageRead(harness: BindingBenchHarness, spec: BindingReadSpec) {
  return harness.binding.docPageRead(spec);
}

async function bindingPageTextSamples(
  harness: BindingBenchHarness,
  resumeMax: number,
): Promise<string[]> {
  const count = Math.min(64, Math.max(1, resumeMax));
  const samples: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const page = await bindingDocPageRead(harness, {
      table: "messages",
      index: "by_channel",
      bounds: [bindingEq(harness.channel)],
      order: "asc",
      pageSize: 1_000,
      resumeAfterKey: [{ text: harness.channel }, { real: index + 1 }, { text: benchId(index) }],
    });
    samples.push(page.text);
  }
  return samples;
}

function parseReviveDocs(text: string): Record<string, unknown>[] {
  const docs = JSON.parse(text) as Record<string, unknown>[];
  for (const doc of docs) reviveDoc(doc);
  return docs;
}

function bindingDocCountRead(harness: BindingBenchHarness, spec: BindingCountSpec) {
  return harness.binding.docCountRead(spec);
}

function bindingCommit(
  harness: BindingBenchHarness,
  batch: BindingWriteBatch,
  options: BindingCommitOptions,
) {
  return harness.binding.commit(batch, options);
}

function bindingCommitOneDocWrite(
  harness: BindingBenchHarness,
  batch: BindingWriteBatch,
  options: BindingCommitOptions,
) {
  const docWrite = batch.docWrites[0]!;
  return harness.binding.commitOneDocWrite
    ? harness.binding.commitOneDocWrite(
        docWrite.table,
        docWrite.id,
        docWrite.data,
        docWrite.cols,
        docWrite.creationTime,
        options.source,
        options.mutationId,
        options.mutationName,
        options.mutationArgs,
        options.mutationResult,
        options.includeChanges,
        batch.freshIds.length === 1,
        batch.dataOnlyIds?.length === 1,
        options.mutationIsFresh,
      )
    : bindingCommit(harness, batch, options);
}

function parseOptions(): BenchOptions {
  const smoke = process.env.EMBEDDED_BENCH_SMOKE === "1";
  const runtime = benchDefaults.node.runtime;
  const iterations =
    readNumber("EMBEDDED_BENCH_ITERATIONS") ??
    (smoke ? runtime.smokeIterations : runtime.iterations);
  const requestedWarmups =
    readNumber("EMBEDDED_BENCH_WARMUPS") ?? readNumber("EMBEDDED_BENCH_WARMUP") ?? runtime.warmups;
  return {
    compare: process.env.EMBEDDED_BENCH_COMPARE,
    iterations,
    layers: parseLayers(process.env.EMBEDDED_BENCH_LAYER ?? "all"),
    out: process.env.EMBEDDED_BENCH_OUT,
    rows: readNumber("EMBEDDED_BENCH_ROWS") ?? (smoke ? runtime.smokeRows : runtime.rows),
    smoke,
    split: process.env.EMBEDDED_BENCH_SPLIT === "1",
    trials: readNumber("EMBEDDED_BENCH_TRIALS") ?? 1,
    warmups: Math.min(iterations, requestedWarmups),
    watcherFanout: readNonNegativeNumber("EMBEDDED_BENCH_WATCHERS") ?? runtime.watcherFanout,
  };
}

function readComparisonBaseline(path: string): BenchBaseline {
  const value = JSON.parse(readFileSync(path, "utf8")) as BenchBaseline;
  if (value.version !== 1 || !Array.isArray(value.summaries)) {
    throw new Error(`${path} is not a benchmark baseline file`);
  }
  return value;
}

function compareToBaseline(report: BenchReport, baseline: BenchBaseline): BenchComparison[] {
  const byKey = new Map<string, BenchSummary>();
  for (const summary of baseline.summaries) {
    byKey.set(`${summary.layer}:${summary.name}`, summary);
  }

  const tolerance = readNonNegativeNumber("EMBEDDED_BENCH_COMPARE_TOLERANCE_PERCENT") ?? 0;
  const floor = 1 - tolerance / 100;
  const comparisons: BenchComparison[] = [];
  for (const result of report.results) {
    const summary = byKey.get(`${result.layer}:${result.name}`);
    if (!summary) continue;
    if (summary.gate === false) continue;
    const ratio = result.hz / summary.hz;
    const trimmedRatio = result.trimmedHz / summary.hz;
    const medianRatio = result.medianHz / summary.hz;
    comparisons.push({
      baselineHz: summary.hz,
      baselineName: baseline.source,
      currentHz: result.hz,
      layer: result.layer,
      medianRatio,
      name: result.name,
      ratio,
      status: comparisonStatus({ medianRatio, ratio, trimmedRatio }, floor),
      trimmedRatio,
    });
  }
  return comparisons;
}

function comparisonStatus(
  ratios: { medianRatio: number; ratio: number; trimmedRatio: number },
  floor: number,
): BenchComparison["status"] {
  if (ratios.ratio >= floor) return "pass";
  if (ratios.trimmedRatio >= floor || ratios.medianRatio >= floor) return "inconclusive";
  return "fail";
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

function readNonNegativeNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function parseLayers(raw: string): BenchLayer[] {
  const layers = raw.split(",").flatMap((part) => {
    const layer = part.trim();
    if (layer === "all") return ["memory", "runtime-hot", "runtime-cold", "adapter", "binding"];
    if (layer === "native") return ["runtime-hot", "runtime-cold", "adapter", "binding"];
    if (
      layer === "adapter" ||
      layer === "binding" ||
      layer === "client" ||
      layer === "memory" ||
      layer === "runtime-cold" ||
      layer === "runtime-hot" ||
      layer === "runtime-insert"
    ) {
      return [layer];
    }
    throw new Error(
      "EMBEDDED_BENCH_LAYER must be one of: all, native, memory, runtime-hot, runtime-cold, runtime-insert, adapter, binding, client",
    );
  });
  return [...new Set(layers)] as BenchLayer[];
}

async function measure(
  layer: BenchLayer,
  name: string,
  iterations: number,
  run: () => BenchRunResult,
  options: MeasureOptions = {},
): Promise<BenchResult> {
  for (let index = 0; index < benchmarkWarmups; index += 1) {
    options.beforeEach?.();
    await run();
  }
  options.phases?.reset();

  const startStats = options.readStats?.();
  const startHeap = process.memoryUsage().heapUsed;
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    options.beforeEach?.();
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  const endHeap = process.memoryUsage().heapUsed;
  const endStats = options.readStats?.();
  const cacheDelta = diffStats(startStats, endStats);
  const timing = trialRead(samples);
  const heapDeltaBytes = endHeap - startHeap;
  return {
    baselineHz: options.baseline?.hz,
    baselineName: options.baseline?.name,
    baselineRatio: options.baseline ? timing.hz / options.baseline.hz : undefined,
    cacheBytes: endStats?.bytes,
    cacheHits: cacheDelta?.hits,
    cacheMisses: cacheDelta?.misses,
    heapBytesPerOp: heapDeltaBytes / iterations,
    heapDeltaBytes,
    iterations,
    layer,
    name,
    phaseMeanMs: options.phases?.means(),
    samplesMs: samples,
    ...timing,
  };
}

function createMutationTimingRecorder(enabled: boolean): MutationTimingRecorder {
  if (!enabled) {
    return {
      means: () => undefined,
      reset: () => undefined,
    };
  }
  const totals = new Map<MutationTimingPhase, number>();
  let count = 0;
  return {
    callback(timing) {
      count += 1;
      for (const key of mutationTimingPhases) {
        totals.set(key, (totals.get(key) ?? 0) + timing[key]);
      }
    },
    means() {
      if (count === 0) return undefined;
      const means: Partial<Record<string, number>> = {};
      for (const key of mutationTimingPhases) means[key] = (totals.get(key) ?? 0) / count;
      return means;
    },
    reset() {
      count = 0;
      totals.clear();
    },
  };
}

function mutationTimingOption(recorder: MutationTimingRecorder): RunMutationOptions | undefined {
  return recorder.callback ? { onTiming: recorder.callback } : undefined;
}

function mutationIdTimingOption(
  mutationId: string,
  recorder: MutationTimingRecorder,
): RunMutationOptions {
  return recorder.callback
    ? { mutationIsFresh: true, mutationId, onTiming: recorder.callback }
    : { mutationIsFresh: true, mutationId };
}

function coldBeforeEach(
  harness: RuntimeBenchHarness,
  temperature: "cold" | "hot",
): (() => void) | undefined {
  return temperature === "cold" ? harness.clearReadCache : undefined;
}

function diffStats(
  before: ReadCacheStats | undefined,
  after: ReadCacheStats | undefined,
): { hits: number; misses: number } | undefined {
  if (!before || !after) return undefined;
  return {
    hits: sumStats(after.hits) - sumStats(before.hits),
    misses: sumStats(after.misses) - sumStats(before.misses),
  };
}

function sumStats(stats: Record<string, number>): number {
  return Object.values(stats).reduce((sum, value) => sum + value, 0);
}

function printReport(
  report: BenchReport,
  layers: BenchLayer[],
  comparisons: BenchComparison[],
): void {
  console.log("Embedded runtime benchmark");
  const trials = report.trials ? ` trials=${report.trials}` : "";
  console.log(
    `runtime=typescript node=${report.node} layers=${layers.join(",")} rows=${report.rows} iterations=${report.iterations}${trials} warmups=${report.warmups}`,
  );
  for (const note of report.semanticNotes) console.log(`note=${note}`);
  for (const layer of layers) {
    console.log("");
    console.log(`[${layer}]`);
    console.log(
      `${"scenario".padEnd(28)} ${"ops/sec".padStart(12)} ${"mean ms".padStart(10)} ${"trim ms".padStart(10)} ${"p50 ms".padStart(10)} ${"p95 ms".padStart(10)} ${"max ms".padStart(10)} ${"cache h/m".padStart(13)} ${"heap KB".padStart(9)} ${"vs old".padStart(8)}`,
    );
    for (const result of report.results.filter((entry) => entry.layer === layer)) {
      console.log(
        `${result.name.padEnd(28)} ${format(result.hz).padStart(12)} ${format(result.meanMs).padStart(10)} ${format(result.trimmedMeanMs).padStart(10)} ${format(result.medianMs).padStart(10)} ${format(result.p95Ms).padStart(10)} ${format(result.maxMs).padStart(10)} ${formatCache(result).padStart(13)} ${formatHeap(result.heapDeltaBytes).padStart(9)} ${formatRatio(result.baselineRatio).padStart(8)}`,
      );
      if (result.phaseMeanMs) {
        console.log(`  split ${result.name}: ${formatPhaseMeans(result.phaseMeanMs)}`);
      }
      if (result.trialAggregate) {
        const { pooled } = result.trialAggregate;
        console.log(
          `  trials ${result.trialAggregate.count} ${result.trialAggregate.method}: pooled mean=${format(pooled.meanMs)}ms p95=${format(pooled.p95Ms)}ms`,
        );
      }
    }
  }
  if (!comparisons.length) return;

  console.log("");
  console.log("[comparison]");
  console.log(
    `${"scenario".padEnd(40)} ${"current".padStart(12)} ${"baseline".padStart(12)} ${"ratio".padStart(8)} ${"trim".padStart(8)} ${"median".padStart(8)} ${"gate".padStart(12)}`,
  );
  for (const comparison of comparisons) {
    console.log(
      `${`${comparison.layer} ${comparison.name}`.padEnd(40)} ${format(comparison.currentHz).padStart(12)} ${format(comparison.baselineHz).padStart(12)} ${formatRatio(comparison.ratio).padStart(8)} ${formatRatio(comparison.trimmedRatio).padStart(8)} ${formatRatio(comparison.medianRatio).padStart(8)} ${comparison.status.padStart(12)}`,
    );
  }
}

function format(value: number): string {
  if (value >= 1_000) return value.toFixed(0);
  if (value >= 100) return value.toFixed(1);
  return value.toFixed(3);
}

function formatRatio(value: number | undefined): string {
  if (value === undefined) return "";
  return `${value.toFixed(2)}x`;
}

function formatCache(result: BenchResult): string {
  if (result.cacheHits === undefined || result.cacheMisses === undefined) return "";
  return `${result.cacheHits}/${result.cacheMisses}`;
}

function formatHeap(value: number | undefined): string {
  if (value === undefined) return "";
  return format(value / 1024);
}

function formatPhaseMeans(phases: Partial<Record<string, number>>): string {
  return Object.keys(phases)
    .filter((phase) => phase !== "totalMs")
    .map((phase) => `${phase.replace(/Ms$/, "")}=${format(phases[phase] ?? 0)}ms`)
    .join(" ");
}

const oldBaselines = {
  indexedTake20: {
    hz: 6_554,
    name: "old executeLocal query indexed range + take 20",
  },
  mutationInsert: {
    hz: 7_175,
    name: "old executeLocal mutation insert",
  },
} as const;
