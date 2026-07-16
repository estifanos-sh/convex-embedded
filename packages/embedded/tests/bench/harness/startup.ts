import { getTimerTime } from "../../../src/time.js";
import type {
  BenchStats,
  BrowserStartupBenchOptions,
  BrowserStartupBenchReport,
  BrowserStartupBenchResult,
  BrowserStartupBenchSample,
  BrowserStartupPhaseTimings,
  PlaywrightCommandContext,
} from "./types.js";

export async function runBrowserStartupBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: BrowserStartupBenchOptions,
): Promise<BrowserStartupBenchReport> {
  const browser = commandContext.context.browser();
  const scenarioContext = browser ? await browser.newContext() : commandContext.context;
  const pages: import("playwright").Page[] = [];
  const pagePath = (label: string) =>
    `${pageUrl}?startup=${encodeURIComponent(`${label}-${getTimerTime()}-${Math.random()}`)}`;
  const openPage = async (label: string): Promise<import("playwright").Page> => {
    const page = await scenarioContext.newPage();
    pages.push(page);
    await page.goto(pagePath(label));
    return page;
  };
  const summarize = (values: number[]): BenchStats => {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const percentile = (percent: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)] ?? 0;
    return {
      max: sorted[sorted.length - 1] ?? 0,
      mean: sum / Math.max(1, sorted.length),
      min: sorted[0] ?? 0,
      p50: percentile(0.5),
      p90: percentile(0.9),
    };
  };
  const summarizeSamples = (
    operation: "attach" | "cold" | "reopen",
    samples: BrowserStartupBenchSample[],
    leaderReadyMs?: number,
  ): BrowserStartupBenchResult => ({
    leaderReadyMs,
    operation,
    samples,
    summaries: {
      closeMs: summarize(samples.map((sample) => sample.closeMs)),
      constructMs: summarize(samples.map((sample) => sample.constructMs)),
      firstQueryMs: summarize(samples.map((sample) => sample.firstQueryMs)),
      importMs: summarize(samples.map((sample) => sample.importMs)),
      opfsRegisterMs: summarize(samples.map((sample) => sample.phaseMs.opfsRegisterMs ?? 0)),
      openSetupMs: summarize(samples.map((sample) => sample.phaseMs.openSetupMs)),
      readyQueryMs: summarize(samples.map((sample) => sample.readyQueryMs)),
      storeWalWriteMs: summarize(samples.map((sample) => sample.phaseMs.storeWalWriteMs ?? 0)),
      storeOpenMs: summarize(samples.map((sample) => sample.phaseMs.storeOpenMs ?? 0)),
      storeSetupMs: summarize(samples.map((sample) => sample.phaseMs.storeSetupMs ?? 0)),
      totalMs: summarize(samples.map((sample) => sample.totalMs)),
      wasmBeforeInitMs: summarize(samples.map((sample) => sample.phaseMs.wasmBeforeInitMs ?? 0)),
      wasmFetchMs: summarize(samples.map((sample) => sample.phaseMs.wasmFetchMs ?? 0)),
      wasmInstantiateMs: summarize(samples.map((sample) => sample.phaseMs.wasmInstantiateMs ?? 0)),
      wasmLoadMs: summarize(samples.map((sample) => sample.phaseMs.wasmLoadMs ?? 0)),
    },
  });
  const timePageClient = async (
    page: import("playwright").Page,
    input: {
      measureImport: boolean;
      operation: "cold" | "reopen";
      storageId: string;
      token: string;
    },
  ): Promise<BrowserStartupBenchSample> =>
    await page.evaluate(
      async ({ browserUrl, measureImport, operation, storageId, token }) => {
        localStorage.setItem("convex-embedded.storageId", storageId);
        type DebugEvent = {
          at: number;
          detail?: unknown;
          phase: string;
          source: "worker";
        };
        type BrowserClientModule = {
          ConvexEmbeddedClient: new () => {
            close(): Promise<void>;
            query(name: string, args: Record<string, unknown>): Promise<unknown>;
          };
        };
        const debugEvents: DebugEvent[] = [];
        (
          globalThis as typeof globalThis & {
            __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: Omit<DebugEvent, "at">) => void;
          }
        ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
          debugEvents.push({ ...event, at: performance.now() });
        };
        const takeDebugEvents = (): DebugEvent[] => debugEvents.splice(0);
        const importClient = async (importToken: string): Promise<BrowserClientModule> => {
          const separator = browserUrl.includes("?") ? "&" : "?";
          return await import(
            `${browserUrl}${separator}startup=${encodeURIComponent(importToken)}`
          );
        };
        const phaseDurations = (events: DebugEvent[]): BrowserStartupPhaseTimings => {
          const starts = new Map<string, number[]>();
          const durations = new Map<string, number>();
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
            if (startedAt !== undefined) durations.set(key, event.at - startedAt);
          }
          const phaseMs: BrowserStartupPhaseTimings = {
            openSetupMs: 0,
            opfsRegisterMs: durations.get("worker:opfs:register"),
            storeWalWriteMs: durations.get("worker:store:wal-write"),
            storeOpenMs: durations.get("worker:store:open"),
            storeSetupMs: durations.get("worker:store:setup"),
            wasmBeforeInitMs: durations.get("worker:wasm:before-init"),
            wasmFetchMs: durations.get("worker:wasm:fetch"),
            wasmInstantiateMs: durations.get("worker:wasm:instantiate"),
            wasmLoadMs: durations.get("worker:wasm:load"),
          };
          phaseMs.openSetupMs =
            (phaseMs.opfsRegisterMs ?? 0) +
            (phaseMs.wasmLoadMs ?? 0) +
            (phaseMs.storeOpenMs ?? 0) +
            (phaseMs.storeSetupMs ?? 0) +
            (phaseMs.storeWalWriteMs ?? 0);
          return phaseMs;
        };
        let module: BrowserClientModule;
        let importMs = 0;
        if (measureImport) {
          const importStartedAt = performance.now();
          module = await importClient(token);
          importMs = performance.now() - importStartedAt;
        } else {
          module = await importClient(`warm-${token}`);
          takeDebugEvents();
        }
        const totalStartedAt = performance.now();
        const constructStartedAt = performance.now();
        const client = new module.ConvexEmbeddedClient();
        const constructMs = performance.now() - constructStartedAt;
        const readyStartedAt = performance.now();
        await client.query("documents:list", {});
        const readyQueryMs = performance.now() - readyStartedAt;
        const closeStartedAt = performance.now();
        await client.close();
        const closeMs = performance.now() - closeStartedAt;
        return {
          closeMs,
          constructMs,
          firstQueryMs: readyQueryMs,
          importMs,
          operation,
          phaseMs: phaseDurations(takeDebugEvents()),
          readyQueryMs,
          totalMs: performance.now() - totalStartedAt + importMs,
        };
      },
      { browserUrl, ...input },
    );
  const prepareReopenStorage = async (storageId: string, token: string): Promise<void> => {
    const page = await openPage(`reopen-prepare-${token}`);
    try {
      await timePageClient(page, {
        measureImport: false,
        operation: "reopen",
        storageId,
        token: `prepare-${token}`,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  };
  const timeAttachClient = async (
    page: import("playwright").Page,
    input: { storageId: string; token: string },
  ): Promise<{ leaderReadyMs: number; sample: BrowserStartupBenchSample }> =>
    await page.evaluate(
      async ({ browserUrl, storageId, token }) => {
        localStorage.setItem("convex-embedded.storageId", storageId);
        type DebugEvent = {
          at: number;
          detail?: unknown;
          phase: string;
          source: "worker";
        };
        type BrowserClientModule = {
          ConvexEmbeddedClient: new () => {
            close(): Promise<void>;
            query(name: string, args: Record<string, unknown>): Promise<unknown>;
          };
        };
        const debugEvents: DebugEvent[] = [];
        (
          globalThis as typeof globalThis & {
            __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: Omit<DebugEvent, "at">) => void;
          }
        ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
          debugEvents.push({ ...event, at: performance.now() });
        };
        const takeDebugEvents = (): DebugEvent[] => debugEvents.splice(0);
        const importClient = async (importToken: string): Promise<BrowserClientModule> => {
          const separator = browserUrl.includes("?") ? "&" : "?";
          return await import(
            `${browserUrl}${separator}startup=${encodeURIComponent(importToken)}`
          );
        };
        const phaseDurations = (events: DebugEvent[]): BrowserStartupPhaseTimings => {
          const starts = new Map<string, number[]>();
          const durations = new Map<string, number>();
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
            if (startedAt !== undefined) durations.set(key, event.at - startedAt);
          }
          const phaseMs: BrowserStartupPhaseTimings = {
            openSetupMs: 0,
            opfsRegisterMs: durations.get("worker:opfs:register"),
            storeWalWriteMs: durations.get("worker:store:wal-write"),
            storeOpenMs: durations.get("worker:store:open"),
            storeSetupMs: durations.get("worker:store:setup"),
            wasmBeforeInitMs: durations.get("worker:wasm:before-init"),
            wasmFetchMs: durations.get("worker:wasm:fetch"),
            wasmInstantiateMs: durations.get("worker:wasm:instantiate"),
            wasmLoadMs: durations.get("worker:wasm:load"),
          };
          phaseMs.openSetupMs =
            (phaseMs.opfsRegisterMs ?? 0) +
            (phaseMs.wasmLoadMs ?? 0) +
            (phaseMs.storeOpenMs ?? 0) +
            (phaseMs.storeSetupMs ?? 0) +
            (phaseMs.storeWalWriteMs ?? 0);
          return phaseMs;
        };
        const module = await importClient(`attach-${token}`);
        const leader = new module.ConvexEmbeddedClient();
        const leaderStartedAt = performance.now();
        await leader.query("documents:list", {});
        const leaderReadyMs = performance.now() - leaderStartedAt;
        takeDebugEvents();
        const totalStartedAt = performance.now();
        const constructStartedAt = performance.now();
        const follower = new module.ConvexEmbeddedClient();
        const constructMs = performance.now() - constructStartedAt;
        const readyStartedAt = performance.now();
        await follower.query("documents:list", {});
        const readyQueryMs = performance.now() - readyStartedAt;
        const closeStartedAt = performance.now();
        await follower.close();
        const closeMs = performance.now() - closeStartedAt;
        await leader.close();
        return {
          leaderReadyMs,
          sample: {
            closeMs,
            constructMs,
            firstQueryMs: readyQueryMs,
            importMs: 0,
            operation: "attach",
            phaseMs: phaseDurations(takeDebugEvents()),
            readyQueryMs,
            totalMs: performance.now() - totalStartedAt,
          },
        };
      },
      { browserUrl, ...input },
    );
  try {
    for (let index = 0; index < options.warmups; index += 1) {
      const page = await openPage(`startup-warmup-${index}`);
      try {
        await timePageClient(page, {
          measureImport: false,
          operation: "cold",
          storageId: `browser-startup-warmup-${index}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
          token: `warmup-${index}`,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const coldSamples: BrowserStartupBenchSample[] = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const page = await openPage(`startup-cold-${index}`);
      try {
        coldSamples.push(
          await timePageClient(page, {
            measureImport: true,
            operation: "cold",
            storageId: `browser-startup-cold-${index}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
            token: `cold-${index}-${getTimerTime()}`,
          }),
        );
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const reopenSamples: BrowserStartupBenchSample[] = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const storageId = `browser-startup-reopen-${index}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
      await prepareReopenStorage(storageId, `${index}`);
      const page = await openPage(`startup-reopen-${index}`);
      try {
        reopenSamples.push(
          await timePageClient(page, {
            measureImport: false,
            operation: "reopen",
            storageId,
            token: `reopen-${index}-${getTimerTime()}`,
          }),
        );
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const attachSamples: BrowserStartupBenchSample[] = [];
    const leaderReadySamples: number[] = [];
    for (let index = 0; index < options.warmups; index += 1) {
      const page = await openPage(`startup-attach-warmup-${index}`);
      try {
        await timeAttachClient(page, {
          storageId: `browser-startup-attach-warmup-${index}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
          token: `attach-warmup-${index}-${getTimerTime()}`,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    for (let index = 0; index < options.iterations; index += 1) {
      const page = await openPage(`startup-attach-${index}`);
      try {
        const timed = await timeAttachClient(page, {
          storageId: `browser-startup-attach-${index}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
          token: `attach-${index}-${getTimerTime()}`,
        });
        leaderReadySamples.push(timed.leaderReadyMs);
        attachSamples.push(timed.sample);
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const result = {
      results: [
        summarizeSamples("cold", coldSamples),
        summarizeSamples("reopen", reopenSamples),
        summarizeSamples("attach", attachSamples, summarize(leaderReadySamples).p90),
      ],
    };
    return {
      browser: "chromium",
      generatedAt: new Date().toISOString(),
      iterations: options.iterations,
      notes: [
        "cold uses a fresh page and fresh storage id, then dynamically imports the browser entrypoint before constructing the client",
        "reopen prepares an OPFS store in one page, closes it, then opens the same storage id from a fresh page",
        "attach keeps one leader client alive in the same page while measuring follower client construction/readiness",
        "readyQueryMs includes worker init/coordination and first query response for that client",
        "firstQueryMs is currently the same measured call as readyQueryMs; it is reported separately so future startup work can split queueing from query execution",
        "phaseMs is derived from worker debug start/done events: OPFS registration, WASM load/fetch/instantiate, store open/setup, and wal write",
      ],
      results: result.results,
      version: 2,
      warmups: options.warmups,
    };
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    if (scenarioContext !== commandContext.context) await scenarioContext.close();
  }
}
