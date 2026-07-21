/**
 * Dedicated worker that exercises the browser remote upload drain end to end. It runs inside a
 * Worker so OPFS sync access handles are available, stages a pending upload through the local
 * upload path, then drives a loopback {@link RemoteTransportHost} so the real WASM uploader
 * bridge transfers and completes the upload during a replication tick — with no live backend.
 */
import { makeFunctionReference } from "convex/server";

import { initRuntime, transferRemoteUpload, type WorkerState } from "../../src/browser/runtime";
import type { RemoteTransportHost } from "../../src/storage/types";
import { getTimerTime } from "../../src/time";
import { EMBEDDED_PROTOCOL_VERSION } from "../../src/protocol";

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

const generateUploadUrl = makeFunctionReference<"mutation", Record<string, never>, string>(
  "files:generateUploadUrl",
);

interface AutoDrainResult {
  drained: boolean;
  mappingState?: string;
  mappedStorageId?: string;
  uploadCalls: number;
}

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

async function run(storageId: string): Promise<AutoDrainResult> {
  const { embeddedSchema, modules } = await import("virtual:convex-embedded");
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`failed to load packaged WASM artifact: ${wasmResponse.status}`);
  }
  const wasmBytes = await wasmResponse.arrayBuffer();
  const state = await initRuntime({
    modules,
    setupSchema: embeddedSchema.runtimeStoreSchema,
    storagePath: `convex-embedded-${storageId}.db`,
    storeSchema: embeddedSchema.runtimeStoreSchema,
    wasm: {
      bytes: wasmBytes,
      worker: () => new Worker(new URL(napiWorkerUrl, import.meta.url), { type: "module" }),
    },
  });
  try {
    const remote = state.store.remote;
    if (!remote?.pull) throw new Error("worker runtime has no remote drain support");

    const stageUrl = (await state.runner.runMutation(generateUploadUrl, {})) as string;
    const stored = await state.runner.handleUpload(
      stageUrl,
      new Blob(["auto-drain-bytes"], { type: "text/plain" }),
    );
    const localStorageId = stored.storageId;
    const staged = (await state.store.upload.read()).some(
      (row) => row.localStorageId === localStorageId,
    );
    if (!staged) throw new Error("upload was not staged as pending before the drain tick");

    let uploadCalls = 0;
    const transport = createLoopbackTransport(state, () => {
      uploadCalls += 1;
    });

    await remote.start({
      operationTimeoutMs: 5_000,
      receiveTimeoutMs: 50,
      moduleGraphHash: "browser-autodrain",
      protocolVersion: EMBEDDED_PROTOCOL_VERSION,
      schemaHash: "browser-autodrain",
      transport,
      url: "https://loopback.invalid",
    });

    const deadline = getTimerTime() + 8_000;
    let drained = false;
    while (getTimerTime() < deadline) {
      await remote.pull(true);
      const pending = await state.store.upload.read();
      if (!pending.some((row) => row.localStorageId === localStorageId)) {
        drained = true;
        break;
      }
    }

    const mapping = await state.store.id.read("_storage", localStorageId);
    return {
      drained,
      mappedStorageId: mapping?.mapping === "mapped" ? mapping.convexId : undefined,
      mappingState: mapping?.mapping,
      uploadCalls,
    };
  } finally {
    await state.store.remote?.close().catch(() => undefined);
    await state.store.close().catch(() => undefined);
  }
}

function createLoopbackTransport(
  state: WorkerState,
  onUpload: () => void,
): RemoteTransportHost & {
  upload(args: {
    bytes: Uint8Array;
    contentType?: string;
    localStorageId: string;
    sha256: string;
    size: number;
    uploadUrl: string;
  }): Promise<{ storageId: string }>;
} {
  const inbox: Array<{ kind: "message"; message: string }> = [];
  const waiters: Array<() => void> = [];
  let version = 0;
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const encodeTs = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const stateVersion = (value: number) => ({ identity: 0, querySet: 0, ts: encodeTs(value) });
  const pushMessage = (message: unknown) => {
    inbox.push({ kind: "message", message: JSON.stringify(message) });
    wake();
  };
  const respondMutation = async (requestId: number, udfPath: string) => {
    let result: unknown;
    if (udfPath === "embedded:upload") {
      result = { uploadUrl: "https://loopback.invalid/api/storage/upload?token=fake" };
    } else {
      result = { accepted: true, idempotent: false };
    }
    const start = version;
    const end = version + 1;
    version = end;
    pushMessage({
      logLines: [],
      requestId,
      result,
      success: true,
      ts: encodeTs(end),
      type: "MutationResponse",
    });
    pushMessage({
      clientClockSkew: null,
      endVersion: stateVersion(end),
      modifications: [],
      serverTs: null,
      startVersion: stateVersion(start),
      type: "Transition",
    });
  };
  const respondQuery = (queryId: number) => {
    const start = version;
    const end = version + 1;
    version = end;
    pushMessage({
      clientClockSkew: null,
      endVersion: stateVersion(end),
      modifications: [
        {
          journal: null,
          logLines: [],
          queryId,
          type: "QueryUpdated",
          value: {
            cursor: null,
            projections: [],
            updates: [],
          },
        },
      ],
      serverTs: null,
      startVersion: stateVersion(start),
      type: "Transition",
    });
  };

  return {
    close: async () => {
      inbox.length = 0;
      wake();
    },
    connect: async () => undefined,
    monotonicMs: () => performance.now(),
    nowMs: getTimerTime,
    receive: async ({ timeoutMs }) => {
      const event = inbox.shift();
      if (event) return event;
      return await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve(inbox.shift() ?? { kind: "timeout" as const });
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(done);
          if (index >= 0) waiters.splice(index, 1);
          resolve({ kind: "timeout" });
        }, timeoutMs);
        waiters.push(done);
      });
    },
    runStoreJob: () => undefined,
    send: async ({ message }) => {
      const parsed = JSON.parse(message) as {
        modifications?: Array<{
          queryId?: number;
          type?: string;
          udfPath?: string;
        }>;
        type: string;
        requestId?: number;
        udfPath?: string;
      };
      if (parsed.type === "Mutation" && parsed.udfPath !== undefined) {
        await respondMutation(parsed.requestId ?? 0, parsed.udfPath);
      }
      if (parsed.type === "ModifyQuerySet") {
        for (const modification of parsed.modifications ?? []) {
          if (modification.type === "Add" && modification.queryId !== undefined) {
            respondQuery(modification.queryId);
          }
        }
      }
    },
    upload: async ({ uploadUrl, bytes, contentType }) => {
      onUpload();
      const mappedStorageId = `kg2-hosted-${Math.random().toString(36).slice(2)}`;
      const fetchMock: typeof globalThis.fetch = async (input, init) => {
        if (input !== uploadUrl || init?.method !== "POST" || !init.body) {
          return new Response("unexpected upload request", { status: 400 });
        }
        return new Response(JSON.stringify({ storageId: mappedStorageId }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      };
      return transferRemoteUpload(
        { bytes, contentType, uploadUrl },
        (url, blob) => state.runner.handleUpload(url, blob),
        fetchMock,
      );
    },
  };
}
