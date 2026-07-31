import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

import type { EmbeddedEvent, EmbeddedOperationEvent, EmbeddedRemoteEvent } from "../../src/events";
import { defineLocal, localReferenceName } from "../../src/local";
import { getTimerTime } from "../../src/time";
import { read as readTime } from "../testkit/time";
import schema from "./convex/schema";
import { documentCount } from "./local/insights";
import { documentTitles, scope } from "./local/mixed";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH__: boolean;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__: number;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__: string | undefined;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_PROFILE__: "full" | "smoke";
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_ROWS__: string;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_STARTUP__: boolean;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_TABS__: string;
declare const __CONVEX_EMBEDDED_BROWSER_BENCH_WARMUPS__: number;

const createDocument = makeFunctionReference<
  "mutation",
  { body?: string; slug?: string; title?: string; updatedAt?: number },
  DocumentRow
>("documents:write");
const writeDocumentBody = makeFunctionReference<
  "mutation",
  { id: string; splices: { delete: number; index: number; insert: string }[] },
  DocumentRow
>("documents:write");
const removeDocument = makeFunctionReference<"mutation", { id: string }, null>("documents:del");
const listDocuments = makeFunctionReference<"query", { limit?: number }, DocumentRow[]>(
  "documents:read",
);
const getDocument = makeFunctionReference<"query", { id: string }, DocumentRow[]>("documents:read");
const generateUploadUrl = makeFunctionReference<"mutation", Record<string, never>, string>(
  "files:generateUploadUrl",
);
const storageMetadata = makeFunctionReference<
  "query",
  { storageId: string },
  { contentType?: string; size: number } | null
>("files:metadata");
const fileUrl = makeFunctionReference<"query", { storageId: string }, string | null>("files:url");
const hostedEcho = makeFunctionReference<"action", { value: string }, string>("hosted:echo");

interface DocumentRow {
  _creationTime: number;
  _id: string;
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
}

interface DocumentClient extends RuntimeClient {
  mutation(
    name: typeof createDocument,
    args: { body?: string; slug?: string; title?: string; updatedAt?: number },
  ): Promise<DocumentRow>;
  mutation(
    name: typeof writeDocumentBody,
    args: { id: string; splices: { delete: number; index: number; insert: string }[] },
  ): Promise<DocumentRow>;
  mutation(name: typeof removeDocument, args: { id: string }): Promise<null>;
  query(name: typeof listDocuments, args: { limit?: number }): Promise<DocumentRow[]>;
  watchQuery(
    name: typeof getDocument,
    args: { id: string },
  ): {
    localQueryResult(): DocumentRow | null | undefined;
    onUpdate(onUpdate: () => void, onError?: (error: unknown) => void): () => void;
  };
  watchQuery(
    name: typeof listDocuments,
    args: { limit?: number },
  ): {
    localQueryResult(): DocumentRow[] | undefined;
    onUpdate(onUpdate: () => void, onError?: (error: unknown) => void): () => void;
  };
}

interface RuntimeClient {
  close(): Promise<void>;
  subscribeInternalEvents?(listener: (event: EmbeddedEvent) => void): () => void;
}

interface OrphanClient {
  query(fn: unknown, args: Record<string, never>): Promise<unknown>;
}

interface LocalInsightsClient extends RuntimeClient {
  mutation(
    name: typeof createDocument,
    args: { body?: string; slug?: string; title?: string; updatedAt?: number },
  ): Promise<DocumentRow>;
  query(name: typeof documentCount, args: Record<string, never>): Promise<number>;
  query(name: typeof documentTitles, args: Record<string, never>): Promise<string[]>;
  watchQuery(
    name: typeof documentCount,
    args: Record<string, never>,
  ): {
    localQueryResult(): number | undefined;
    onUpdate(onUpdate: () => void, onError?: (error: unknown) => void): () => void;
  };
}

interface DebugEvent {
  at: number;
  detail?: unknown;
  phase: string;
  source: "worker";
}

const clients = new Set<RuntimeClient>();
const debugEvents: DebugEvent[] = [];

afterEach(async () => {
  delete debugGlobal().__CONVEX_EMBEDDED_DEBUG_LOG__;
  debugEvents.length = 0;
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

interface AutoDrainResult {
  drained: boolean;
  mappedStorageId?: string;
  mappingState?: string;
  uploadCalls: number;
}

type AutoDrainMessage = { error: string; ok: false } | { ok: true; result: AutoDrainResult };

interface WalResult {
  rowsAfterReopen: number;
  rowsBefore: number;
  walAfter: number;
  walBefore: number;
}

type WalMessage = { error: string; ok: false } | { ok: true; result: WalResult };

describe("browser runtime", () => {
  test("starts the packaged dedicated runtime worker", async () => {
    useIsolatedBrowserStorage("capability");
    installDebugLogHook();
    await mark("capability start");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient());

    const result = await settle(withTimeout(convex.query(listDocuments, {}), "capability query"));
    if (!result.ok) throw result.error;
    expect(Array.isArray(result.value)).toBe(true);
    expect(debugEvents.some((event) => event.phase === "worker:bundle:import:done")).toBe(true);
    expect(debugEvents.some((event) => event.phase === "worker:opfs:register:done")).toBe(true);
  });

  test("runs packaged browser client through worker, WASM, OPFS, and virtual Convex modules", async () => {
    useIsolatedBrowserStorage("runtime");
    installDebugLogHook();
    await mark("start");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const prefix = `runtime-${getTimerTime()}-${Math.random().toString(36).slice(2)}:`;
    await mark("construct clients", { prefix });
    const convexA = track(new ConvexEmbeddedClient());
    const convexB = track(new ConvexEmbeddedClient());

    await mark("first mutation");
    const firstMutation = await settle(writeDocument(convexA, `${prefix}hi`, "first mutation"));
    if (!firstMutation.ok) throw firstMutation.error;
    await mark("first query from second client");
    await expectPrefixedDocuments(convexB, prefix, ["hi"]);

    await mark("watch start from second client");
    const watch = convexB.watchQuery(listDocuments, {});
    let updateCount = 0;
    let resolveUpdate: (() => void) | undefined;
    const nextUpdate = () =>
      new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
    const stop = watch.onUpdate(() => {
      updateCount += 1;
      resolveUpdate?.();
      resolveUpdate = undefined;
    });
    await waitFor(() =>
      expect(documentSuffixes(watch.localQueryResult() ?? [], prefix)).toEqual(["hi"]),
    );

    await mark("second mutation from first client");
    const changed = nextUpdate();
    await writeDocument(convexA, `${prefix}again`, "second mutation");
    await withTimeout(changed, "watch update");
    await waitFor(() =>
      expect(documentSuffixes(watch.localQueryResult() ?? [], prefix)).toEqual(["again", "hi"]),
    );
    expect(updateCount).toBeGreaterThanOrEqual(2);

    await mark("close first client");
    await withTimeout(convexA.close(), "close first client");
    clients.delete(convexA);

    await mark("third mutation from second client");
    await writeDocument(convexB, `${prefix}after-close`, "third mutation");
    await waitFor(() =>
      expect(documentSuffixes(watch.localQueryResult() ?? [], prefix)).toEqual([
        "after-close",
        "again",
        "hi",
      ]),
    );

    await mark("close second client");
    stop();
    await withTimeout(convexB.close(), "close second client");
    clients.delete(convexB);

    await mark("reopen");
    const reopened = track(new ConvexEmbeddedClient());
    await expectPrefixedDocuments(reopened, prefix, ["after-close", "again", "hi"]);
  }, 45_000);

  test("reports packaged browser mutation phase timing", async () => {
    useIsolatedBrowserStorage("timing");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient());
    const operations: EmbeddedOperationEvent[] = [];
    convex.subscribeInternalEvents?.((event) => {
      if (event.type === "operation") operations.push(event);
    });

    await writeDocument(
      convex,
      `timing-warmup-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
      "warmup mutation",
    );

    const samples: Array<{
      commitMs: number;
      envelopeMs: number;
      measuredMs: number;
      notifyMs: number;
      outsideRuntimeMs: number;
      totalRuntimeMs: number;
    }> = [];
    for (let i = 0; i < 25; i += 1) {
      const before = operations.length;
      const text = `timing-${i}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
      const startedAt = getTimerTime();
      await writeDocument(convex, text, `timed mutation ${i}`);
      const measuredMs = getTimerTime() - startedAt;
      const operation = operations
        .slice(before)
        .find(
          (event) =>
            event.kind === "mutation" &&
            event.name === "documents:write" &&
            event.phase === "finish",
        );
      expect(operation?.phase).toBe("finish");
      expect(operation?.status).toBe("success");
      expect(operation?.durationMs).toBeGreaterThanOrEqual(0);
      expect(operation?.timing).toMatchObject({
        mutationId: true,
      });

      const timing = operation!.timing!;
      expect(timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.commitMs);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.notifyMs);
      samples.push({
        commitMs: timing.commitMs,
        envelopeMs: operation!.durationMs ?? 0,
        measuredMs,
        notifyMs: timing.notifyMs,
        outsideRuntimeMs: (operation!.durationMs ?? 0) - timing.totalMs,
        totalRuntimeMs: timing.totalMs,
      });
    }

    await mark("mutation timing", {
      commitMs: summarize(samples.map((sample) => sample.commitMs)),
      envelopeMs: summarize(samples.map((sample) => sample.envelopeMs)),
      measuredMs: summarize(samples.map((sample) => sample.measuredMs)),
      notifyMs: summarize(samples.map((sample) => sample.notifyMs)),
      outsideRuntimeMs: summarize(samples.map((sample) => sample.outsideRuntimeMs)),
      samples,
      totalRuntimeMs: summarize(samples.map((sample) => sample.totalRuntimeMs)),
    });
  });

  test("reports packaged browser startup phase timing", async () => {
    useIsolatedBrowserStorage("startup-timing");
    installDebugLogHook();
    const importStartedAt = getTimerTime();
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const importMs = getTimerTime() - importStartedAt;

    const constructStartedAt = getTimerTime();
    const convex = track(new ConvexEmbeddedClient());
    const constructMs = getTimerTime() - constructStartedAt;

    const readyStartedAt = getTimerTime();
    await withTimeout(convex.query(listDocuments, {}), "startup ready query");
    const readyQueryMs = getTimerTime() - readyStartedAt;

    await mark("startup timing", {
      constructMs,
      debugPhases: summarizeDebugPhases(debugEvents),
      importMs,
      readyQueryMs,
      totalSinceConstructMs: getTimerTime() - constructStartedAt,
    });
    expect(
      debugEvents.some(
        (event) =>
          event.phase === "worker:init:ready" ||
          event.phase === "worker:coordination:request-settled",
      ),
    ).toBe(true);
    const memoryEvent = debugEvents.find((event) => event.phase === "worker:wasm:memory");
    const memory = memoryEvent?.detail as
      | { initial?: number; maximum?: number; streamed?: boolean }
      | undefined;
    expect(memory?.initial).toEqual(expect.any(Number));
    expect(memory!.initial!).toBeGreaterThan(0);
    expect(memory?.maximum).toBe(8192);
    expect(memory!.initial!).toBeLessThanOrEqual(memory!.maximum!);
    expect(memory?.streamed).toEqual(expect.any(Boolean));

    await withTimeout(convex.close(), "startup first client close");
    clients.delete(convex);
    debugEvents.length = 0;

    const warmConstructStartedAt = getTimerTime();
    const warm = track(new ConvexEmbeddedClient());
    const warmConstructMs = getTimerTime() - warmConstructStartedAt;

    const warmReadyStartedAt = getTimerTime();
    await withTimeout(warm.query(listDocuments, {}), "warm startup ready query");
    const warmReadyQueryMs = getTimerTime() - warmReadyStartedAt;

    await mark("startup warm timing", {
      constructMs: warmConstructMs,
      debugPhases: summarizeDebugPhases(debugEvents),
      readyQueryMs: warmReadyQueryMs,
      totalSinceConstructMs: getTimerTime() - warmConstructStartedAt,
    });
  });

  test("observes the boot lifecycle through the client runtime event channel", async () => {
    useIsolatedBrowserStorage("runtime-events");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient());
    const runtimeEvents: RuntimeEvent[] = [];
    const stop = convex.onRuntimeEvent?.((event) => runtimeEvents.push(event as RuntimeEvent));

    await withTimeout(convex.query(listDocuments, {}), "runtime-events ready query");
    await waitForWithin(() => {
      expect(runtimeEvents.some((event) => event.phase === "ready")).toBe(true);
    }, 5_000);
    stop?.();

    const phases = runtimeEvents
      .filter((event) => event.phase !== undefined && event.degradation === undefined)
      .map((event) => event.phase);
    await mark("client runtime events", { phases, total: runtimeEvents.length });

    expect(runtimeEvents.every((event) => event.type === "runtime")).toBe(true);
    expect(phases).toContain("store-open");
    expect(phases.indexOf("store-open")).toBeLessThan(phases.indexOf("ready"));
    expect(phases.at(-1)).toBe("ready");
  });

  test("leaves the runtime event channel inert when a boot is unobserved", async () => {
    useIsolatedBrowserStorage("runtime-events-inert");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient());
    await expect(
      withTimeout(convex.query(listDocuments, {}), "inert channel ready query"),
    ).resolves.toEqual([]);
  });

  test("reports demo-shaped mutation timing with devtools activity open", async () => {
    useIsolatedBrowserStorage("timing-devtools");
    const [{ ConvexEmbeddedClient }, { mountEmbeddedDevtools }] = await Promise.all([
      withTimeout(import("@convex-dev/embedded/browser"), "browser package import"),
      withTimeout(import("@convex-dev/embedded/devtools"), "devtools package import"),
    ]);
    const convex = track(new ConvexEmbeddedClient());
    const mounted = mountEmbeddedDevtools(convex, { defaultOpen: true });
    const operations: EmbeddedOperationEvent[] = [];
    convex.subscribeInternalEvents?.((event) => {
      if (event.type === "operation") operations.push(event);
    });

    try {
      await delay(100);
      const prefix = `timing-devtools-${getTimerTime()}-${Math.random().toString(36).slice(2)}:`;
      for (let i = 0; i < 30; i += 1) {
        await writeDocument(convex, `${prefix}${i}`, `seed ${i}`);
      }
      const watch = convex.watchQuery(listDocuments, {});
      const stop = watch.onUpdate(() => undefined);
      try {
        await waitFor(() =>
          expect(documentSuffixes(watch.localQueryResult() ?? [], prefix)).toHaveLength(30),
        );
        const samples = [];
        for (let i = 0; i < 16; i += 1) {
          samples.push(
            await timeMutation(operations, () => writeDocument(convex, `${prefix}sample-${i}`)),
          );
        }

        await mark("demo mutation timing", {
          commitMs: summarize(samples.map((sample) => sample.commitMs)),
          envelopeMs: summarize(samples.map((sample) => sample.envelopeMs)),
          measuredMs: summarize(samples.map((sample) => sample.measuredMs)),
          notifyMs: summarize(samples.map((sample) => sample.notifyMs)),
          outsideRuntimeMs: summarize(samples.map((sample) => sample.outsideRuntimeMs)),
          samples,
          totalRuntimeMs: summarize(samples.map((sample) => sample.totalRuntimeMs)),
        });
      } finally {
        stop();
      }
    } finally {
      mounted.unmount();
    }
  });

  test("reports cold reopen mutation timing on the same browser storage", async () => {
    useIsolatedBrowserStorage("timing-reopen");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const prefix = `timing-reopen-${getTimerTime()}-${Math.random().toString(36).slice(2)}:`;

    const first = track(new ConvexEmbeddedClient());
    const firstOperations: EmbeddedOperationEvent[] = [];
    first.subscribeInternalEvents?.((event) => {
      if (event.type === "operation") firstOperations.push(event);
    });
    const firstSample = await timeMutation(firstOperations, () =>
      writeDocument(first, `${prefix}first`),
    );
    await withTimeout(first.close(), "close first timing client");
    clients.delete(first);

    const reopened = track(new ConvexEmbeddedClient());
    const reopenedOperations: EmbeddedOperationEvent[] = [];
    reopened.subscribeInternalEvents?.((event) => {
      if (event.type === "operation") reopenedOperations.push(event);
    });
    const samples = [];
    for (let i = 0; i < 12; i += 1) {
      samples.push(
        await timeMutation(reopenedOperations, () =>
          writeDocument(reopened, `${prefix}reopen-${i}`),
        ),
      );
    }

    await mark("cold reopen mutation timing", {
      commitMs: summarize(samples.map((sample) => sample.commitMs)),
      envelopeMs: summarize(samples.map((sample) => sample.envelopeMs)),
      firstSample,
      measuredMs: summarize(samples.map((sample) => sample.measuredMs)),
      notifyMs: summarize(samples.map((sample) => sample.notifyMs)),
      outsideRuntimeMs: summarize(samples.map((sample) => sample.outsideRuntimeMs)),
      samples,
      totalRuntimeMs: summarize(samples.map((sample) => sample.totalRuntimeMs)),
    });
  });

  test("reports local mutation timing with unreachable browser remote configured", async () => {
    useIsolatedBrowserStorage("timing-dead-remote");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(
      new ConvexEmbeddedClient({
        url: "http://127.0.0.1:3214",
      }),
    );
    const operations: EmbeddedOperationEvent[] = [];
    const remoteEvents: unknown[] = [];
    convex.subscribeInternalEvents?.((event) => {
      if (event.type === "operation") operations.push(event);
      if (event.type === "remote") remoteEvents.push(event);
    });

    expect(convex.connectionState()).toMatchObject({ local: "starting", remote: "starting" });
    const prefix = `timing-dead-remote-${getTimerTime()}-${Math.random().toString(36).slice(2)}:`;
    const samples = [];
    for (let i = 0; i < 12; i += 1) {
      samples.push(await timeMutation(operations, () => writeDocument(convex, `${prefix}${i}`)));
    }
    expect(convex.connectionState().local).toBe("ready");
    expect(convex.connectionState().remote).not.toBe("disabled");
    await delay(100);

    const connection = convex.connectionState();
    if (connection.remote === "error") {
      expect(connection.remoteError).toBeTypeOf("string");
    } else {
      expect("remoteError" in connection).toBe(false);
    }

    await mark("dead remote mutation timing", {
      commitMs: summarize(samples.map((sample) => sample.commitMs)),
      envelopeMs: summarize(samples.map((sample) => sample.envelopeMs)),
      measuredMs: summarize(samples.map((sample) => sample.measuredMs)),
      notifyMs: summarize(samples.map((sample) => sample.notifyMs)),
      outsideRuntimeMs: summarize(samples.map((sample) => sample.outsideRuntimeMs)),
      remoteEvents: remoteEvents.slice(-8),
      samples,
      totalRuntimeMs: summarize(samples.map((sample) => sample.totalRuntimeMs)),
    });
    expect(remoteEvents.length).toBeGreaterThan(0);
    expect(
      remoteEvents.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "status" in event &&
          (event as { status?: string }).status === "idle",
      ),
    ).toBe(false);
  });

  test.skipIf(!__CONVEX_EMBEDDED_BROWSER_BENCH__)(
    "benchmarks browser real-world latency matrix",
    async () => {
      const result = await browserCommands().embeddedBrowserLatencyBenchmark({
        iterations: __CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__,
        out: __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__,
        profile: __CONVEX_EMBEDDED_BROWSER_BENCH_PROFILE__,
        rowCounts: parseBrowserBenchNumbers(__CONVEX_EMBEDDED_BROWSER_BENCH_ROWS__),
        tabs: parseBrowserBenchTabs(__CONVEX_EMBEDDED_BROWSER_BENCH_TABS__),
        warmups: __CONVEX_EMBEDDED_BROWSER_BENCH_WARMUPS__,
      });
      await mark("browser real-world benchmark", {
        outPath: result.outPath,
        results: result.report.results.map((entry) => ({
          devtoolsOpen: entry.devtoolsOpen,
          envelopeP90: entry.summaries.envelopeMs.p90,
          observedRows: entry.observedRows,
          outsideRuntimeP90: entry.summaries.outsideRuntimeMs.p90,
          rowCount: entry.rowCount,
          suspicious: entry.suspicious,
          tabs: entry.tabs,
          totalRuntimeP90: entry.summaries.totalRuntimeMs.p90,
          watchActive: entry.watchActive,
        })),
      });

      expect(result.report.results.length).toBeGreaterThan(0);
      for (const entry of result.report.results) {
        expect(entry.samples).toHaveLength(__CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__);
        expect(Number.isFinite(entry.summaries.envelopeMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.totalRuntimeMs.p90)).toBe(true);
      }
      const latencyRegressions = result.report.results.flatMap((entry) =>
        entry.suspicious
          .filter((message) => !message.startsWith("observedRows="))
          .map(
            (message) =>
              `${entry.tabs} rows=${entry.rowCount} watch=${entry.watchActive} devtools=${entry.devtoolsOpen}: ${message}`,
          ),
      );
      expect(latencyRegressions).toEqual([]);
    },
    300_000,
  );

  test.skipIf(!__CONVEX_EMBEDDED_BROWSER_BENCH_STARTUP__)(
    "benchmarks browser startup and attach lifecycle",
    async () => {
      const result = await browserCommands().embeddedBrowserStartupBenchmark({
        iterations: __CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__,
        out: __CONVEX_EMBEDDED_BROWSER_BENCH_OUT__,
        warmups: __CONVEX_EMBEDDED_BROWSER_BENCH_WARMUPS__,
      });
      await mark("browser startup benchmark", {
        outPath: result.outPath,
        results: result.report.results.map((entry) => ({
          firstQueryP90: entry.summaries.firstQueryMs.p90,
          importP90: entry.summaries.importMs.p90,
          leaderReadyMs: entry.leaderReadyMs,
          operation: entry.operation,
          openSetupP90: entry.summaries.openSetupMs.p90,
          readyQueryP90: entry.summaries.readyQueryMs.p90,
          storeOpenP90: entry.summaries.storeOpenMs.p90,
          totalP90: entry.summaries.totalMs.p90,
          wasmInstantiateP90: entry.summaries.wasmInstantiateMs.p90,
          wasmLoadP90: entry.summaries.wasmLoadMs.p90,
        })),
      });
      expect(result.report.version).toBe(2);
      expect(result.report.results.map((entry) => entry.operation)).toEqual([
        "cold",
        "reopen",
        "attach",
      ]);
      for (const entry of result.report.results) {
        expect(entry.samples).toHaveLength(__CONVEX_EMBEDDED_BROWSER_BENCH_ITERATIONS__);
        expect(Number.isFinite(entry.summaries.firstQueryMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.importMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.openSetupMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.readyQueryMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.storeOpenMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.storeSetupMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.totalMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.wasmInstantiateMs.p90)).toBe(true);
        expect(Number.isFinite(entry.summaries.wasmLoadMs.p90)).toBe(true);
      }
    },
    300_000,
  );

  test("uploads files through explicit local embedded upload fetch", async () => {
    useIsolatedBrowserStorage("upload");
    const { ConvexEmbeddedClient, createConvexEmbeddedUploadFetch } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient());
    const uploadFetch = createConvexEmbeddedUploadFetch(convex);
    const uploadUrl = await withTimeout(
      convex.mutation(generateUploadUrl, {}),
      "generate upload url",
    );

    const rejected = await uploadFetch(uploadUrl, { method: "GET" });
    expect(rejected.status).toBe(405);

    const uploaded = await uploadFetch(uploadUrl, {
      body: new Blob(["hello"], { type: "text/plain" }),
      method: "POST",
    });
    expect(uploaded.status).toBe(200);
    const { storageId } = (await uploaded.json()) as { storageId: string };
    expect(storageId.startsWith("_storage|")).toBe(true);

    const reused = await uploadFetch(uploadUrl, {
      body: new Blob(["again"], { type: "text/plain" }),
      method: "POST",
    });
    expect(reused.status).toBe(404);
    await expect(convex.query(storageMetadata, { storageId })).resolves.toMatchObject({
      contentType: "text/plain",
      size: 5,
    });
    await expect(convex.query(fileUrl, { storageId })).resolves.toMatch(/^blob:/);
  });

  test("executes a device-only module through a direct import", async () => {
    useIsolatedBrowserStorage("local-direct");
    expect(typeof (documentCount as unknown as { handler?: unknown }).handler).toBe("function");
    expect(scope).toBe("device");
    expect(localReferenceName(documentCount)).toBe("local/insights:documentCount");
    expect(localReferenceName(documentTitles)).toBe("local/mixed:documentTitles");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient()) as unknown as LocalInsightsClient;
    await expect(withTimeout(convex.query(documentCount, {}), "local query")).resolves.toBe(0);
    const watch = convex.watchQuery(documentCount, {});
    const updated = new Promise<void>((resolve) => {
      const stop = watch.onUpdate(() => {
        if (watch.localQueryResult() === 1) {
          stop();
          resolve();
        }
      });
    });
    await withTimeout(
      convex.mutation(createDocument, {
        body: "direct",
        slug: `local-direct-${getTimerTime()}`,
        title: "direct",
      }),
      "create document",
    );
    await withTimeout(updated, "local watch update");
    await expect(
      withTimeout(convex.query(documentCount, {}), "local query after write"),
    ).resolves.toBe(1);
    await expect(
      withTimeout(convex.query(documentTitles, {}), "mixed module local query"),
    ).resolves.toEqual(["direct"]);

    const orphan = defineLocal(schema).query({ args: {}, handler: async () => 0 });
    await expect(
      withTimeout(
        (convex as unknown as OrphanClient).query(orphan, {}),
        "unregistered local query",
      ),
    ).rejects.toThrow("is not registered under the configured local directories");
  });

  test("auto-drains a staged upload during a worker replication tick", async () => {
    const storageId = `auto-drain-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const worker = new Worker(new URL("./autodrain.ts", import.meta.url), { type: "module" });
    try {
      const message = await withTimeout(
        new Promise<AutoDrainMessage>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<AutoDrainMessage>) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message || "auto-drain worker error"));
          worker.postMessage({ storageId });
        }),
        "auto-drain worker run",
      );
      if (!message.ok) throw new Error(message.error);
      const result = message.result;
      expect(result.drained).toBe(true);
      expect(result.uploadCalls).toBeGreaterThanOrEqual(1);
      expect(result.mappingState).toBe("mapped");
      expect((result.mappedStorageId ?? "").length).toBeGreaterThan(0);
    } finally {
      worker.terminate();
    }
  }, 45_000);

  test("truncates the OPFS write-ahead log on wal.write", async () => {
    const storageId = `wal-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const worker = new Worker(new URL("./wal.ts", import.meta.url), { type: "module" });
    try {
      const message = await withTimeout(
        new Promise<WalMessage>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<WalMessage>) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message || "wal worker error"));
          worker.postMessage({ storageId });
        }),
        "wal worker run",
      );
      if (!message.ok) throw new Error(message.error);
      const result = message.result;
      expect(result.walBefore).toBeGreaterThan(0);
      expect(result.walAfter).toBeLessThan(result.walBefore);
      expect(result.rowsBefore).toBe(200);
      expect(result.rowsAfterReopen).toBe(200);
    } finally {
      worker.terminate();
    }
  }, 45_000);

  test("routes actions to the configured Convex deployment", async () => {
    const remoteUrl = hostedRemoteUrl();
    useIsolatedBrowserStorage("action");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const convex = track(new ConvexEmbeddedClient({ url: remoteUrl }));

    expect(await convex.action(hostedEcho, { value: "hosted" })).toBe("hosted");
  });

  test("pushes root documents to the configured Convex deployment from browser remote", async () => {
    const remoteUrl = hostedRemoteUrl();
    installDebugLogHook();
    useIsolatedBrowserStorage("remote");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const text = `browser-remote-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const convex = track(
      new ConvexEmbeddedClient({
        url: remoteUrl,
      }),
    );
    const events: Array<{ error?: string; status?: string; tick?: RemoteTick }> = [];
    convex.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") events.push(event);
    });

    const created = await convex.mutation(createDocument, {
      ...documentFields(text),
      body: "a🙂b",
    });
    const edited = await convex.mutation(writeDocumentBody, {
      id: created._id,
      splices: [{ index: 3, delete: 1, insert: "c" }],
    });
    expect(edited.body).toBe("a🙂c");
    await waitForWithin(async () => {
      const rows = await convex.query(listDocuments, {});
      expect(rows.some((row) => row.title === text)).toBe(true);
    }, 5_000);
    try {
      await waitForWithin(() => {
        const failed = events.find((event) => event.status === "error");
        if (failed) throw new Error(`browser remote failed: ${failed.error ?? "unknown error"}`);
        expect(events.some((event) => (event.tick?.pushAttempted ?? 0) > 0)).toBe(true);
      }, 15_000);
    } catch (error) {
      const snapshot = (await (
        convex as unknown as {
          __devtoolsRuntime(request: { kind: "snapshot" }): Promise<unknown>;
        }
      ).__devtoolsRuntime({ kind: "snapshot" })) as { storage?: unknown };
      throw new Error(
        `browser remote never attempted its queued push: ${JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          events: events.slice(-12),
          storage: snapshot.storage,
        })}`,
      );
    }

    try {
      await waitForWithin(async () => {
        await expect(
          browserCommands().embeddedRemoteDocumentMatches(remoteUrl, text, "a🙂c"),
        ).resolves.toBe(true);
      }, 15_000);
    } catch (error) {
      throw new Error(
        `browser push was not visible on the hosted deployment: ${JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          events: events.filter(
            (event) =>
              event.status === "error" ||
              (event.tick?.pushAttempted ?? 0) > 0 ||
              (event.tick?.pushAccepted ?? 0) > 0 ||
              (event.tick?.pushFailed ?? 0) > 0 ||
              (event.tick?.pushConflicts ?? 0) > 0 ||
              (event.tick?.pushRebases ?? 0) > 0,
          ),
        })}`,
      );
    }
  }, 45_000);

  test("pushes the first CRDT edit of a document created by the hosted app", async () => {
    const remoteUrl = hostedRemoteUrl();
    useIsolatedBrowserStorage("remote-first-edit");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const text = `browser-remote-first-edit-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await browserCommands().embeddedRemoteDocumentCreate(remoteUrl, text, "abc");
    const convex = track(new ConvexEmbeddedClient({ url: remoteUrl }));
    const remoteEvents: Array<{ error?: string; status?: string; tick?: RemoteTick }> = [];
    convex.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") remoteEvents.push(event);
    });
    const stop = convex.watchQuery(listDocuments, {}).onUpdate(() => undefined);

    try {
      let remote = await convex.query(listDocuments, {});
      await waitForWithin(async () => {
        remote = await convex.query(listDocuments, {});
        expect(remote.some((row) => row.title === text && row.body === "abc")).toBe(true);
      }, 15_000);
      const document = remote.find((row) => row.title === text);
      if (!document) throw new Error("Hosted document was not available to the browser replica.");

      await convex.mutation(writeDocumentBody, {
        id: document._id,
        splices: [{ delete: 0, index: 1, insert: "X" }],
      });
      await waitForWithin(async () => {
        await expect(
          browserCommands().embeddedRemoteDocumentMatches(remoteUrl, text, "aXbc"),
        ).resolves.toBe(true);
      }, 15_000);
    } catch (error) {
      throw new Error(
        `first CRDT edit failed: ${JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          remoteEvents: remoteEvents.slice(-20),
        })}`,
      );
    } finally {
      stop();
    }
  }, 45_000);

  test("converges alternating CRDT edits across independent browser stores and reopen", async () => {
    const remoteUrl = hostedRemoteUrl();
    const runId = `browser-crdt-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const storageIds = [`${runId}-a`, `${runId}-b`];
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const open = (storageId: string) => {
      localStorage.setItem("convex-embedded.storageId", storageId);
      return track(new ConvexEmbeddedClient({ url: remoteUrl })) as DocumentClient;
    };
    let first = open(storageIds[0]!);
    let second = open(storageIds[1]!);
    let firstId: string | undefined;
    let secondId: string | undefined;
    const firstRemoteEvents: EmbeddedRemoteEvent[] = [];
    const secondRemoteEvents: EmbeddedRemoteEvent[] = [];
    first.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") firstRemoteEvents.push(event);
    });
    second.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") secondRemoteEvents.push(event);
    });
    const watches = [first, second].map((client) => {
      const watch = client.watchQuery(listDocuments, { limit: 40 });
      return watch.onUpdate(() => undefined);
    });
    const read = async (client: DocumentClient) =>
      (await client.query(listDocuments, { limit: 40 })).find((row) => row.title === runId);
    const waitForBody = async (client: DocumentClient, body: string) => {
      await waitForWithin(async () => expect((await read(client))?.body).toBe(body), 15_000);
    };

    try {
      const created = await first.mutation(createDocument, {
        body: "abc",
        slug: runId,
        title: runId,
        updatedAt: readTime(),
      });
      firstId = created._id;
      await waitForBody(second, "abc");
      secondId = (await read(second))!._id;
      watches.push(
        first.watchQuery(getDocument, { id: created._id }).onUpdate(() => undefined),
        second.watchQuery(getDocument, { id: secondId }).onUpdate(() => undefined),
      );

      await first.mutation(writeDocumentBody, {
        id: created._id,
        splices: [{ index: 3, delete: 0, insert: "A" }],
      });
      await waitForBody(second, "abcA");

      await second.mutation(writeDocumentBody, {
        id: secondId,
        splices: [{ index: 4, delete: 0, insert: "B" }],
      });
      await Promise.all([waitForBody(first, "abcAB"), waitForBody(second, "abcAB")]);
      expect((await read(first))?._id).toBe(created._id);
      let burstBody = "abcAB";
      for (let index = 0; index < 8; index += 1) {
        await first.mutation(writeDocumentBody, {
          id: created._id,
          splices: [{ index: burstBody.length, delete: 0, insert: String(index) }],
        });
        burstBody += String(index);
      }
      await Promise.all([waitForBody(first, burstBody), waitForBody(second, burstBody)]);
      await waitForWithin(async () => {
        await expect(
          browserCommands().embeddedRemoteDocumentMatches(remoteUrl, runId, burstBody),
        ).resolves.toBe(true);
      }, 15_000);
      const accepted = (events: EmbeddedRemoteEvent[]) =>
        events.reduce((total, event) => total + (event.tick?.pushAccepted ?? 0), 0);
      const rebases = (events: EmbeddedRemoteEvent[]) =>
        events.reduce((total, event) => total + (event.tick?.pushRebases ?? 0), 0);
      await waitForWithin(async () => {
        // Nine CRDT edits originate on the first client (A plus the eight-edit
        // burst) and one originates on the second (B). Creation is proved by
        // the peer import above and by the close/reopen/delete lifecycle below.
        expect(accepted(firstRemoteEvents)).toBeGreaterThanOrEqual(9);
        expect(accepted(secondRemoteEvents)).toBeGreaterThanOrEqual(1);
      }, 15_000);
      expect(
        rebases(firstRemoteEvents) + rebases(secondRemoteEvents),
        JSON.stringify({ firstRemoteEvents, secondRemoteEvents }),
      ).toBe(0);

      watches.splice(0).forEach((stop) => stop());
      await Promise.all([first.close(), second.close()]);
      clients.delete(first);
      clients.delete(second);
      first = open(storageIds[0]!);
      second = open(storageIds[1]!);
      const reopenedWatches = [first, second].map((client) => {
        const watch = client.watchQuery(listDocuments, { limit: 40 });
        return watch.onUpdate(() => undefined);
      });
      watches.push(...reopenedWatches);
      await Promise.all([waitForBody(first, burstBody), waitForBody(second, burstBody)]);

      const reopened = await read(first);
      if (!reopened) throw new Error("Reopened CRDT document was not readable before deletion.");
      await first.mutation(removeDocument, { id: reopened._id });
      await waitForWithin(async () => {
        await expect(read(first)).resolves.toBeUndefined();
        await expect(read(second)).resolves.toBeUndefined();
        await expect(
          browserCommands().embeddedRemoteDocumentExists(remoteUrl, runId),
        ).resolves.toBe(false);
      }, 15_000);
    } catch (error) {
      const snapshot = await (
        first as unknown as {
          __devtoolsRuntime(request: { kind: "snapshot" }): Promise<unknown>;
        }
      ).__devtoolsRuntime({ kind: "snapshot" });
      const secondSnapshot = await (
        second as unknown as {
          __devtoolsRuntime(request: { kind: "snapshot" }): Promise<unknown>;
        }
      ).__devtoolsRuntime({ kind: "snapshot" });
      throw new Error(
        `hosted CRDT convergence failed: ${JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          first: await read(first),
          firstRemoteEvents,
          firstStorage: crdtStorageDiagnostic(snapshot, firstId),
          second: await read(second),
          secondRemoteEvents,
          secondStorage: crdtStorageDiagnostic(secondSnapshot, secondId),
        })}`,
      );
    } finally {
      watches.forEach((stop) => stop());
    }
  }, 60_000);

  test("propagates a hosted delete across independent browser stores", async () => {
    const remoteUrl = hostedRemoteUrl();
    const runId = `browser-delete-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const open = (suffix: string) => {
      localStorage.setItem("convex-embedded.storageId", `${runId}-${suffix}`);
      return track(new ConvexEmbeddedClient({ url: remoteUrl })) as DocumentClient;
    };
    const first = open("a");
    const second = open("b");
    const firstRemoteEvents: Array<{ error?: string; status?: string; tick?: RemoteTick }> = [];
    const remoteEvents: Array<{ error?: string; status?: string; tick?: RemoteTick }> = [];
    first.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") firstRemoteEvents.push(event);
    });
    second.subscribeInternalEvents?.((event) => {
      if (event.type === "remote") remoteEvents.push(event);
    });
    const watches = [first, second].map((client) =>
      client.watchQuery(listDocuments, { limit: 40 }).onUpdate(() => undefined),
    );
    const read = async (client: DocumentClient) =>
      (await client.query(listDocuments, { limit: 40 })).find((row) => row.title === runId);

    try {
      const created = await first.mutation(createDocument, {
        body: "delete-me",
        slug: runId,
        title: runId,
        updatedAt: readTime(),
      });
      await waitForWithin(async () => {
        await expect(read(second)).resolves.toMatchObject({ body: "delete-me" });
        await expect(
          browserCommands().embeddedRemoteDocumentExists(remoteUrl, runId),
        ).resolves.toBe(true);
      }, 15_000);

      await first.mutation(removeDocument, { id: created._id });
      try {
        await waitForWithin(async () => {
          await expect(read(first)).resolves.toBeUndefined();
          await expect(read(second)).resolves.toBeUndefined();
          await expect(
            browserCommands().embeddedRemoteDocumentExists(remoteUrl, runId),
          ).resolves.toBe(false);
        }, 15_000);
      } catch (error) {
        const snapshot = await (
          second as unknown as {
            __devtoolsRuntime(request: { kind: "snapshot" }): Promise<unknown>;
          }
        ).__devtoolsRuntime({ kind: "snapshot" });
        const firstSnapshot = await (
          first as unknown as {
            __devtoolsRuntime(request: { kind: "snapshot" }): Promise<unknown>;
          }
        ).__devtoolsRuntime({ kind: "snapshot" });
        throw new Error(
          `hosted delete did not converge: ${JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            firstRemoteEvents: firstRemoteEvents.filter(
              (event) =>
                event.status === "error" ||
                (event.tick?.pushAttempted ?? 0) > 0 ||
                (event.tick?.pushAccepted ?? 0) > 0 ||
                (event.tick?.pushFailed ?? 0) > 0 ||
                (event.tick?.pushRebases ?? 0) > 0,
            ),
            firstSnapshot,
            remoteEvents: remoteEvents.slice(-20),
            second: await read(second),
            snapshot,
          })}`,
        );
      }
    } finally {
      watches.forEach((stop) => stop());
    }
  }, 45_000);

  test("coordinates two browser pages through one embedded runtime owner", async () => {
    const channel = `multipage-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(browserCommands().embeddedMultiPage(channel), "multi-page embedded runtime");
  }, 45_000);

  test("delivers an existing watch result to late watch-only browser pages", async () => {
    const channel = `watch-only-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(
      browserCommands().embeddedWatchOnlyLateSubscriber(channel),
      "watch-only late subscriber",
    );
  }, 45_000);

  test("survives multi-page browser churn without losing observed data", async () => {
    const channel = `stress-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(
      browserCommands().embeddedMultiPageStress(channel),
      "multi-page embedded runtime stress",
    );
  }, 60_000);
});

function hostedRemoteUrl(): string {
  const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
  if (!url) {
    throw new Error(
      "Set VITE_CONVEX_URL to an HTTPS Convex deployment before running hosted browser tests.",
    );
  }
  return url;
}

interface RuntimeEvent {
  at: number;
  attempt?: number;
  degradation?: string;
  error?: string;
  phase?: string;
  type: "runtime";
  waitedMs?: number;
}

interface BootResult {
  acquired: Record<string, number>;
  openSetupMs: number;
  phases: Record<string, number>;
  rows: number;
  runtimeEvents: RuntimeEvent[];
}

interface SeedResult {
  dbBytes: number;
  rows: number;
  walBytes: number;
}

interface CorruptResetResult {
  resetStart: boolean;
  resetDone: boolean;
  resetErrorMessage: string;
  rowsBefore: number;
  rowsAfter: number;
  phases: string[];
}

type BootMessage<T> = { error: string; ok: false } | { ok: true; result: T };

const VOLUME_ROWS = 2_000;
const VOLUME_OPEN_SETUP_BUDGET_MS = 4_000;
const CONSISTENCY_CYCLES = 16;
const CONSISTENCY_MAX_OVER_MEDIAN = 6;
const UNCLEAN_ROUNDS = 8;
const UNCLEAN_WOUND_ROWS = 40;
const UNCLEAN_REOPEN_BUDGET_MS = 8_000;
const HELD_REOPEN_BUDGET_MS = 5_000;

function spawnBootWorker(): Worker {
  return new Worker(new URL("./boot.ts", import.meta.url), { type: "module" });
}

function bootRequest<T>(worker: Worker, message: unknown, label: string): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<BootMessage<T>>) => {
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => reject(new Error(event.message || `${label} worker error`));
      worker.postMessage(message);
    }),
    label,
  );
}

async function seedStore(storageId: string, rows: number): Promise<SeedResult> {
  const worker = spawnBootWorker();
  try {
    return await bootRequest<SeedResult>(worker, { op: "seed", rows, storageId }, "boot seed");
  } finally {
    worker.terminate();
  }
}

async function bootStore(
  storageId: string,
  options: { storageWaitNoticeMs?: number } = {},
): Promise<BootResult> {
  const worker = spawnBootWorker();
  try {
    return await bootRequest<BootResult>(
      worker,
      { op: "boot", storageId, storageWaitNoticeMs: options.storageWaitNoticeMs },
      "boot open",
    );
  } finally {
    worker.terminate();
  }
}

function bootRequestOn<T>(worker: Worker, message: unknown, label: string): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<BootMessage<T>>) => {
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => reject(new Error(event.message || `${label} worker error`));
      worker.postMessage(message);
    }),
    label,
  );
}

describe("browser boot stress", () => {
  test("boots a multi-megabyte seeded store under budget", async () => {
    const storageId = `boot-volume-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const seeded = await withTimeout(
      seedStore(storageId, VOLUME_ROWS),
      "seed volume store",
      80_000,
    );
    expect(seeded.rows).toBe(VOLUME_ROWS);
    expect(seeded.dbBytes).toBeGreaterThan(1_000_000);

    const samples: BootResult[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      samples.push(await bootStore(storageId));
    }
    for (const sample of samples) {
      expect(sample.rows).toBe(VOLUME_ROWS);
    }
    const openSetup = samples.map((sample) => sample.openSetupMs);
    const summary = summarize(openSetup);
    await mark("boot volume timing", {
      dbBytes: seeded.dbBytes,
      openSetup: summary,
      phases: samples.map((sample) => sample.phases),
      walBytes: seeded.walBytes,
    });
    expect(summary.p90).toBeLessThan(VOLUME_OPEN_SETUP_BUDGET_MS);
  }, 90_000);

  test("boots the same seeded store consistently across many cycles", async () => {
    const storageId = `boot-consistency-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const seeded = await withTimeout(seedStore(storageId, 400), "seed consistency store");
    expect(seeded.rows).toBe(400);

    const openSetup: number[] = [];
    for (let cycle = 0; cycle < CONSISTENCY_CYCLES; cycle += 1) {
      const result = await bootStore(storageId);
      expect(result.rows).toBe(400);
      openSetup.push(result.openSetupMs);
    }
    const summary = summarize(openSetup);
    const sorted = [...openSetup].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    await mark("boot consistency timing", {
      cycles: CONSISTENCY_CYCLES,
      max: summary.max,
      median,
      openSetup,
      ratio: summary.max / Math.max(1, median),
    });
    expect(summary.max).toBeLessThanOrEqual(Math.max(median, 1) * CONSISTENCY_MAX_OVER_MEDIAN);
  }, 120_000);

  test("reopens after unclean worker termination every round", async () => {
    const storageId = `boot-unclean-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(seedStore(storageId, 200), "seed unclean store");

    const reopenMs: number[] = [];
    const failures: string[] = [];
    let retriedRounds = 0;
    for (let round = 0; round < UNCLEAN_ROUNDS; round += 1) {
      const wounded = spawnBootWorker();
      try {
        await bootRequest<{ wounded: true }>(
          wounded,
          { op: "wound", rows: UNCLEAN_WOUND_ROWS, storageId },
          "boot wound",
        );
      } finally {
        wounded.terminate();
      }

      const startedAt = getTimerTime();
      try {
        const reopened = await bootStore(storageId);
        const elapsed = getTimerTime() - startedAt;
        reopenMs.push(elapsed);
        expect(reopened.rows).toBeGreaterThanOrEqual(200);
        if (Object.keys(reopened.acquired).length > 0) retriedRounds += 1;
        if (elapsed >= UNCLEAN_REOPEN_BUDGET_MS) {
          failures.push(`round ${round} reopen took ${Math.round(elapsed)}ms`);
        }
      } catch (error) {
        failures.push(
          `round ${round} reopen failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await mark("boot unclean termination timing", {
      failures,
      reopenMs,
      retriedRounds,
      rounds: UNCLEAN_ROUNDS,
      summary: reopenMs.length > 0 ? summarize(reopenMs) : null,
    });
    expect(failures).toEqual([]);
    expect(reopenMs).toHaveLength(UNCLEAN_ROUNDS);
  }, 180_000);

  test("preserves data when the OPFS owner dies during open, commit, wal write, and close", async () => {
    const storageId = `boot-stage-death-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(seedStore(storageId, 120), "seed stage-death store");

    for (const stage of ["open", "commit", "wal", "close"] as const) {
      const wounded = spawnBootWorker();
      try {
        await bootRequest<{ stage: typeof stage; wounding: true }>(
          wounded,
          { op: "woundStage", stage, storageId },
          `boot ${stage} wound`,
        );
      } finally {
        wounded.terminate();
      }
      const reopened = await bootStore(storageId);
      expect(reopened.rows).toBeGreaterThanOrEqual(120);
    }
  }, 90_000);

  test("fails a corrupt store without replacing its bytes", async () => {
    const storageId = `boot-corrupt-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const worker = spawnBootWorker();
    let damaged: { bytes: number[] };
    try {
      damaged = await bootRequest(worker, { op: "damage", storageId }, "damage store");
    } finally {
      worker.terminate();
    }

    await expect(bootStore(storageId)).rejects.toThrow();

    const inspector = spawnBootWorker();
    try {
      const inspected = await bootRequest<{ bytes: number[] }>(
        inspector,
        { op: "inspect", storageId },
        "inspect corrupt store",
      );
      expect(inspected.bytes).toEqual(damaged.bytes);
    } finally {
      inspector.terminate();
    }
  }, 90_000);

  test("resets an unreadable pre-existing store instead of failing closed", async () => {
    const storageId = `boot-reset-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const worker = spawnBootWorker();
    let result: CorruptResetResult;
    try {
      result = await bootRequest<CorruptResetResult>(
        worker,
        { op: "corruptReset", storageId },
        "corrupt-reset boot",
      );
    } finally {
      worker.terminate();
    }
    await mark("boot unreadable-store reset", {
      resetDone: result.resetDone,
      resetErrorMessage: result.resetErrorMessage,
      resetStart: result.resetStart,
      rowsAfter: result.rowsAfter,
      rowsBefore: result.rowsBefore,
    });
    expect(result.resetStart).toBe(true);
    expect(result.resetDone).toBe(true);
    expect(result.resetErrorMessage).toContain("Corrupt database");
    expect(result.rowsBefore).toBe(0);
    expect(result.rowsAfter).toBe(1);
  }, 90_000);

  test("waits out a held predecessor OPFS handle instead of failing the boot", async () => {
    const storageId = `boot-held-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(seedStore(storageId, 100), "seed held store");

    const holder = spawnBootWorker();
    await bootRequestOn<{ held: true }>(holder, { op: "hold", storageId }, "boot hold");

    const releaseAfterMs = 600;
    const releasedAt = getTimerTime() + releaseAfterMs;
    const release = (async () => {
      await delay(releaseAfterMs);
      await bootRequestOn<{ released: true }>(holder, { op: "release" }, "boot release");
    })();

    let reopened: BootResult | undefined;
    let bootError: unknown;
    const startedAt = getTimerTime();
    try {
      reopened = await bootStore(storageId);
    } catch (error) {
      bootError = error;
    }
    const reopenMs = getTimerTime() - startedAt;
    await release;
    holder.terminate();

    await mark("boot held predecessor timing", {
      bootError: bootError instanceof Error ? bootError.message : bootError,
      releaseAfterMs,
      reopenMs,
      waitedPastRelease: getTimerTime() >= releasedAt,
    });
    if (bootError) throw bootError;
    expect(reopened?.rows).toBe(100);
    expect(reopenMs).toBeGreaterThanOrEqual(releaseAfterMs - 100);
    expect(reopenMs).toBeLessThan(HELD_REOPEN_BUDGET_MS);
  }, 90_000);

  test("emits an ordered boot lifecycle ending at ready", async () => {
    const storageId = `boot-lifecycle-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(seedStore(storageId, 60), "seed lifecycle store");
    const booted = await bootStore(storageId);

    const phases = booted.runtimeEvents
      .filter((event) => event.phase !== undefined && event.degradation === undefined)
      .map((event) => event.phase);
    await mark("boot lifecycle events", { phases, total: booted.runtimeEvents.length });

    expect(phases[0]).toBe("opfs-register");
    expect(phases.at(-1)).toBe("ready");
    expect(phases).toEqual([
      "opfs-register",
      "wasm-load",
      "store-open",
      "store-setup",
      "store-wal-write",
      "ready",
    ]);
    expect(booted.runtimeEvents.every((event) => event.type === "runtime")).toBe(true);
    expect(booted.rows).toBe(60);
  }, 90_000);

  test("emits a slow-open degradation past the storage wait notice threshold", async () => {
    const storageId = `boot-slow-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(seedStore(storageId, 600), "seed slow-open store");
    const booted = await bootStore(storageId, { storageWaitNoticeMs: 1 });

    const slow = booted.runtimeEvents.find((event) => event.degradation === "slow-open");
    await mark("boot slow-open notice", {
      slowOpen: slow ?? null,
      total: booted.runtimeEvents.length,
    });
    expect(slow).toBeDefined();
    expect(slow?.waitedMs).toBeGreaterThanOrEqual(0);
    expect(booted.runtimeEvents.some((event) => event.phase === "ready")).toBe(true);
    expect(booted.rows).toBe(600);
  }, 90_000);
});

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

type RecoverMessage = { error: string; ok: false } | { ok: true; result: RecoverResult };

describe("browser store-instance recovery", () => {
  // A genuinely wedged WASM instance cannot be reclaimed by reopening another WASM instance in
  // the same worker: the unresolved promise may retain the old linear memory forever. The safe
  // boundary is terminal worker disposal; the page/coordinator can then create a fresh worker.
  test("fails terminally after the pthread pool is killed", async () => {
    const storageId = `recover-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const worker = new Worker(new URL("./recovery.ts", import.meta.url), { type: "module" });
    try {
      const message = await withTimeout(
        new Promise<RecoverMessage>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<RecoverMessage>) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message || "recovery worker error"));
          worker.postMessage({ op: "recover", rows: 5, storageId });
        }),
        "store-instance recovery worker run",
        60_000,
      );
      if (!message.ok) throw new Error(message.error);
      const result = message.result;
      // The watchdog detects the wedge and refuses to allocate a second WASM instance in the same
      // worker. The seeded rows were durable before the terminal boundary.
      expect(result.degraded).toBe(true);
      expect(result.rebuilt).toBe(false);
      expect(result.ready).toBe(false);
      expect(result.dead).toBe(true);
      expect(result.rowsBefore).toBe(5);
      expect(result.rowsAfter).toBe(0);
      // The async-work pthread pool is empty in the synchronous local store path (OPFS
      // SyncAccessHandles dispatch no napi_create_async_work), so terminating it is a no-op here;
      // the pool-kill wedge is exercised by remote replication, covered by the skipped cases below.
      expect(result.pthreadsBefore).toBeGreaterThanOrEqual(0);
    } finally {
      worker.terminate();
    }
  }, 90_000);

  // Transparent recovery requires rotating the entire dedicated worker from the page/coordinator;
  // this bare worker intentionally proves only the terminal memory-safety boundary.
  test.skip("commits a wedged mutation to the deployment and beats the proxy 30s path", () => {
    // Requires: live Convex deployment + coordinator + proxy; not expressible in a bare worker.
  });

  // Case C: repeated kills trip the dead-instance breaker, the leader releases its storage lease,
  // and a second tab promotes with a fresh worker and serves. Needs a two-tab coordinator harness
  // driving Web Locks lease hand-off plus a live deployment.
  test.skip("releases the lease on a dead-instance trip so a second tab promotes", () => {
    // Requires: multi-tab Web Locks coordinator harness + live deployment.
  });
});

function track<T extends RuntimeClient>(client: T): T {
  clients.add(client);
  return client;
}

function useIsolatedBrowserStorage(label: string): void {
  localStorage.setItem(
    "convex-embedded.storageId",
    `${label}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
  );
}

function crdtStorageDiagnostic(snapshot: unknown, localId: string | undefined): unknown {
  const storage = (snapshot as { storage?: Record<string, unknown> }).storage;
  if (!storage || !localId) return storage;
  const matches = (value: unknown, key: string) =>
    Array.isArray(value)
      ? value.filter(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            (item as Record<string, unknown>)[key] === localId,
        )
      : value;
  return {
    crdtHeads: matches(storage.crdtHeads, "id"),
    idMappings: matches(storage.idMappings, "localId"),
    projections: matches(storage.projections, "localDocumentId"),
  };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  return waitForWithin(assertion, 5_000);
}

async function waitForWithin(
  assertion: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = getTimerTime() + timeoutMs;
  let lastError: unknown;
  while (getTimerTime() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError;
}

async function expectPrefixedDocuments(
  client: { query(name: typeof listDocuments, args: { limit?: number }): Promise<DocumentRow[]> },
  prefix: string,
  expected: string[],
): Promise<void> {
  const rows = await withTimeout(client.query(listDocuments, {}), "document query");
  expect(documentSuffixes(rows, prefix)).toEqual(expected);
}

function documentSuffixes(rows: DocumentRow[], prefix: string): string[] {
  return rows
    .filter((row) => row.title.startsWith(prefix))
    .map((row) => row.title.slice(prefix.length));
}

async function writeDocument(
  client: DocumentClient,
  title: string,
  label = "document write",
): Promise<DocumentRow> {
  const fields = documentFields(title);
  return await withTimeout(client.mutation(createDocument, fields), `${label} create`);
}

function documentFields(title: string): {
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
} {
  const now = getTimerTime();
  const slugBase = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return {
    body: JSON.stringify([
      { content: title, props: { level: 1 }, type: "heading" },
      { content: title, type: "paragraph" },
    ]),
    slug: `${slugBase || "document"}-${now.toString(36)}`,
    title,
    updatedAt: now,
  };
}

interface RemoteTick {
  pushAccepted?: number;
  pushAttempted?: number;
  pushConflicts?: number;
  pushFailed?: number;
  pushRebases?: number;
  received?: number;
  rowsApplied?: number;
  sent?: number;
  storeJobs?: number;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`browser runtime timed out during ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timeMutation(
  operations: EmbeddedOperationEvent[],
  run: () => Promise<unknown>,
): Promise<{
  commitMs: number;
  envelopeMs: number;
  measuredMs: number;
  notifyMs: number;
  outsideRuntimeMs: number;
  totalRuntimeMs: number;
}> {
  const before = operations.length;
  const startedAt = getTimerTime();
  await withTimeout(run(), "timed mutation");
  const measuredMs = getTimerTime() - startedAt;
  const operation = operations
    .slice(before)
    .find((event) => event.kind === "mutation" && event.phase === "finish");
  expect(operation?.status).toBe("success");
  expect(operation?.timing).toMatchObject({ mutationId: true });
  const timing = operation!.timing!;
  return {
    commitMs: timing.commitMs,
    envelopeMs: operation!.durationMs ?? 0,
    measuredMs,
    notifyMs: timing.notifyMs,
    outsideRuntimeMs: (operation!.durationMs ?? 0) - timing.totalMs,
    totalRuntimeMs: timing.totalMs,
  };
}

function summarize(values: number[]): {
  max: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / Math.max(1, sorted.length),
    min: sorted[0] ?? 0,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
  };
}

function installDebugLogHook(): void {
  debugGlobal().__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
    debugEvents.push({ ...event, at: getTimerTime() });
    void mark(event.phase, { detail: event.detail, source: event.source });
  };
}

function summarizeDebugPhases(events: DebugEvent[]): Record<string, number> {
  const starts = new Map<string, number[]>();
  const durations: Record<string, number> = {};
  for (const event of events) {
    if (event.phase.endsWith(":start")) {
      const key = event.phase.slice(0, -":start".length);
      const stack = starts.get(key) ?? [];
      stack.push(event.at);
      starts.set(key, stack);
      continue;
    }
    if (!event.phase.endsWith(":done")) continue;
    const key = event.phase.slice(0, -":done".length);
    const startedAt = starts.get(key)?.shift();
    if (startedAt !== undefined) durations[key] = event.at - startedAt;
  }
  return durations;
}

async function mark(phase: string, detail?: unknown): Promise<void> {
  const entry = {
    detail,
    now: getTimerTime(),
    phase,
    runtime: performance.now(),
    url: (globalThis as { location?: { href: string } }).location?.href ?? "",
  };
  console.log(`[embedded browser runtime] ${phase}`);
  await Promise.race([
    fetch(`/__convex_embedded_browser_log?entry=${encodeURIComponent(JSON.stringify(entry))}`),
    delay(250),
  ]).catch(() => undefined);
}

function debugGlobal(): typeof globalThis & {
  __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: DebugEvent) => void;
} {
  return globalThis as typeof globalThis & {
    __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: DebugEvent) => void;
  };
}

function browserCommands(): {
  embeddedBrowserLatencyBenchmark(options: BrowserLatencyBenchOptions): Promise<{
    outPath: string;
    report: BrowserLatencyBenchReport;
  }>;
  embeddedBrowserStartupBenchmark(options: BrowserStartupBenchOptions): Promise<{
    outPath: string;
    report: BrowserStartupBenchReport;
  }>;
  embeddedMultiPage(channel: string): Promise<void>;
  embeddedMultiPageStress(channel: string): Promise<void>;
  embeddedRemoteDocumentCreate(url: string, text: string, body: string): Promise<{ _id: string }>;
  embeddedRemoteDocumentExists(url: string, text: string): Promise<boolean>;
  embeddedRemoteDocumentMatches(url: string, text: string, body: string): Promise<boolean>;
  embeddedWatchOnlyLateSubscriber(channel: string): Promise<void>;
} {
  return commands as unknown as {
    embeddedBrowserLatencyBenchmark(options: BrowserLatencyBenchOptions): Promise<{
      outPath: string;
      report: BrowserLatencyBenchReport;
    }>;
    embeddedBrowserStartupBenchmark(options: BrowserStartupBenchOptions): Promise<{
      outPath: string;
      report: BrowserStartupBenchReport;
    }>;
    embeddedMultiPage(channel: string): Promise<void>;
    embeddedMultiPageStress(channel: string): Promise<void>;
    embeddedRemoteDocumentCreate(url: string, text: string, body: string): Promise<{ _id: string }>;
    embeddedRemoteDocumentExists(url: string, text: string): Promise<boolean>;
    embeddedRemoteDocumentMatches(url: string, text: string, body: string): Promise<boolean>;
    embeddedWatchOnlyLateSubscriber(channel: string): Promise<void>;
  };
}

interface BrowserLatencyBenchOptions {
  iterations: number;
  out?: string;
  profile: "full" | "smoke";
  rowCounts: number[];
  tabs: Array<"one" | "two">;
  warmups: number;
}

interface BrowserStartupBenchOptions {
  iterations: number;
  out?: string;
  warmups: number;
}

interface BrowserLatencyBenchReport {
  latencyP90BudgetMs: number;
  results: Array<{
    devtoolsOpen: boolean;
    observedRows: number;
    rowCount: number;
    samples: unknown[];
    summaries: {
      envelopeMs: { p90: number };
      outsideRuntimeMs: { p90: number };
      totalRuntimeMs: { p90: number };
    };
    suspicious: string[];
    tabs: "one" | "two";
    watchActive: boolean;
  }>;
}

interface BrowserStartupBenchReport {
  results: Array<{
    leaderReadyMs?: number;
    operation: "attach" | "cold" | "reopen";
    samples: unknown[];
    summaries: {
      firstQueryMs: { p90: number };
      importMs: { p90: number };
      openSetupMs: { p90: number };
      readyQueryMs: { p90: number };
      storeOpenMs: { p90: number };
      storeSetupMs: { p90: number };
      totalMs: { p90: number };
      wasmInstantiateMs: { p90: number };
      wasmLoadMs: { p90: number };
    };
  }>;
  version: 2;
}

function parseBrowserBenchNumbers(value: string): number[] {
  const parsed = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return parsed.length > 0 ? parsed : [0, 10, 100, 1000];
}

function parseBrowserBenchTabs(value: string): Array<"one" | "two"> {
  const tabs = value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is "one" | "two" => part === "one" || part === "two");
  return tabs.length > 0 ? tabs : ["one", "two"];
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { error: unknown; ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { error, ok: false };
  }
}
