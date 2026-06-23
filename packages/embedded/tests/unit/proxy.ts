import { describe, expect, test } from "vite-plus/test";

import type { EmbeddedEvent } from "../../src/events";
import { WorkerRunner } from "../../src/browser/proxy";
import type { EmbeddedWorker } from "../../src/browser/protocol";

interface FakeWorker extends EmbeddedWorker {
  emit(type: "error" | "messageerror", event: unknown): void;
  terminated: boolean;
}

function fakeWorker(): FakeWorker {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    terminated: false,
    addEventListener(type: string, callback: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(callback);
      listeners.set(type, set);
    },
    removeEventListener(type: string, callback: (event: unknown) => void) {
      listeners.get(type)?.delete(callback);
    },
    postMessage() {},
    start() {},
    terminate() {
      this.terminated = true;
    },
    close() {},
    emit(type, event) {
      for (const callback of listeners.get(type) ?? []) callback(event);
    },
  } as FakeWorker;
}

describe("worker runner death surfacing", () => {
  test("surfaces a runtime failed event when the worker errors", () => {
    const worker = fakeWorker();
    const runner = new WorkerRunner(worker);
    const events: EmbeddedEvent[] = [];
    runner.subscribeEvents((event) => events.push(event));

    worker.emit("error", {
      colno: 7,
      filename: "browser-worker-abc123.mjs",
      lineno: 42,
      message: "RuntimeError: unreachable executed",
      type: "error",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        degradation: "failed",
        type: "runtime",
      }),
    );
    const runtimeEvent = events.find((event) => event.type === "runtime");
    expect(runtimeEvent && "error" in runtimeEvent ? runtimeEvent.error : undefined).toContain(
      "unreachable executed",
    );
    expect(worker.terminated).toBe(true);
  });

  test("surfaces a runtime failed event when the worker posts a messageerror", () => {
    const worker = fakeWorker();
    const runner = new WorkerRunner(worker);
    const events: EmbeddedEvent[] = [];
    runner.subscribeEvents((event) => events.push(event));

    worker.emit("messageerror", { type: "messageerror" });

    expect(events.filter((event) => event.type === "runtime")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ degradation: "failed", type: "runtime" }),
    );
  });
});
