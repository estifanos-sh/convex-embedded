/**
 * Dedicated worker that exercises WAL truncation against OPFS. It runs inside
 * a Worker so OPFS sync access handles are available, opens the WASM store, writes enough rows to
 * grow the write-ahead log, reads the live `-wal` size through the store's own OPFS bridge before
 * and after `store.wal.write()`, then closes and reopens the same storage to confirm the
 * committed rows survived the truncation — with no live backend.
 */
import { makeFunctionReference } from "convex/server";

import { initRuntime } from "../../src/browser/runtime";

import napiWorkerUrl from "../../dist/thread/browser-worker.mjs?url";
import wasmUrl from "../../dist/wasm/index.wasm?url";

declare const Worker: new (
  url: URL | string,
  options: { name?: string; type: "module" },
) => {
  addEventListener(type: "message", callback: (event: unknown) => void): void;
  addEventListener(type: "error", callback: (event: unknown) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", callback: (event: unknown) => void): void;
};

const createDocument = makeFunctionReference<"mutation", Record<string, never>, { _id: string }>(
  "documents:create",
);
const listDocuments = makeFunctionReference<"query", { limit?: number }, { _id: string }[]>(
  "documents:list",
);

interface WalResult {
  walBefore: number;
  walAfter: number;
  rowsBefore: number;
  rowsAfterReopen: number;
}

const ROW_COUNT = 200;

self.onmessage = (event: MessageEvent<{ storageId: string }>) => {
  void run(event.data.storageId)
    .then((result) => self.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ok: false,
      }),
    );
};

async function run(storageId: string): Promise<WalResult> {
  const { embeddedSchema, modules } = await import("virtual:convex-embedded");
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`failed to load packaged WASM artifact: ${wasmResponse.status}`);
  }
  const wasmBytes = await wasmResponse.arrayBuffer();
  const storagePath = `convex-embedded-${storageId}.db`;
  const wasm = {
    bytes: wasmBytes,
    worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
  };

  const state = await initRuntime({
    modules,
    setupSchema: embeddedSchema.runtimeStoreSchema,
    storagePath,
    storeSchema: embeddedSchema.runtimeStoreSchema,
    wasm,
  });
  let walBefore = 0;
  let walAfter = 0;
  let rowsBefore = 0;
  try {
    for (let index = 0; index < ROW_COUNT; index += 1) {
      await state.runner.runMutation(createDocument, {});
    }
    rowsBefore = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
    walBefore = walSize(state.opfs, storagePath);
    await state.store.wal.write();
    walAfter = walSize(state.opfs, storagePath);
  } finally {
    await state.store.close().catch(() => undefined);
    state.opfs.closeAll();
  }

  const reopened = await initRuntime({
    modules,
    setupSchema: embeddedSchema.runtimeStoreSchema,
    storagePath,
    storeSchema: embeddedSchema.runtimeStoreSchema,
    wasm,
  });
  let rowsAfterReopen = 0;
  try {
    const rows = await reopened.runner.runQuery(listDocuments, { limit: ROW_COUNT + 10 });
    rowsAfterReopen = (rows as { _id: string }[]).length;
  } finally {
    await reopened.store.close().catch(() => undefined);
    reopened.opfs.closeAll();
  }

  return { rowsAfterReopen, rowsBefore, walAfter, walBefore };
}

function walSize(
  opfs: { getFileHandle(path: string): number | null; size(handle: number): number },
  storagePath: string,
): number {
  const handle = opfs.getFileHandle(`${storagePath}-wal`);
  if (handle === null) throw new Error("store did not register an OPFS write-ahead log handle");
  return opfs.size(handle);
}
