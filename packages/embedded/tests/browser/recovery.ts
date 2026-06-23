/**
 * Dedicated worker for the store-instance recovery harness. It exercises the detect -> rebuild ->
 * graft loop end-to-end against a real WASM store and its real emnapi pthread pool, with no server
 * and no coordinator so the case is self-contained and deployment-free.
 *
 * Flow (`op: "recover"`):
 * - opens a runtime, seeds rows, and installs a {@link StoreRecovery} with short deadlines whose
 *   `rebuild` host action runs the runtime's in-place graft;
 * - arms a lane and `terminate()`s the whole pthread pool mid-flight, wedging the instance so the
 *   progress-based watchdog fires;
 * - waits for the graft to complete, then commits a fresh mutation on the grafted runner and reads
 *   the row count back to prove the seeded data survived and the new instance is usable.
 *
 * The "reaches the server post-rebuild" clause of case A, the proxy-30s race of case B, and the
 * two-tab lease-promotion of case C need a live deployment plus the coordinator and are asserted
 * (skipped) by the driver in runtime.ts, not here.
 */
import { makeFunctionReference } from "convex/server";

import type { WasmSource } from "../../src/browser/artifact";
import { initRuntime } from "../../src/browser/runtime";
import { StoreRecovery, type RecoveryHost } from "../../src/browser/recovery";
import { analyzeEmbeddedSchema } from "../../src/schema";
import { getTimerTime } from "../../src/time";

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
  terminate(): void;
};

const createDocument = makeFunctionReference<
  "mutation",
  { body: string; slug: string; title: string; updatedAt: number },
  { _id: string }
>("documents:create");

interface RecoverRequest {
  op: "recover";
  storageId: string;
  rows: number;
}

interface RecoverResult {
  rebuilt: boolean;
  degraded: boolean;
  ready: boolean;
  dead: boolean;
  rowsBefore: number;
  rowsAfter: number;
  pthreadsBefore: number;
  pthreadsAfter: number;
}

self.onmessage = (event: MessageEvent<RecoverRequest>) => {
  void recover(event.data)
    .then((result) => self.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ok: false,
      }),
    );
};

async function loadModules(): Promise<{
  modules: Awaited<typeof import("virtual:convex-embedded")>["modules"];
  schema: Awaited<typeof import("virtual:convex-embedded")>["schema"];
  wasm: WasmSource;
}> {
  const { schema, modules } = await import("virtual:convex-embedded");
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`failed to load packaged WASM artifact: ${wasmResponse.status}`);
  }
  const wasmBytes = await wasmResponse.arrayBuffer();
  return {
    modules,
    schema,
    wasm: {
      bytes: wasmBytes,
      worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
    },
  };
}

async function recover(request: RecoverRequest): Promise<RecoverResult> {
  const { modules, schema, wasm } = await loadModules();
  const schemaAnalysis = analyzeEmbeddedSchema(schema);
  const path = `convex-embedded-${request.storageId}.db`;
  const state = await initRuntime({
    modules,
    setupSchema: schemaAnalysis.storeSchema,
    storagePath: path,
    storeSchema: schemaAnalysis.storeSchema,
    wasm,
  });

  let degraded = false;
  let ready = false;
  let dead = false;
  const readyGate = deferred();
  const host: RecoveryHost = {
    now: () => getTimerTime(),
    emitDegraded: () => {
      degraded = true;
    },
    emitReady: () => {
      ready = true;
      readyGate.resolve();
    },
    emitRemoteError: () => undefined,
    rebuild: () => state.rebuild!(),
    stopRemote: () => undefined,
    deadInstance: () => {
      dead = true;
      readyGate.resolve();
    },
    runCheckpoint: () => state.store.checkpoint(),
  };
  // Short deadlines keep the harness fast; checkpoint pacing is pushed out of the way.
  const recovery = new StoreRecovery(host, {
    checkpointPollMs: 60_000,
    idleMs: 400,
    pollMs: 50,
  });
  state.recovery = recovery;

  try {
    for (let index = 0; index < request.rows; index += 1) {
      await state.runner.runMutation(createDocument, seedFields(index));
    }
    const rowsBefore = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
    const pthreadsBefore = state.pthreads?.size ?? 0;

    // Wedge the instance: arm a lane, then terminate the whole pthread pool with no further
    // progress signal. The watchdog abandons the lane and the controller grafts a fresh instance.
    recovery.arm("pull");
    const liveness = setInterval(() => recovery.transportActive(), 100);
    state.pthreads?.terminateAll();

    try {
      await withTimeout(readyGate.promise, 15_000, "store-instance rebuild");
    } finally {
      clearInterval(liveness);
    }
    if (dead) {
      return {
        dead,
        degraded,
        pthreadsAfter: state.pthreads?.size ?? 0,
        pthreadsBefore,
        rebuilt: false,
        ready,
        rowsAfter: 0,
        rowsBefore,
      };
    }

    // A fresh mutation on the grafted runner commits, and the seeded rows survived the graft.
    await state.runner.runMutation(createDocument, seedFields(request.rows));
    const rowsAfter = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
    const pthreadsAfter = state.pthreads?.size ?? 0;

    return {
      dead,
      degraded,
      pthreadsAfter,
      pthreadsBefore,
      rebuilt: ready,
      ready,
      rowsAfter,
      rowsBefore,
    };
  } finally {
    recovery.dispose();
    await state.store.close().catch(() => undefined);
    state.pthreads?.terminateAll();
    state.opfs.closeAll();
  }
}

function seedFields(index: number): {
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
} {
  return {
    body: JSON.stringify([{ content: `recover-${index}`, type: "paragraph" }]),
    slug: `recover-${index}`,
    title: `recover-${index}`,
    updatedAt: index,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}
