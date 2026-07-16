import { expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

import type { EmbeddedWorker } from "../../src/browser/protocol";
import { WorkerRunner } from "../../src/browser/proxy";
import { getTimerTime } from "../../src/time";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;

test("reconnects an offline mutation, pulls authority, and retains the conflict revision", async () => {
  const remoteUrl = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!remoteUrl) throw new Error("Browser protocol tests require a hosted Convex deployment.");
  const runId = `offline-protocol-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const result = await browserCommands().embeddedOfflineConflictReconnect(remoteUrl, runId);
  console.info(
    `[embedded protocol reconnect] ${JSON.stringify({
      authorityMs: result.conflictAuthorityMs,
      connectedMs: result.conflictConnectedMs,
      idleMs: result.conflictIdleMs,
      startingMs: result.conflictStartingMs,
    })}`,
  );
  expect(result.title).toBe(`${runId}:authoritative`);
  expect(result.revisions).toBeGreaterThan(0);
  expect(result.offlineHintMs).toBeLessThan(2_000);
  expect(result.offlineRemoteState).toBe("offline");
  expect(result.onlineHintMs).toBeLessThan(2_000);
  expect(result.conflictStartingMs).toBeLessThan(2_000);
  expect(result.conflictConnectedMs).toBeGreaterThanOrEqual(result.conflictStartingMs);
  expect(result.conflictAuthorityMs).toBeGreaterThanOrEqual(result.conflictConnectedMs);
  expect(result.conflictIdleMs).toBeGreaterThanOrEqual(result.conflictAuthorityMs);
  expect(result.offlineStatuses).toContain("offline");
  expect(result.conflictStatuses).toContain("offline");
  expect(result.conflictStatuses).toContain("connected");
  expect(result.conflictStatuses).toContain("idle");
  const offlineIndex = result.offlineStatuses.indexOf("offline");
  expect(result.offlineStatuses.slice(offlineIndex + 1)).not.toContain("connected");
  expect(result.offlineStatuses.slice(offlineIndex + 1)).not.toContain("idle");
  const conflictOffline = result.conflictStatuses.indexOf("offline");
  const conflictStarting = result.conflictStatuses.indexOf("starting", conflictOffline + 1);
  const conflictConnected = result.conflictStatuses.indexOf("connected", conflictStarting + 1);
  const conflictIdle = result.conflictStatuses.indexOf("idle", conflictConnected + 1);
  expect(conflictStarting).toBeGreaterThan(conflictOffline);
  expect(conflictConnected).toBeGreaterThan(conflictStarting);
  expect(conflictIdle).toBeGreaterThan(conflictConnected);
  expect(result.observed).toEqual({
    revisions: expect.any(Number),
    title: `${runId}:authoritative`,
  });
}, 70_000);

test("hidden and terminated owners release storage to convergent followers", async () => {
  const remoteUrl = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!remoteUrl) throw new Error("Browser protocol tests require a hosted Convex deployment.");
  const runId = `owner-handoff-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const result = await browserCommands().embeddedOwnerHandoff(remoteUrl, runId);

  if (result.temporaryStorage) {
    expect(result.incumbent.incarnation).toBe(result.replacement.incarnation);
  } else {
    expect(result.incumbent.incarnation).not.toBe(result.replacement.incarnation);
  }
  expect(result.incumbent.sequence).toBeGreaterThan(1);
  expect(result.replacement.firstSequence).toBe(1);
  expect(result.replacement.status).toBe("idle");
  expect(result.lateTitle).toBe(`${runId}:follower`);
  expect(result.replacement.incarnation).not.toBe(result.secondReplacement.incarnation);
  expect(result.secondReplacement.firstSequence).toBe(1);
  expect(result.secondReplacement.status).toBe("idle");
  expect(result.finalTitle).toBe(`${runId}:terminated-follower`);
}, 70_000);

test("a silent worker fails initialization generically before 30 seconds", async () => {
  const worker: EmbeddedWorker = {
    addEventListener() {},
    close() {},
    postMessage() {},
    removeEventListener() {},
    start() {},
    terminate() {},
  };
  const runner = new WorkerRunner(worker, { storagePath: "silent-init.db" });
  const startedAt = getTimerTime();
  let failure: unknown;
  try {
    await runner.initialized();
  } catch (error) {
    failure = error;
  }
  const elapsed = getTimerTime() - startedAt;
  const message = failure instanceof Error ? failure.message : String(failure);

  expect(failure).toBeInstanceOf(Error);
  expect(elapsed).toBeLessThan(30_000);
  expect(message).toContain('request "init" timed out');
  expect(message).not.toMatch(/safari|webkit|ipad|iphone/i);
}, 20_000);

interface BrowserProtocolCommands {
  embeddedOfflineConflictReconnect(
    remoteUrl: string,
    runId: string,
  ): Promise<{
    conflictAuthorityMs: number;
    conflictConnectedMs: number;
    conflictIdleMs: number;
    conflictStartingMs: number;
    conflictStatuses: Array<string | undefined>;
    observed: { revisions: number; title: string };
    offlineHintMs: number;
    offlineRemoteState: string;
    offlineStatuses: Array<string | undefined>;
    onlineHintMs: number;
    revisions: number;
    title: string;
  }>;
  embeddedOwnerHandoff(
    remoteUrl: string,
    runId: string,
  ): Promise<{
    finalTitle: string;
    incumbent: {
      generation?: number;
      incarnation: string;
      sequence?: number;
      status: string;
    };
    lateTitle: string;
    replacement: {
      firstSequence?: number;
      generation?: number;
      incarnation: string;
      sequence?: number;
      status: string;
    };
    secondReplacement: {
      firstSequence?: number;
      generation?: number;
      incarnation: string;
      sequence?: number;
      status: string;
    };
    temporaryStorage: boolean;
  }>;
}

function browserCommands(): BrowserProtocolCommands {
  return commands as unknown as BrowserProtocolCommands;
}
