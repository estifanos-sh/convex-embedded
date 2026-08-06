export interface TrialTiming {
  readonly headMeanMs: number;
  readonly hz: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly medianHz: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly relativeStddev: number;
  readonly stddevMs: number;
  readonly tailMeanMs: number;
  readonly totalMs: number;
  readonly trimmedHz: number;
  readonly trimmedMeanMs: number;
}

export interface TrialMeasurement extends TrialTiming {
  readonly cacheBytes?: number;
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  readonly heapBytesPerOp?: number;
  readonly heapDeltaBytes?: number;
  readonly phaseMeanMs?: Readonly<Partial<Record<string, number>>>;
  readonly samplesMs: readonly number[];
}

export interface TrialSummary extends TrialTiming {
  readonly samples: number;
}

export interface TrialAggregate {
  readonly count: number;
  readonly method: "median-per-trial";
  readonly pooled: TrialSummary;
  readonly runs: readonly TrialSummary[];
}

export interface TrialAggregateResult {
  readonly aggregate: TrialAggregate;
  readonly metrics: TrialMeasurement;
}

/**
 * Reads latency metrics from one measured run. The input remains in arrival
 * order so head/tail measurements retain their warm-up signal; percentile and
 * trimmed measurements use a sorted copy.
 */
export function trialRead(samplesMs: readonly number[]): TrialTiming {
  if (samplesMs.length === 0) throw new Error("A benchmark trial needs at least one sample.");
  if (samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Benchmark samples must be finite, non-negative milliseconds.");
  }

  const sortedSamples = [...samplesMs].sort((left, right) => left - right);
  const totalMs = sum(samplesMs);
  const meanMs = totalMs / samplesMs.length;
  const trimmedMeanMs = mean(trialTrim(sortedSamples, 0.1));
  const medianMs = trialPercentile(sortedSamples, 0.5);
  const stddevMs = stddev(samplesMs, meanMs);
  const edge = Math.max(1, Math.ceil(samplesMs.length * 0.1));

  return {
    headMeanMs: mean(samplesMs.slice(0, edge)),
    hz: totalMs > 0 ? samplesMs.length / (totalMs / 1_000) : 0,
    maxMs: sortedSamples.at(-1) ?? 0,
    meanMs,
    medianHz: medianMs > 0 ? 1_000 / medianMs : 0,
    medianMs,
    minMs: sortedSamples[0] ?? 0,
    p90Ms: trialPercentile(sortedSamples, 0.9),
    p95Ms: trialPercentile(sortedSamples, 0.95),
    p99Ms: trialPercentile(sortedSamples, 0.99),
    relativeStddev: meanMs > 0 ? stddevMs / meanMs : 0,
    stddevMs,
    tailMeanMs: mean(samplesMs.slice(-edge)),
    totalMs,
    trimmedHz: trimmedMeanMs > 0 ? 1_000 / trimmedMeanMs : 0,
    trimmedMeanMs,
  };
}

/**
 * Makes a repeated benchmark's public metrics robust to a single noisy run.
 * The public scalar metrics are medians of independently-created trials, while
 * the original samples are pooled only for diagnostic reporting.
 */
export function trialAggregate(trials: readonly TrialMeasurement[]): TrialAggregateResult {
  if (trials.length === 0) throw new Error("A benchmark aggregate needs at least one trial.");

  const pooledSamples = trials.flatMap((trial) => trial.samplesMs);
  const timing = medianTiming(trials);
  const metrics: TrialMeasurement = {
    cacheBytes: optionalMedian(trials.map((trial) => trial.cacheBytes)),
    cacheHits: optionalMedian(trials.map((trial) => trial.cacheHits)),
    cacheMisses: optionalMedian(trials.map((trial) => trial.cacheMisses)),
    heapBytesPerOp: optionalMedian(trials.map((trial) => trial.heapBytesPerOp)),
    heapDeltaBytes: optionalMedian(trials.map((trial) => trial.heapDeltaBytes)),
    phaseMeanMs: phaseMedian(trials),
    samplesMs: pooledSamples,
    ...timing,
  };

  return {
    aggregate: {
      count: trials.length,
      method: "median-per-trial",
      pooled: trialSummary(trialRead(pooledSamples), pooledSamples.length),
      runs: trials.map((trial) => trialSummary(trialRead(trial.samplesMs), trial.samplesMs.length)),
    },
    metrics,
  };
}

function medianTiming(trials: readonly TrialTiming[]): TrialTiming {
  return {
    headMeanMs: median(trials.map((trial) => trial.headMeanMs)),
    hz: median(trials.map((trial) => trial.hz)),
    maxMs: median(trials.map((trial) => trial.maxMs)),
    meanMs: median(trials.map((trial) => trial.meanMs)),
    medianHz: median(trials.map((trial) => trial.medianHz)),
    medianMs: median(trials.map((trial) => trial.medianMs)),
    minMs: median(trials.map((trial) => trial.minMs)),
    p90Ms: median(trials.map((trial) => trial.p90Ms)),
    p95Ms: median(trials.map((trial) => trial.p95Ms)),
    p99Ms: median(trials.map((trial) => trial.p99Ms)),
    relativeStddev: median(trials.map((trial) => trial.relativeStddev)),
    stddevMs: median(trials.map((trial) => trial.stddevMs)),
    tailMeanMs: median(trials.map((trial) => trial.tailMeanMs)),
    totalMs: median(trials.map((trial) => trial.totalMs)),
    trimmedHz: median(trials.map((trial) => trial.trimmedHz)),
    trimmedMeanMs: median(trials.map((trial) => trial.trimmedMeanMs)),
  };
}

function trialSummary(timing: TrialTiming, samples: number): TrialSummary {
  return {
    headMeanMs: timing.headMeanMs,
    hz: timing.hz,
    maxMs: timing.maxMs,
    meanMs: timing.meanMs,
    medianHz: timing.medianHz,
    medianMs: timing.medianMs,
    minMs: timing.minMs,
    p90Ms: timing.p90Ms,
    p95Ms: timing.p95Ms,
    p99Ms: timing.p99Ms,
    relativeStddev: timing.relativeStddev,
    samples,
    stddevMs: timing.stddevMs,
    tailMeanMs: timing.tailMeanMs,
    totalMs: timing.totalMs,
    trimmedHz: timing.trimmedHz,
    trimmedMeanMs: timing.trimmedMeanMs,
  };
}

function phaseMedian(
  trials: readonly TrialMeasurement[],
): Readonly<Partial<Record<string, number>>> | undefined {
  if (trials.some((trial) => trial.phaseMeanMs === undefined)) return undefined;
  const phases = trials.map((trial) => trial.phaseMeanMs!);
  const names = [...new Set(phases.flatMap((phase) => Object.keys(phase)))].sort();
  const result: Partial<Record<string, number>> = {};
  for (const name of names) {
    const values = phases.map((phase) => phase[name]);
    const value = optionalMedian(values);
    if (value === undefined) return undefined;
    result[name] = value;
  }
  return result;
}

function optionalMedian(values: readonly (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  return median(values as readonly number[]);
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate a median of no values.");
  const sorted = [...values].sort((left, right) => left - right);
  const right = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[right] ?? 0;
  return ((sorted[right - 1] ?? 0) + (sorted[right] ?? 0)) / 2;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
  return sum(values) / values.length;
}

function stddev(values: readonly number[], average: number): number {
  const variance =
    values.reduce((total, value) => {
      const delta = value - average;
      return total + delta * delta;
    }, 0) / values.length;
  return Math.sqrt(variance);
}

function trialTrim(sortedSamples: readonly number[], fraction: number): readonly number[] {
  if (sortedSamples.length < 3) return sortedSamples;
  const trim = Math.min(
    Math.floor(sortedSamples.length / 2) - 1,
    Math.floor(sortedSamples.length * fraction),
  );
  return sortedSamples.slice(trim, sortedSamples.length - trim);
}

function trialPercentile(sortedSamples: readonly number[], percent: number): number {
  const index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * percent) - 1);
  return sortedSamples[index] ?? 0;
}
