/**
 * Dedicated worker for the headless boot stress harness. It runs inside a Worker so OPFS sync
 * access handles are available, and exposes three command shapes over `postMessage`:
 *
 * - `seed`: opens the store, writes many rows across tables and commits many mutations so the
 *   OPFS database and write-ahead log grow multi-megabyte, checkpoints, and closes cleanly.
 * - `boot`: opens the store, records the `worker:store:*` boot phase timings surfaced through the
 *   runtime debug bridge, reads a row count to prove the seeded data survived, and closes cleanly.
 * - `wound`: opens the store and writes a few rows but deliberately does NOT close — the harness
 *   `Worker.terminate()`s this worker mid-flight to leave the OPFS sync access handle held by a
 *   dead predecessor, reproducing the reclaim-contention boot hang.
 *
 * No live backend is involved; the worker drives the packaged WASM store directly.
 */
import { makeFunctionReference } from "convex/server";

import type { WasmSource } from "../../src/browser/artifact";
import type { EmbeddedRuntimeEvent } from "../../src/events";
import { OpfsDirectory, registerTursoFiles } from "../../src/browser/opfs";
import { initRuntime, type WorkerState } from "../../src/browser/runtime";
import type { StoreSchema } from "../../src/storage/types";
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
};

const createDocument = makeFunctionReference<
  "mutation",
  { body: string; slug: string; title: string; updatedAt: number },
  { _id: string }
>("documents:write");

interface SeedRequest {
  op: "seed";
  storageId: string;
  rows: number;
}

interface BootRequest {
  op: "boot";
  storageId: string;
  storageWaitNoticeMs?: number;
}

interface WoundRequest {
  op: "wound";
  storageId: string;
  rows: number;
}

interface WoundStageRequest {
  op: "woundStage";
  stage: "open" | "commit" | "wal" | "close";
  storageId: string;
}

interface HoldRequest {
  op: "hold";
  storageId: string;
}

interface ReleaseRequest {
  op: "release";
}

interface DamageRequest {
  op: "damage";
  storageId: string;
}

interface InspectRequest {
  op: "inspect";
  storageId: string;
}

interface CorruptResetRequest {
  op: "corruptReset";
  storageId: string;
}

interface CorruptResetResult {
  resetStart: boolean;
  resetDone: boolean;
  resetErrorMessage: string;
  rowsBefore: number;
  rowsAfter: number;
  phases: string[];
}

type BootPhaseTimings = Record<string, number>;

interface BootResult {
  phases: BootPhaseTimings;
  rows: number;
  openSetupMs: number;
  acquired: BootPhaseTimings;
  runtimeEvents: EmbeddedRuntimeEvent[];
}

interface SeedResult {
  rows: number;
  dbBytes: number;
  walBytes: number;
}

let heldOpfs: OpfsDirectory | undefined;

self.onmessage = (
  event: MessageEvent<
    | SeedRequest
    | BootRequest
    | WoundRequest
    | WoundStageRequest
    | HoldRequest
    | ReleaseRequest
    | DamageRequest
    | InspectRequest
    | CorruptResetRequest
  >,
) => {
  const request = event.data;
  if (request.op === "release") {
    heldOpfs?.closeAll();
    heldOpfs = undefined;
    self.postMessage({ ok: true, result: { released: true } });
    return;
  }
  const handler =
    request.op === "seed"
      ? seed(request)
      : request.op === "damage"
        ? damage(request)
        : request.op === "inspect"
          ? inspect(request)
          : request.op === "corruptReset"
            ? corruptReset(request)
            : request.op === "boot"
              ? boot(request)
              : request.op === "hold"
                ? hold(request)
                : request.op === "woundStage"
                  ? woundStage(request)
                  : wound(request);
  void handler
    .then((result) => self.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ok: false,
      }),
    );
};

const damageBytes = new TextEncoder().encode("embedded-corrupt-database");

async function damage(request: DamageRequest): Promise<{ bytes: number[] }> {
  const path = storagePath(request.storageId);
  const opfs = new OpfsDirectory();
  try {
    await registerTursoFiles(opfs, path);
    const handle = opfs.getFileHandle(path);
    if (handle === null) throw new Error("damaged database handle was not registered");
    opfs.truncate(handle, 0);
    opfs.write(handle, damageBytes, 0);
    opfs.sync(handle);
    return { bytes: [...damageBytes] };
  } finally {
    opfs.closeAll();
  }
}

async function inspect(request: InspectRequest): Promise<{ bytes: number[] }> {
  const path = storagePath(request.storageId);
  const opfs = new OpfsDirectory();
  try {
    await registerTursoFiles(opfs, path);
    const handle = opfs.getFileHandle(path);
    if (handle === null) throw new Error("inspected database handle was not registered");
    const bytes = new Uint8Array(damageBytes.length);
    opfs.read(handle, bytes, 0);
    return { bytes: [...bytes] };
  } finally {
    opfs.closeAll();
  }
}

async function plantCorruptHeader(path: string): Promise<void> {
  const opfs = new OpfsDirectory();
  try {
    await registerTursoFiles(opfs, path);
    const handle = opfs.getFileHandle(path);
    if (handle === null) throw new Error("corrupt header handle was not registered");
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode("SQLite format 3\0"), 0);
    opfs.truncate(handle, 0);
    opfs.write(handle, header, 0);
    opfs.sync(handle);
  } finally {
    opfs.closeAll();
  }
}

async function corruptReset(request: CorruptResetRequest): Promise<CorruptResetResult> {
  const { modules, storeSchema, wasm } = await loadModules();
  const path = storagePath(request.storageId);
  await plantCorruptHeader(path);

  const phases: string[] = [];
  let resetErrorMessage = "";
  const state = await initRuntime({
    modules,
    onDebug: (phase: string, detail?: unknown) => {
      phases.push(phase);
      if (phase === "worker:store:reset:start" && detail !== null && typeof detail === "object") {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === "string") resetErrorMessage = message;
      }
    },
    setupSchema: storeSchema,
    storagePath: path,
    storeSchema,
    wasm,
  });

  let rowsBefore = 0;
  let rowsAfter = 0;
  try {
    rowsBefore = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
    await writeSeedRow(state, 0);
    rowsAfter = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
  } finally {
    await state.store.close().catch(() => undefined);
    state.opfs.closeAll();
  }

  return {
    phases,
    resetDone: phases.includes("worker:store:reset:done"),
    resetErrorMessage,
    resetStart: phases.includes("worker:store:reset:start"),
    rowsAfter,
    rowsBefore,
  };
}

async function hold(request: HoldRequest): Promise<{ held: true }> {
  const path = storagePath(request.storageId);
  heldOpfs = new OpfsDirectory();
  await registerTursoFiles(heldOpfs, path);
  return { held: true };
}

async function loadModules(): Promise<{
  modules: Awaited<typeof import("virtual:convex-embedded")>["modules"];
  storeSchema: StoreSchema;
  wasm: WasmSource;
}> {
  const { embeddedSchema, modules } = await import("virtual:convex-embedded");
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`failed to load packaged WASM artifact: ${wasmResponse.status}`);
  }
  const wasmBytes = await wasmResponse.arrayBuffer();
  return {
    modules,
    storeSchema: embeddedSchema.runtimeStoreSchema,
    wasm: {
      bytes: wasmBytes,
      worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
    },
  };
}

function storagePath(storageId: string): string {
  return `convex-embedded-${storageId}.db`;
}

async function seed(request: SeedRequest): Promise<SeedResult> {
  const { modules, storeSchema, wasm } = await loadModules();
  const path = storagePath(request.storageId);
  const state = await initRuntime({
    modules,
    setupSchema: storeSchema,
    storagePath: path,
    storeSchema,
    wasm,
  });
  let rows = 0;
  let dbBytes = 0;
  let walBytes = 0;
  try {
    for (let index = 0; index < request.rows; index += 1) {
      await writeSeedRow(state, index);
    }
    rows = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
    await state.store.wal.write();
    dbBytes = fileBytes(state.opfs, path);
    walBytes = fileBytes(state.opfs, `${path}-wal`);
  } finally {
    await state.store.close().catch(() => undefined);
    state.opfs.closeAll();
  }
  return { dbBytes, rows, walBytes };
}

async function boot(request: BootRequest): Promise<BootResult> {
  const { modules, storeSchema, wasm } = await loadModules();
  const path = storagePath(request.storageId);
  const phases: BootPhaseTimings = {};
  const acquired: BootPhaseTimings = {};
  const runtimeEvents: EmbeddedRuntimeEvent[] = [];
  const starts = new Map<string, number>();
  const openSetupStartedAt = getTimerTime();
  const state = await initRuntime({
    emit: undefined,
    modules,
    onRuntimeEvent: (event) => runtimeEvents.push(event),
    storageWaitNoticeMs: request.storageWaitNoticeMs,
    onDebug: (phase: string, detail?: unknown) => {
      const at = getTimerTime();
      if (phase.endsWith(":start")) {
        starts.set(phase.slice(0, -":start".length), at);
      } else if (phase.endsWith(":done")) {
        const key = phase.slice(0, -":done".length);
        const startedAt = starts.get(key);
        if (startedAt !== undefined) phases[key] = at - startedAt;
      } else if (
        phase === "worker:opfs:acquire:retry" ||
        phase === "worker:opfs:acquire:reclaimed"
      ) {
        const detailRecord = (detail ?? {}) as { attempt?: number; waitedMs?: number };
        acquired[`${phase}:${detailRecord.attempt ?? 0}`] = detailRecord.waitedMs ?? 0;
      }
    },
    setupSchema: storeSchema,
    storagePath: path,
    storeSchema,
    wasm,
  });
  let rows = 0;
  try {
    rows = (await state.store.doc.count.read({ table: "documents" })) ?? 0;
  } finally {
    await state.store.close().catch(() => undefined);
    state.opfs.closeAll();
  }
  return {
    acquired,
    openSetupMs: getTimerTime() - openSetupStartedAt,
    phases,
    rows,
    runtimeEvents,
  };
}

async function wound(request: WoundRequest): Promise<never> {
  const { modules, storeSchema, wasm } = await loadModules();
  const path = storagePath(request.storageId);
  const state = await initRuntime({
    modules,
    setupSchema: storeSchema,
    storagePath: path,
    storeSchema,
    wasm,
  });
  for (let index = 0; index < request.rows; index += 1) {
    await writeSeedRow(state, index);
  }
  self.postMessage({ ok: true, result: { wounded: true } });
  await new Promise<never>(() => undefined);
  throw new Error("unreachable");
}

async function woundStage(request: WoundStageRequest): Promise<never> {
  const { modules, storeSchema, wasm } = await loadModules();
  const path = storagePath(request.storageId);
  const announce = () => {
    self.postMessage({ ok: true, result: { stage: request.stage, wounding: true } });
  };
  const state = await initRuntime({
    modules,
    onDebug: (phase) => {
      if (request.stage === "open" && phase === "worker:store:open:start") announce();
    },
    setupSchema: storeSchema,
    storagePath: path,
    storeSchema,
    wasm,
  });
  if (request.stage === "commit") {
    const commit = writeSeedRow(state, 900_000);
    announce();
    await commit;
  } else if (request.stage === "wal") {
    await writeSeedRow(state, 900_001);
    const walWrite = state.store.wal.write();
    announce();
    await walWrite;
  } else if (request.stage === "close") {
    const close = state.store.close();
    announce();
    await close;
  }
  await new Promise<never>(() => undefined);
  throw new Error("unreachable");
}

async function writeSeedRow(state: WorkerState, index: number): Promise<void> {
  await state.runner.runMutation(createDocument, seedFields(index));
}

function seedFields(index: number): {
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
} {
  const filler = "x".repeat(512);
  return {
    body: JSON.stringify([
      { content: `seed-${index}`, props: { level: 1 }, type: "heading" },
      { content: `${filler}-${index}`, type: "paragraph" },
    ]),
    slug: `seed-${index}`,
    title: `seed-${index}`,
    updatedAt: index,
  };
}

function fileBytes(
  opfs: { getFileHandle(path: string): number | null; size(handle: number): number },
  path: string,
): number {
  const handle = opfs.getFileHandle(path);
  if (handle === null) return 0;
  return opfs.size(handle);
}
