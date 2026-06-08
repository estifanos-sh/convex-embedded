import { describe, expect, test } from "vitest";

import { createClock } from "../src/storage/clock";

describe("clock", () => {
  test("is strictly increasing within one wall-clock instant", () => {
    const clock = createClock(0, () => 1000);
    const a = clock.now();
    const b = clock.now();
    const c = clock.now();
    expect(a).toBe(1000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  test("never goes backward when the wall clock steps back", () => {
    let wall = 5000;
    const clock = createClock(0, () => wall);
    const a = clock.now();
    wall = 4000;
    const b = clock.now();
    expect(b).toBeGreaterThan(a);
  });

  test("observe floors the clock to a recovered high-water mark", () => {
    const clock = createClock(0, () => 1000);
    clock.observe(9000);
    expect(clock.now()).toBeGreaterThanOrEqual(9000);
  });
});
