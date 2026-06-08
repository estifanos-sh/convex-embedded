// Monotonic clock: now() never goes backward and is unique within a wall-clock ms (the float-ms value is the
// §3.2 HLC's wallClock; observe() is its remote-floor rule, reused here to recover the high-water mark on open).
const EPSILON = 1 / 64;

export interface Clock {
  now(): number;
  observe(t: number): void;
}

export function createClock(seed = 0, wall: () => number = () => Date.now()): Clock {
  let last = seed;
  return {
    now() {
      const w = wall();
      const next = w > last ? w : last + EPSILON;
      last = next;
      return next;
    },
    observe(t) {
      if (t > last) last = t;
    },
  };
}
