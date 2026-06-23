type MonotonicClock = {
  now(): number;
};

/**
 * Monotonic milliseconds for elapsed-time measurement.
 *
 * @remarks
 * The wall clock is never trusted anywhere in embedded (contract §1). Absolute time is the storage
 * HLC (`store.clock.read()`); every duration and telemetry timestamp uses this monotonic reading.
 */
export function getTimerTime(): number {
  return (globalThis as { performance: MonotonicClock }).performance.now();
}

export function getElapsedTime(startedAt: number): number {
  return Math.max(0, Math.trunc(getTimerTime() - startedAt));
}
