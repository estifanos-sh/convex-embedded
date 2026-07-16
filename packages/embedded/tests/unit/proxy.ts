import { describe, expect, test, vi } from "vite-plus/test";

import type { EmbeddedEvent } from "../../src/events";
import { WorkerRunner } from "../../src/browser/proxy";
import { WorkerEvent, type EmbeddedWorker } from "../../src/browser/protocol";

interface FakeWorker extends EmbeddedWorker {
  emit(type: "error" | "message" | "messageerror", event: unknown): void;
  requests: Array<{ id?: number }>;
  terminated: boolean;
}

function fakeWorker(): FakeWorker {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    requests: [],
    terminated: false,
    addEventListener(type: string, callback: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(callback);
      listeners.set(type, set);
    },
    removeEventListener(type: string, callback: (event: unknown) => void) {
      listeners.get(type)?.delete(callback);
    },
    postMessage(message) {
      this.requests.push(message as { id?: number });
    },
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
  test("releases external ownership whenever the runner is disposed", () => {
    const worker = fakeWorker();
    let releases = 0;
    const runner = new WorkerRunner(worker, {
      onDispose: () => {
        releases += 1;
      },
      storagePath: "test.db",
    });

    runner.terminate();
    runner.terminate();

    expect(releases).toBe(1);
  });

  test("a terminal store event disposes the runner and releases page ownership", async () => {
    const worker = fakeWorker();
    let releases = 0;
    const runner = new WorkerRunner(worker, {
      onDispose: () => {
        releases += 1;
      },
      storagePath: "test.db",
    });

    worker.emit("message", {
      data: {
        error: { message: "store instance is terminal", name: "StoreTerminalError" },
        op: WorkerEvent.Terminal,
      },
    });

    expect(worker.terminated).toBe(true);
    expect(releases).toBe(1);
    await expect(runner.initialized()).rejects.toMatchObject({
      message: "store instance is terminal",
      name: "StoreTerminalError",
    });
  });

  test("terminates synchronously during page teardown", async () => {
    const worker = fakeWorker();
    const runner = new WorkerRunner(worker, { storagePath: "test.db" });
    const initialized = runner.initialized();

    runner.terminate();

    expect(worker.terminated).toBe(true);
    await expect(initialized).rejects.toThrow("terminated during page teardown");
  });

  test("uses the dedicated initialization timeout instead of the ordinary request timeout", async () => {
    const worker = fakeWorker();
    const runner = new WorkerRunner(worker, {
      initTimeoutMs: 40,
      requestTimeoutMs: 5,
      storagePath: "test.db",
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(worker.terminated).toBe(false);
    await expect(runner.initialized()).rejects.toThrow('request "init" timed out after 40ms');
    expect(worker.terminated).toBe(true);
  });

  test("treats initialization timeout as a no-progress watchdog", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      const runner = new WorkerRunner(worker, {
        initTimeoutMs: 15_000,
        storagePath: "test.db",
      });
      const initialized = runner.initialized();

      await vi.advanceTimersByTimeAsync(14_900);
      worker.emit("message", {
        data: {
          event: { at: 14_900, phase: "store-open", type: "runtime" },
          op: WorkerEvent.Event,
        },
      });
      await vi.advanceTimersByTimeAsync(14_900);
      expect(worker.terminated).toBe(false);

      worker.emit("message", {
        data: {
          event: { at: 29_800, attempt: 1, status: "started", type: "remote" },
          op: WorkerEvent.Event,
        },
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(initialized).rejects.toThrow(
        'request "init" timed out after 15000ms without progress',
      );
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not refresh ordinary request timeouts from runtime progress", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      const runner = new WorkerRunner(worker, {
        initTimeoutMs: 1_000,
        requestTimeoutMs: 50,
        storagePath: "test.db",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", {
        data: { id: worker.requests[0]?.id, op: WorkerEvent.Result },
      });
      await runner.initialized();

      const read = runner.identity.read();
      const rejected = expect(read).rejects.toThrow('request "identityRead" timed out after 50ms.');
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(49);
      worker.emit("message", {
        data: {
          event: { at: 49, phase: "store-wal-write", type: "runtime" },
          op: WorkerEvent.Event,
        },
      });
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(worker.terminated).toBe(false);
      runner.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

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
