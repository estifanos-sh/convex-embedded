import { embeddedSchema, modules } from "virtual:convex-embedded";

import { initRuntime } from "../../src/browser/runtime";
import napiWorkerUrl from "../../dist/thread/browser-worker.mjs?url";
import wasmUrl from "../../dist/wasm/index.wasm?url";

const body = JSON.stringify([
  { content: "Volume", props: { level: 1 }, type: "heading" },
  { content: "", type: "paragraph" },
]);

self.onmessage = (event: MessageEvent<Parameters<typeof seedBrowserVolume>[0]>) => {
  void seedBrowserVolume(event.data)
    .then(() => self.postMessage({ ok: true }))
    .catch((error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ok: false,
      }),
    );
};

export async function seedBrowserVolume(options: {
  batchSize?: number;
  prefix: string;
  rows: number;
  storageId: string;
}): Promise<void> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Failed to load benchmark WASM: ${response.status}.`);
  const schema = embeddedSchema.runtimeStoreSchema;
  const storagePath = `convex-embedded-${options.storageId}.db`;
  const state = await initRuntime({
    modules,
    setupSchema: schema,
    storagePath,
    storeSchema: schema,
    wasm: {
      bytes: await response.arrayBuffer(),
      worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
    },
  });
  try {
    const batchSize = options.batchSize ?? 10_000;
    for (let start = 0; start < options.rows; start += batchSize) {
      const end = Math.min(options.rows, start + batchSize);
      await state.store.commit(
        {
          deletes: [],
          docWrites: Array.from({ length: end - start }, (_, offset) => {
            const sequence = start + offset;
            return {
              cols: {
                idx_slug: `${options.prefix}${sequence.toString(36)}`,
                idx_updated_at: -sequence - 1,
              },
              creationTime: sequence + 1,
              data: {
                body,
                slug: `${options.prefix}${sequence.toString(36)}`,
                title: `${options.prefix}row-${sequence}`,
                updatedAt: -sequence - 1,
              },
              id: `documents|${sequence.toString(16).padStart(32, "0")}`,
              table: "documents",
            };
          }),
        },
        { changes: "include", source: "remote" },
      );
    }
    await state.store.wal.write();
  } finally {
    await state.store.close().catch(() => undefined);
    state.opfs.closeAll();
  }
}
