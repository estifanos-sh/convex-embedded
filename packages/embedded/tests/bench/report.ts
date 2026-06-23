export interface BenchSummary {
  hz: number;
  layer: string;
  meanMs: number;
  name: string;
  p95Ms: number;
}

export interface BenchBaseline {
  capturedAt: string;
  notes: string[];
  source: string;
  summaries: BenchSummary[];
  version: 1;
}

export function readBaseline(value: BenchBaseline): BenchBaseline {
  return value;
}
