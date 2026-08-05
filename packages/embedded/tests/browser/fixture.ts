import { describe, expect, test } from "vite-plus/test";

import fixtureManifest from "../../../../crates/storage/tests/fixtures/preview2/manifest.json";

type WorkerMessage = { error: string; ok: false } | { ok: true; result: unknown };

describe("Preview2 production fixture", () => {
  test("opens, migrates, and warm-reopens exact bytes through WASM and OPFS", async () => {
    const storageId = `preview2-packed-${crypto.randomUUID()}`;
    const worker = new Worker(new URL("./boot.ts", import.meta.url), { type: "module" });
    try {
      await request(worker, { op: "fixtureInstall", storageId });
      localStorage.setItem("convex-embedded.storageId", storageId);
      await openPackedClient();
      await openPackedClient();
      const inspected = await request<{ oracle: unknown }>(worker, {
        op: "fixtureInspect",
        storageId,
      });
      expect(inspected.oracle).toEqual(fixtureManifest.portableOracle);
    } finally {
      worker.terminate();
    }
  }, 130_000);

  test("resumes after the candidate worker is terminated during target materialization", async () => {
    const storageId = `preview2-kill-${crypto.randomUUID()}`;
    const wounded = new Worker(new URL("./boot.ts", import.meta.url), { type: "module" });
    try {
      const prepared = await request<{ phase: "materialize"; wounding: true }>(wounded, {
        op: "candidateWound",
        storageId,
      });
      expect(prepared.phase).toBe("materialize");
    } finally {
      wounded.terminate();
    }

    const resumed = new Worker(new URL("./boot.ts", import.meta.url), { type: "module" });
    try {
      const result = await request<{ oracle: unknown }>(resumed, {
        op: "fixtureResume",
        storageId,
      });
      expect(result.oracle).toBeDefined();
    } finally {
      resumed.terminate();
    }
  }, 130_000);
});

async function openPackedClient(): Promise<void> {
  const { ConvexEmbeddedClient } = await import("../../dist/browser.mjs");
  const client = new ConvexEmbeddedClient();
  try {
    await client.open();
  } finally {
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
}

async function request<T>(worker: Worker, message: unknown): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Preview2 fixture worker timed out")),
      120_000,
    );
    worker.onmessage = (event: MessageEvent<WorkerMessage & { result?: T }>) => {
      clearTimeout(timeout);
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || "Preview2 fixture worker failed"));
    };
    worker.postMessage(message);
  });
}
