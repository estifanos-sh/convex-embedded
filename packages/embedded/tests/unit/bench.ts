import { describe, expect, test } from "vite-plus/test";

import { benchEnv, benchValue } from "../../scripts/benchargs.js";
import { trialAggregate, trialRead } from "../bench/harness/trials.js";

describe("benchmark trials", () => {
  test("uses medians of independent trials for gates and retains pooled diagnostics", () => {
    const aggregate = trialAggregate([
      measurement([1, 1, 1, 1, 2], { cacheHits: 2, phaseMeanMs: { commitMs: 1 } }),
      measurement([10, 10, 10, 10, 20], { cacheHits: 20, phaseMeanMs: { commitMs: 10 } }),
      measurement([2, 2, 2, 2, 3], { cacheHits: 3, phaseMeanMs: { commitMs: 2 } }),
    ]);

    expect(aggregate.metrics.p95Ms).toBe(3);
    expect(aggregate.metrics.cacheHits).toBe(3);
    expect(aggregate.metrics.phaseMeanMs).toEqual({ commitMs: 2 });
    expect(aggregate.metrics.samplesMs).toHaveLength(15);
    expect(aggregate.aggregate).toMatchObject({ count: 3, method: "median-per-trial" });
    expect(aggregate.aggregate.runs.map((run) => run.p95Ms)).toEqual([2, 20, 3]);
    expect(aggregate.aggregate.runs[0]).not.toHaveProperty("samplesMs");
    expect(aggregate.aggregate.pooled).toMatchObject({ p95Ms: 20, samples: 15 });
  });

  test("uses the conventional midpoint for an even number of trials", () => {
    const aggregate = trialAggregate([measurement([1, 1]), measurement([3, 3])]);

    expect(aggregate.metrics.meanMs).toBe(2);
    expect(aggregate.metrics.medianMs).toBe(2);
    expect(aggregate.metrics.p95Ms).toBe(2);
    expect(aggregate.metrics.hz).toBeCloseTo((1_000 + 1_000 / 3) / 2);
  });

  test("requires a nonempty, valid sample set", () => {
    expect(() => trialRead([])).toThrow("at least one sample");
    expect(() => trialRead([1, -1])).toThrow("finite, non-negative");
  });
});

describe("benchmark arguments", () => {
  test("forwards repeated-trial configuration without mutating its source environment", () => {
    const source = { EXISTING: "value", NODE_ENV: "test" };
    const env = benchEnv(["--layer", "runtime-hot", "--trials", "3", "--warmups", "20"], source);

    expect(env).toMatchObject({
      EMBEDDED_BENCH_LAYER: "runtime-hot",
      EMBEDDED_BENCH_TRIALS: "3",
      EMBEDDED_BENCH_WARMUPS: "20",
      EXISTING: "value",
      NODE_ENV: "test",
    });
    expect(source).toEqual({ EXISTING: "value", NODE_ENV: "test" });
    expect(benchValue(["--trials", "3"], "--trials")).toBe("3");
    expect(() => benchEnv(["--trials"], { NODE_ENV: "test" })).toThrow("--trials requires a value");
  });
});

function measurement(
  samplesMs: readonly number[],
  extra: {
    cacheHits?: number;
    phaseMeanMs?: Partial<Record<string, number>>;
  } = {},
) {
  return { ...trialRead(samplesMs), samplesMs, ...extra };
}
