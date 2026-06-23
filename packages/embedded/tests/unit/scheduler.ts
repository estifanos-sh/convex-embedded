import { describe, expect, test } from "vite-plus/test";

import { isEmbeddedError } from "../../src/error";
import { createSchedulerService } from "../../src/runtime/scheduler";
import type { RuntimeCalls } from "../../src/runtime/service";
import type { RuntimeStorageWriter, ScheduledFunctionKind } from "../../src/storage/types";

function fakeStore(): RuntimeStorageWriter {
  return {
    schedule: { write: async () => undefined },
  } as unknown as RuntimeStorageWriter;
}

function fakeCalls(kind: ScheduledFunctionKind): RuntimeCalls {
  return {
    kind: async () => kind,
    runMutation: async () => undefined,
    runQuery: async () => undefined,
    runAction: async () => undefined,
  };
}

describe("local-only scheduled actions", () => {
  test("scheduling an action without a remote action runtime is unsupported", async () => {
    const scheduler = createSchedulerService(
      fakeStore(),
      () => undefined,
      fakeCalls("action"),
      false,
    );
    let thrown: unknown;
    await scheduler.runAfter(0, "jobs:doWork").catch((error) => {
      thrown = error;
    });
    expect(isEmbeddedError(thrown, "EMBEDDED_UNSUPPORTED")).toBe(true);
  });

  test("scheduling a mutation is always allowed", async () => {
    const scheduler = createSchedulerService(
      fakeStore(),
      () => undefined,
      fakeCalls("mutation"),
      false,
    );
    expect(typeof (await scheduler.runAfter(0, "jobs:tidy"))).toBe("string");
  });

  test("a remote action runtime permits scheduled actions", async () => {
    const scheduler = createSchedulerService(
      fakeStore(),
      () => undefined,
      fakeCalls("action"),
      true,
    );
    expect(typeof (await scheduler.runAfter(0, "jobs:doWork"))).toBe("string");
  });
});
