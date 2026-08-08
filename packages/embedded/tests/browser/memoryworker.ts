/** Dedicated worker for release-WASM linear-memory measurements. */
import type { WasmSource } from "../../src/browser/artifact";
import { initRuntime, type WorkerState } from "../../src/browser/runtime";
import type { StoreSchema } from "../../src/storage/types";
import { workerRun } from "./harness/worker";

import napiWorkerUrl from "../../dist/thread/browser-worker.mjs?url";
import wasmUrl from "../../dist/wasm/index.wasm?url";

interface SeedRequest {
  op: "seed";
  rows: number;
  storageId: string;
}

interface MemoryRequest {
  op: "memory";
  rows: number;
  scenario: "boot" | "steady100" | "pull10k";
  storageId: string;
}

interface CandidateRequest {
  op: "candidate";
  rows: number;
  storageId: string;
}

self.onmessage = (event: MessageEvent<CandidateRequest | MemoryRequest | SeedRequest>) => {
  const request = event.data;
  const handler =
    request.op === "seed"
      ? seed(request)
      : request.op === "candidate"
        ? measureCandidate(request)
        : measure(request);
  workerRun(() => handler);
};

async function measureCandidate(request: CandidateRequest): Promise<{
  coldMs: number;
  initialKiB: number;
  maximumKiB: number;
  peakKiB: number;
  rows: number;
  rowsPerSecond: number;
  settledKiB: number;
  warmMs: number;
}> {
  const capture = installMemoryCapture();
  try {
    const { modules, storeSchema, wasm } = await loadModules();
    const seeded = await openWithSchema(request.storageId, storeSchema, modules, wasm);
    const captured = capture.read();
    const initialKiB = memoryKiB(captured.memory);
    let peakKiB = initialKiB;
    const sample = () => {
      peakKiB = Math.max(peakKiB, memoryKiB(captured.memory));
    };
    try {
      await writeCandidateRows(seeded, request.rows, sample);
    } finally {
      await close(seeded);
    }
    sample();

    const target = {
      ...storeSchema,
      hash: "b".repeat(64),
      setupHash: "",
      tables: storeSchema.tables.map((table) =>
        table.name === "setupState"
          ? {
              ...table,
              columns: table.columns.some((column) => column.name === "version")
                ? table.columns
                : [...table.columns, { name: "version" }],
            }
          : table,
      ),
    };
    const coldStarted = performance.now();
    const cold = await openWithSchema(request.storageId, target, modules, wasm);
    const coldMs = performance.now() - coldStarted;
    sample();
    const coldRows = await candidateRows(cold, request.rows);
    await close(cold);
    if (coldRows !== request.rows) {
      throw new Error(`cold candidate retained ${coldRows}/${request.rows} rows`);
    }

    const warmStarted = performance.now();
    const warm = await openWithSchema(request.storageId, target, modules, wasm);
    const warmMs = performance.now() - warmStarted;
    sample();
    const warmRows = await candidateRows(warm, request.rows);
    await close(warm);
    if (warmRows !== request.rows) {
      throw new Error(`warm candidate retained ${warmRows}/${request.rows} rows`);
    }
    const settledKiB = memoryKiB(captured.memory);
    return {
      coldMs,
      initialKiB,
      maximumKiB: captured.maximumPages * 64,
      peakKiB: Math.max(peakKiB, settledKiB),
      rows: request.rows,
      rowsPerSecond: Math.round(request.rows / (coldMs / 1_000)),
      settledKiB,
      warmMs,
    };
  } finally {
    capture.restore();
  }
}

async function writeCandidateRows(
  state: WorkerState,
  rows: number,
  sample: () => void,
): Promise<void> {
  const first = Math.floor(rows / 3);
  const second = Math.floor((rows * 2) / 3);
  for (const [identity, from, to] of [
    ["unauthenticated", 0, first],
    ["stress:a", first, second],
    ["stress:b", second, rows],
  ] as const) {
    await state.store.identity?.write(identity);
    for (let start = from; start < to; start += 1_000) {
      const end = Math.min(to, start + 1_000);
      await state.store.commit(
        {
          deletes: [],
          docWrites: Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            return {
              cols: [],
              creationTime: index + 1,
              data: { version: index },
              id: `setupState|${index.toString(16).padStart(32, "0")}`,
              table: "setupState",
            };
          }),
        },
        { changes: "omit", source: "device" },
      );
      sample();
    }
  }
}

async function candidateRows(state: WorkerState, rows: number): Promise<number> {
  const first = Math.floor(rows / 3);
  const second = Math.floor((rows * 2) / 3);
  let total = 0;
  for (const [identity, expected] of [
    ["unauthenticated", first],
    ["stress:a", second - first],
    ["stress:b", rows - second],
  ] as const) {
    await state.store.identity?.write(identity);
    const count = (await state.store.doc.count.read({ table: "setupState" })) ?? 0;
    if (count !== expected) {
      throw new Error(`${identity} candidate partition retained ${count}/${expected} rows`);
    }
    total += count;
  }
  return total;
}

async function seed(request: SeedRequest): Promise<{ rows: number }> {
  const state = await open(request.storageId);
  try {
    await writeRows(state, request.rows);
    await state.store.wal.write();
    return { rows: (await state.store.doc.count.read({ table: "documents" })) ?? 0 };
  } finally {
    await close(state);
  }
}

async function measure(request: MemoryRequest): Promise<{
  initialKiB: number;
  jsHeapUsedKiB: number | null;
  maximumKiB: number;
  peakKiB: number;
  rows: number;
  scenario: MemoryRequest["scenario"];
  settledKiB: number;
}> {
  const capture = installMemoryCapture();
  let state: WorkerState | undefined;
  try {
    const jsHeapBeforeKiB = readJsHeapKiB();
    state = await open(request.storageId);
    const captured = capture.read();
    const initialKiB = memoryKiB(captured.memory);
    let peakKiB = initialKiB;
    const sample = () => {
      peakKiB = Math.max(peakKiB, memoryKiB(captured.memory));
    };

    await writeRows(state, request.rows, sample);
    await state.store.wal.write();
    sample();
    const settledKiB = memoryKiB(captured.memory);
    const jsHeapAfterKiB = readJsHeapKiB();
    return {
      initialKiB,
      jsHeapUsedKiB:
        jsHeapAfterKiB === null || jsHeapBeforeKiB === null
          ? null
          : Math.max(jsHeapBeforeKiB, jsHeapAfterKiB),
      maximumKiB: captured.maximumPages * 64,
      peakKiB: Math.max(peakKiB, settledKiB),
      rows: (await state.store.doc.count.read({ table: "documents" })) ?? 0,
      scenario: request.scenario,
      settledKiB,
    };
  } finally {
    capture.restore();
    if (state !== undefined) await close(state);
  }
}

async function open(storageId: string): Promise<WorkerState> {
  const { modules, storeSchema, wasm } = await loadModules();
  return await openWithSchema(storageId, storeSchema, modules, wasm);
}

async function openWithSchema(
  storageId: string,
  storeSchema: StoreSchema,
  modules: Awaited<typeof import("virtual:convex-embedded")>["modules"],
  wasm: WasmSource,
): Promise<WorkerState> {
  return await initRuntime({
    modules,
    setupSchema: storeSchema,
    storagePath: `convex-embedded-${storageId}.db`,
    storeSchema,
    wasm,
  });
}

async function close(state: WorkerState): Promise<void> {
  await state.store.wal.write();
  await state.store.close();
  state.opfs.closeAll();
}

async function loadModules(): Promise<{
  modules: Awaited<typeof import("virtual:convex-embedded")>["modules"];
  storeSchema: StoreSchema;
  wasm: WasmSource;
}> {
  const { embeddedSchema, modules } = await import("virtual:convex-embedded");
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`failed to load packaged WASM artifact: ${response.status}`);
  return {
    modules,
    storeSchema: embeddedSchema.runtimeStoreSchema,
    wasm: {
      bytes: await response.arrayBuffer(),
      worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
    },
  };
}

async function writeRows(
  state: WorkerState,
  rows: number,
  sample: () => void = () => undefined,
): Promise<void> {
  const batchSize = 1_000;
  for (let start = 0; start < rows; start += batchSize) {
    const end = Math.min(rows, start + batchSize);
    await state.store.commit(
      {
        deletes: [],
        docWrites: Array.from({ length: end - start }, (_, offset) => remoteWrite(start + offset)),
      },
      { changes: "include", source: "remote" },
    );
    sample();
  }
}

function remoteWrite(index: number): {
  cols: { idx_slug: string; idx_updated_at: number };
  creationTime: number;
  data: { body: string; slug: string; title: string; updatedAt: number };
  id: string;
  table: "documents";
} {
  const key = index.toString(36);
  return {
    cols: { idx_slug: `memory-${key}`, idx_updated_at: -index - 1 },
    creationTime: index + 1,
    data: {
      body: JSON.stringify([
        { content: `memory-${index}`, props: { level: 1 }, type: "heading" },
        { content: `${"x".repeat(512)}-${index}`, type: "paragraph" },
      ]),
      slug: `memory-${key}`,
      title: `memory-row-${index}`,
      updatedAt: -index - 1,
    },
    id: `documents|${index.toString(16).padStart(32, "0")}`,
    table: "documents",
  };
}

function installMemoryCapture(): {
  read(): { maximumPages: number; memory: WebAssembly.Memory };
  restore(): void;
} {
  const original = WebAssembly.Memory;
  let maximumPages = 0;
  let memory: WebAssembly.Memory | undefined;
  const replacement = new Proxy(original, {
    construct(target, args) {
      const descriptor = args[0] as WebAssembly.MemoryDescriptor;
      const instance = Reflect.construct(target, args, target) as WebAssembly.Memory;
      maximumPages = descriptor.maximum ?? descriptor.initial;
      memory = instance;
      return instance;
    },
  });
  Object.defineProperty(WebAssembly, "Memory", {
    configurable: true,
    value: replacement,
    writable: true,
  });
  return {
    read: () => {
      if (memory === undefined || maximumPages === 0) {
        throw new Error("packaged runtime did not construct an observable WebAssembly.Memory");
      }
      return { maximumPages, memory };
    },
    restore: () => {
      Object.defineProperty(WebAssembly, "Memory", {
        configurable: true,
        value: original,
        writable: true,
      });
    },
  };
}

function memoryKiB(memory: WebAssembly.Memory): number {
  return memory.buffer.byteLength / 1024;
}

function readJsHeapKiB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return memory?.usedJSHeapSize === undefined ? null : memory.usedJSHeapSize / 1024;
}
