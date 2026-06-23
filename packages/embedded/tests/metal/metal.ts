import { describe, expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;

const remoteUrl = hostedRemoteUrl();

describe("browser metal remote sync", () => {
  test("converges document edits, conflicts, and snapshots across five browser devices", async () => {
    const result = await metalCommands().embeddedMetalDocumentsSync({
      remoteUrl,
      timeoutMs: 60_000,
    });

    expect(result.createIdStable).toBe(true);
    expect(result.conflictObserved).toBe(true);
    expect(result.deviceCount).toBe(5);
    expect(result.finalTitle.startsWith(`${result.runId}: offline edit from `)).toBe(true);
    expect(result.snapshotTitle).toBe(`${result.runId}: snapshot base`);
    expect(result.restoredTitle).toBe(result.snapshotTitle);
  }, 120_000);
});

function hostedRemoteUrl(): string {
  const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!url) {
    throw new Error("Set VITE_CONVEX_URL or CONVEX_URL in .env.local before running metal tests.");
  }
  return url;
}

function metalCommands(): {
  embeddedMetalDocumentsSync(options: MetalDocumentsSyncOptions): Promise<MetalDocumentsSyncResult>;
} {
  return commands as unknown as {
    embeddedMetalDocumentsSync(
      options: MetalDocumentsSyncOptions,
    ): Promise<MetalDocumentsSyncResult>;
  };
}

interface MetalDocumentsSyncOptions {
  remoteUrl: string;
  timeoutMs?: number;
}

interface MetalDocumentsSyncResult {
  conflictObserved: boolean;
  createIdStable: boolean;
  deviceCount: number;
  finalTitle: string;
  restoredTitle: string;
  runId: string;
  snapshotTitle: string;
}
