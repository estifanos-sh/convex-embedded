import { describe, expect, test } from "vite-plus/test";

import { startRemoteLoop } from "../../src/client";
import type { EmbeddedInternalEvent } from "../../src/events";
import type { Runner } from "../../src/runtime/runner";
import type { RemoteSurface, RemoteTick } from "../../src/storage/types";

const RETIRED_MESSAGE =
  "remote client retired: embedded:push failed: Embedded remote client has been permanently retired.";

function emptyTick(): RemoteTick {
  return {
    changedResults: [],
    changedTables: [],
    pullAttempted: 0,
    pullDiagnostics: 0,
    pullChangesApplied: 0,
    pullSnapshots: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushRebases: 0,
    pushed: 0,
    pushFailed: 0,
    received: 0,
    reconnected: false,
    retainedRevisions: [],
    rowsApplied: 0,
    sent: 0,
    receiptsPushed: 0,
    storeJobs: 0,
  };
}

const idleRunner = { subscribeEvents: () => () => undefined } as unknown as Runner;

const noopIdentity = async (): Promise<void> => undefined;

describe("node remote loop client retirement", () => {
  test("rotates a retired client once with a fresh id, then resumes", async () => {
    const events: EmbeddedInternalEvent[] = [];
    let clientId = "client_0";
    let retired = true;
    let pulls = 0;
    let rotations = 0;
    const remote = {
      pull: async () => {
        pulls += 1;
        if (retired) throw new Error(RETIRED_MESSAGE);
        return emptyTick();
      },
    } as unknown as RemoteSurface;

    const stop = startRemoteLoop(
      remote,
      idleRunner,
      noopIdentity,
      (event) => events.push(event),
      async () => {
        rotations += 1;
        clientId = `client_${rotations}`;
        retired = false;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();

    expect(rotations).toBe(1);
    expect(clientId).toBe("client_1");
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("retired"),
        status: "error",
        type: "remote",
      }),
    );
  });

  test("trips the breaker on the fourth rapid retirement and stops rotating", async () => {
    const events: EmbeddedInternalEvent[] = [];
    let rotations = 0;
    const remote = {
      pull: async () => {
        throw new Error(RETIRED_MESSAGE);
      },
    } as unknown as RemoteSurface;

    const stop = startRemoteLoop(
      remote,
      idleRunner,
      noopIdentity,
      (event) => events.push(event),
      async () => {
        rotations += 1;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();

    expect(rotations).toBe(3);
    const retirementSignals = events.filter(
      (event) =>
        event.type === "remote" &&
        event.status === "error" &&
        typeof event.error === "string" &&
        event.error.includes("retired"),
    );
    expect(retirementSignals.length).toBe(4);
  });
});
