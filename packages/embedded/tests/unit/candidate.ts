import { describe, expect, test } from "vite-plus/test";

import { openCandidate, type CandidateSurface } from "../../src/candidate";
import type { StoreSetupCandidate } from "../../src/migrations";
import type { StorageBackend, StoreSchema } from "../../src/storage/types";
import { setupWorkspaceSchema } from "../../src/storage/workspace";

const source: StoreSchema = { hash: "source", tables: [] };
const target: StoreSchema = { hash: "target", setupHash: "setup", tables: [] };

function storeWithCandidate(
  prepared: StoreSetupCandidate,
  events: string[],
): {
  candidate: CandidateSurface;
  close(): Promise<void>;
  setup(schema: StoreSchema): Promise<void>;
} {
  return {
    candidate: {
      bind: async (schema, generation) => {
        events.push(`bind:${schema.hash}:${generation}`);
      },
      copy: async (generation) => {
        events.push(`copy:${generation}`);
        return { done: true, records: 0 };
      },
      complete: async (generation) => {
        events.push(`complete:${generation}`);
      },
      finalize: async (schema, generation) => {
        events.push(`finalize:${schema.hash}:${generation}`);
      },
      finalizePrepare: async (schema, generation) => {
        events.push(`finalizePrepare:${schema.hash}:${generation}`);
      },
      materialize: async (generation) => {
        events.push(`materialize:${generation}`);
        return { done: true, records: 0 };
      },
      policy: async (schema, generation) => {
        events.push(`policy:${schema.hash}:${generation}`);
        return { done: true, records: 0 };
      },
      prepare: async (schema) => {
        events.push(`prepare:${schema.hash}`);
        return prepared;
      },
      retire: async (generation) => {
        events.push(`retire:${generation}`);
        return { done: true, records: 0 };
      },
      unbind: async () => {
        events.push("unbind");
      },
      validate: async (schema, generation) => {
        events.push(`validate:${schema.hash}:${generation}`);
      },
    },
    close: async () => {
      events.push("close");
    },
    setup: async (schema) => {
      events.push(`setup:${schema.hash}`);
    },
  };
}

function prepared(overrides: Partial<StoreSetupCandidate> = {}): StoreSetupCandidate {
  return {
    activeGeneration: 1,
    generation: 2,
    required: true,
    resumed: false,
    retiredGenerations: [],
    setupComplete: true,
    sourceSchema: source,
    ...overrides,
  };
}

describe("candidate startup", () => {
  test("publishes an automatic package upgrade without application setup", async () => {
    const events: string[] = [];
    const store = storeWithCandidate(
      prepared({ retiredGenerations: [0], setupComplete: true }),
      events,
    );

    const opened = await openCandidate(store as unknown as StorageBackend, {
      createRunner: ({ schema, mode, remote }) => {
        events.push(`runner:${schema.hash}:${mode}:${String(remote)}`);
        return { schema };
      },
      localReady: async () => {
        events.push("ready");
      },
      remote: true,
      runnerSchema: target,
      targetSchema: target,
    });

    expect(events).toEqual([
      "prepare:target",
      "copy:2",
      "policy:target:2",
      "finalizePrepare:target:2",
      "bind:target:2",
      "materialize:2",
      "validate:target:2",
      "unbind",
      "finalize:target:2",
      "runner:target:active:true",
      "ready",
      "retire:0",
      "retire:1",
    ]);
    expect(opened.report).toEqual({
      activeGeneration: 1,
      candidateGeneration: 2,
      required: true,
      resumed: false,
      retiredGenerations: [0, 1],
    });
  });

  test("resumes setup in a remote-free workspace before exact-target validation", async () => {
    const events: string[] = [];
    const workspace = setupWorkspaceSchema(source, target);
    const store = storeWithCandidate(prepared({ resumed: true, setupComplete: false }), events);

    const opened = await openCandidate(store as unknown as StorageBackend, {
      createRunner: ({ schema, mode, remote }) => {
        events.push(`runner:${schema.hash}:${mode}:${String(remote)}`);
        return { mode, remote };
      },
      localReady: async () => {
        events.push("ready");
      },
      remote: true,
      runnerSchema: target,
      setup: {
        run: async (runner) => {
          events.push(`action:${runner.mode}:${String(runner.remote)}`);
        },
      },
      targetSchema: target,
    });

    expect(events).toEqual([
      "prepare:target",
      "copy:2",
      "policy:target:2",
      `bind:${workspace.hash}:2`,
      "materialize:2",
      `runner:${workspace.hash}:setup:false`,
      "ready",
      "action:setup:false",
      "complete:2",
      "unbind",
      "finalizePrepare:target:2",
      "bind:target:2",
      "materialize:2",
      "validate:target:2",
      "unbind",
      "finalize:target:2",
      "runner:target:active:true",
      "ready",
      "retire:1",
    ]);
    expect(opened.report.resumed).toBe(true);
  });

  test("unbinds but leaves caller-owned storage open when setup fails", async () => {
    const events: string[] = [];
    const workspace = setupWorkspaceSchema(source, target);
    const store = storeWithCandidate(prepared({ setupComplete: false }), events);

    await expect(
      openCandidate(store as unknown as StorageBackend, {
        createRunner: () => ({}),
        localReady: async () => undefined,
        remote: false,
        runnerSchema: target,
        setup: {
          run: async () => {
            events.push("action");
            throw new Error("setup failed");
          },
        },
        targetSchema: target,
      }),
    ).rejects.toThrow("setup failed");

    expect(events).toEqual([
      "prepare:target",
      "copy:2",
      "policy:target:2",
      `bind:${workspace.hash}:2`,
      "materialize:2",
      "action",
      "unbind",
    ]);
  });

  test("preserves the active generation when matching setup is absent", async () => {
    const events: string[] = [];
    const store = storeWithCandidate(prepared({ setupComplete: false }), events);

    await expect(
      openCandidate(store as unknown as StorageBackend, {
        createRunner: () => ({}),
        localReady: async () => undefined,
        remote: false,
        runnerSchema: target,
        targetSchema: target,
      }),
    ).rejects.toThrow("requires its matching setup action");

    expect(events).toEqual(["prepare:target", "copy:2", "policy:target:2"]);
  });

  test("constructs only a setup-mode runner before candidate publication", async () => {
    const events: string[] = [];
    const store = storeWithCandidate(prepared({ setupComplete: false }), events);

    await openCandidate(store as unknown as StorageBackend, {
      createRunner: ({ mode, remote }) => {
        events.push(`runner:${mode}:${String(remote)}`);
        return { mode };
      },
      localReady: async () => undefined,
      remote: true,
      runnerSchema: target,
      setup: {
        run: async (runner) => {
          expect(runner.mode).toBe("setup");
        },
      },
      targetSchema: target,
    });

    expect(events.filter((event) => event.startsWith("runner:"))).toEqual([
      "runner:setup:false",
      "runner:active:true",
    ]);
  });

  test("keeps warm open physical setup automatic", async () => {
    const events: string[] = [];
    const store = storeWithCandidate(prepared({ required: false }), events);

    await openCandidate(store as unknown as StorageBackend, {
      createRunner: () => {
        events.push("runner");
        return {};
      },
      localReady: async () => {
        events.push("ready");
      },
      remote: false,
      runnerSchema: target,
      targetSchema: target,
    });

    expect(events).toEqual(["prepare:target", "setup:target", "runner", "ready"]);
  });

  test("bounded-retires a stale candidate before preparing the requested target", async () => {
    const events: string[] = [];
    const store = storeWithCandidate(prepared(), events);
    let prepareCalls = 0;
    let retireCalls = 0;
    store.candidate.prepare = async (schema) => {
      events.push(`prepare:${schema.hash}`);
      prepareCalls += 1;
      return prepareCalls === 1
        ? prepared({ cleanupGeneration: 7, generation: 7, required: false })
        : prepared({ generation: 8 });
    };
    store.candidate.retire = async (generation) => {
      events.push(`retire:${generation}`);
      retireCalls += 1;
      return { done: retireCalls !== 1, records: retireCalls === 1 ? 512 : 0 };
    };

    const opened = await openCandidate(store as unknown as StorageBackend, {
      checkpoint: async (phase) => {
        events.push(`checkpoint:${phase}`);
      },
      createRunner: () => ({}),
      localReady: async () => undefined,
      progress: () => {
        events.push("progress");
      },
      remote: false,
      runnerSchema: target,
      targetSchema: target,
    });

    expect(events.slice(0, 12)).toEqual([
      "prepare:target",
      "progress",
      "checkpoint:prepare",
      "retire:7",
      "progress",
      "checkpoint:retire",
      "retire:7",
      "progress",
      "checkpoint:retire",
      "prepare:target",
      "progress",
      "checkpoint:prepare",
    ]);
    expect(opened.report.candidateGeneration).toBe(8);
    expect(opened.report.retiredGenerations).toEqual([1]);
  });
});
