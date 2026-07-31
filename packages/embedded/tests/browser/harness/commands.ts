import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { getTimerTime } from "../../../src/time.js";
import { runBrowserLatencyBenchmark } from "../../bench/harness/latency.js";
import {
  readBrowserLatencyBenchOptions,
  readBrowserRemoteBenchOptions,
  readBrowserScaleBenchOptions,
  readBrowserStartupBenchOptions,
  resolveBenchOutPath,
} from "../../bench/harness/options.js";
import {
  browserDistPath,
  browserRemoteBenchOutPath,
  browserScaleBenchOutPath,
  browserStartupBenchOutPath,
  createRootDocument,
  listRootDocuments,
} from "../../bench/harness/paths.js";
import { runBrowserRemoteBenchmark } from "../../bench/harness/remote.js";
import { runBrowserScaleBenchmark } from "../../bench/harness/scale.js";
import { runBrowserStartupBenchmark } from "../../bench/harness/startup.js";
import type {
  BrowserLatencyBenchOptions,
  BrowserRemoteBenchOptions,
  BrowserScaleBenchOptions,
  BrowserStartupBenchOptions,
  MetalDeviceState,
  PlaywrightCommandContext,
} from "../../bench/harness/types.js";
import {
  assertNoPageFailures,
  installEmbeddedPage,
  installMetalDevicePage,
  observePageFailures,
  sendPageMessage,
  waitForPageBodies,
} from "./page.js";
import type { EmbeddedPageState } from "./page.js";

export const browserCommands = {
  embeddedOfflineConflictReconnect: async (
    commandContext: unknown,
    remoteUrl: string,
    runId: string,
  ) => {
    const command = commandContext as PlaywrightCommandContext;
    const browser = command.context.browser();
    const context = browser ? await browser.newContext() : command.context;
    const ownsContext = context !== command.context;
    const page = await context.newPage();
    const failures: string[] = [];
    observePageFailures(page, failures);
    let observerContext: import("playwright").BrowserContext | undefined;
    let observerPage: import("playwright").Page | undefined;
    const pageUrl = new URL("/__convex_embedded_page", command.page.url()).toString();
    const browserUrl = `/@fs${browserDistPath}?offline=${getTimerTime()}`;
    const hosted = new ConvexHttpClient(remoteUrl);
    const history = makeFunctionReference<"query">("remote:history");
    const update = makeFunctionReference<"mutation">("documents:write");
    const remove = makeFunctionReference<"mutation">("documents:del");
    const initialTitle = `${runId}:local`;
    const offlineTitle = `${runId}:offline`;
    const authoritativeTitle = `${runId}:authoritative`;
    let remoteId: string | undefined;
    try {
      await installMetalDevicePage(page, pageUrl, browserUrl, {
        device: "offline-protocol",
        queryLimit: 100,
        remoteUrl,
        runId,
        storageId: `offline-protocol-${runId}`,
      });

      const eventStart = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
            .__embeddedMetalState.events.length,
      );
      const offlineHintStartedAt = getTimerTime();
      await context.setOffline(true);
      await waitForRemoteInvalidation(page, eventStart);
      const offlineHintMs = getTimerTime() - offlineHintStartedAt;
      const localId = await page.evaluate(
        async (title) =>
          await (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.create(title),
        initialTitle,
      );
      const offlineStatuses = await page.evaluate(
        (start) =>
          (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.events
            .slice(start)
            .filter((event) => event.type === "remote")
            .map((event) => event.status),
        eventStart,
      );
      if (!offlineStatuses.includes("offline")) {
        throw new Error(
          `Network loss never invalidated remote readiness: ${JSON.stringify(offlineStatuses)}`,
        );
      }
      const offlineRemoteState = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __embeddedMetalState: MetalDeviceState & {
                connectionState(): { local: string; remote: string };
              };
            }
          ).__embeddedMetalState.connectionState().remote,
      );

      const onlineEventStart = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
            .__embeddedMetalState.events.length,
      );
      const onlineHintStartedAt = getTimerTime();
      await context.setOffline(false);
      await waitForRemoteStatus(page, onlineEventStart, "starting");
      const onlineHintMs = getTimerTime() - onlineHintStartedAt;
      try {
        remoteId = await poll(async () => {
          const rows = (await hosted.query(listRootDocuments, {
            prefix: initialTitle,
          })) as unknown as Array<{ _id: string; title: string }>;
          return rows.find((row) => row.title === initialTitle)?._id;
        }, "offline mutation to reach Convex");
      } catch (error) {
        const diagnostic = await page.evaluate(async () => {
          const state = (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState;
          return {
            dirtyHeads: await state.dirtyHeads(),
            errors: state.errors,
            events: state.events.slice(-80),
            idMappings: await state.idMappings(),
            remoteTickTotals: state.remoteTickTotals,
            rows: await state.rows(),
          };
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
        );
      }
      await poll(
        async () =>
          await page.evaluate(async () => {
            const state = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState;
            return (await state.dirtyHeads()).length === 0;
          }),
        "first settlement to become durable",
      );

      observerContext = browser ? await browser.newContext() : context;
      observerPage = await observerContext.newPage();
      observePageFailures(observerPage, failures);
      await installMetalDevicePage(observerPage, pageUrl, browserUrl, {
        device: "offline-protocol-observer",
        queryLimit: 100,
        remoteUrl,
        runId,
        storageId: `offline-protocol-observer-${runId}`,
      });
      try {
        await poll(
          async () =>
            await observerPage!.evaluate(async (title) => {
              const state = (
                globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
              ).__embeddedMetalState;
              const rows = await state.rows();
              return rows.length === 1 && rows[0]?.title === title ? true : undefined;
            }, initialTitle),
          "independent browser to pull the created document",
        );
      } catch (error) {
        const observerDiagnostic = await observerPage.evaluate(async () => {
          const state = (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState;
          return {
            dirtyHeads: await state.dirtyHeads(),
            errors: state.errors,
            events: state.events.slice(-150),
            idMappings: await state.idMappings(),
            projections: await state.projections(),
            rows: await state.rows(),
          };
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(
            observerDiagnostic,
          )}`,
        );
      }

      const conflictEventStart = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
            .__embeddedMetalState.events.length,
      );
      await context.setOffline(true);
      await waitForRemoteInvalidation(page, conflictEventStart);
      await waitForRemoteStatus(page, conflictEventStart, "offline");
      await page.evaluate(
        async ({ id, title }) =>
          await (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.writeDraft(id, title),
        { id: localId, title: offlineTitle },
      );
      const beforeConflict = (await hosted.query(listRootDocuments, {
        prefix: runId,
      })) as unknown as Array<{ _id: string; title: string }>;
      const hostedBeforeConflict = beforeConflict.find((row) => row._id === remoteId);
      if (hostedBeforeConflict?.title !== initialTitle) {
        throw new Error(
          `Supposedly offline edit reached Convex before conflict setup: ${hostedBeforeConflict?.title}`,
        );
      }
      await hosted.mutation(update, { id: remoteId, title: authoritativeTitle });

      const conflictReconnectStartedAt = getTimerTime();
      await context.setOffline(false);
      await waitForRemoteStatus(page, conflictEventStart, "starting");
      const conflictStartingMs = getTimerTime() - conflictReconnectStartedAt;
      await waitForRemoteStatus(page, conflictEventStart, "connected");
      const conflictConnectedMs = getTimerTime() - conflictReconnectStartedAt;
      let converged: { revisions: number; title: string };
      try {
        converged = await poll(
          async () =>
            await page.evaluate(async (title) => {
              const state = (
                globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
              ).__embeddedMetalState;
              const row = await state.one();
              const revisions = await state.revs(row._id);
              return row.title === title && revisions.length > 0
                ? { revisions: revisions.length, title: row.title }
                : undefined;
            }, authoritativeTitle),
          "authoritative pull and retained offline revision",
        );
      } catch (error) {
        const hostedHistory = remoteId
          ? await hosted
              .query(history, { id: remoteId, cursor: null, numItems: 100 })
              .catch((historyError) => ({
                error: historyError instanceof Error ? historyError.message : String(historyError),
              }))
          : null;
        const diagnostic = await page.evaluate(async () => {
          const state = (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState;
          const rows = await state.rows();
          return {
            dirtyHeads: await state.dirtyHeads(),
            errors: state.errors,
            events: state.events.slice(-100),
            idMappings: await state.idMappings(),
            projections: await state.projections(),
            remoteTickTotals: state.remoteTickTotals,
            revisions: rows[0] ? await state.revs(rows[0]._id) : [],
            rows,
          };
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
            ...diagnostic,
            hostedHistory,
          })}`,
        );
      }
      const conflictAuthorityMs = getTimerTime() - conflictReconnectStartedAt;
      await waitForRemoteStatus(page, conflictEventStart, "idle");
      const conflictIdleMs = getTimerTime() - conflictReconnectStartedAt;
      const remoteRows = (await hosted.query(listRootDocuments, {
        prefix: authoritativeTitle,
      })) as Array<{ title: string }>;
      if (!remoteRows.some((row) => row.title === authoritativeTitle)) {
        throw new Error("Offline replay overwrote the authoritative hosted revision.");
      }
      const observed = await poll(
        async () =>
          await observerPage!.evaluate(async (title) => {
            const state = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState;
            const rows = await state.rows();
            const row = rows.length === 1 ? rows[0] : undefined;
            if (!row) return undefined;
            const revisions = await state.revs(row._id);
            return row.title === title && revisions.length > 0
              ? { revisions: revisions.length, title: row.title }
              : undefined;
          }, authoritativeTitle),
        "independent browser to pull authority and conflict history",
      );
      const conflictStatuses = await page.evaluate(
        (start) =>
          (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.events
            .slice(start)
            .filter((event) => event.type === "remote")
            .map((event) => event.status),
        conflictEventStart,
      );
      const reconnectTimings = {
        authorityMs: conflictAuthorityMs,
        connectedMs: conflictConnectedMs,
        idleMs: conflictIdleMs,
        startingMs: conflictStartingMs,
      };
      const timingPath = path.resolve(process.cwd(), "tests/bench/.out/reconnect.json");
      mkdirSync(path.dirname(timingPath), { recursive: true });
      writeFileSync(timingPath, `${JSON.stringify(reconnectTimings, null, 2)}\n`, "utf8");
      await assertNoPageFailures([page, observerPage], failures);
      return {
        ...converged,
        conflictAuthorityMs,
        conflictConnectedMs,
        conflictIdleMs,
        conflictStartingMs,
        conflictStatuses,
        observed,
        offlineHintMs,
        offlineRemoteState,
        offlineStatuses,
        onlineHintMs,
      };
    } finally {
      await context.setOffline(false).catch(() => undefined);
      if (remoteId) await hosted.mutation(remove, { id: remoteId }).catch(() => undefined);
      await observerPage
        ?.evaluate(async () => {
          await (
            globalThis as typeof globalThis & { __embeddedMetalState?: MetalDeviceState }
          ).__embeddedMetalState?.close();
        })
        .catch(() => undefined);
      await observerPage?.close().catch(() => undefined);
      if (observerContext && observerContext !== context) {
        await observerContext.close().catch(() => undefined);
      }
      await page
        .evaluate(async () => {
          await (
            globalThis as typeof globalThis & { __embeddedMetalState?: MetalDeviceState }
          ).__embeddedMetalState?.close();
        })
        .catch(() => undefined);
      await page.close().catch(() => undefined);
      if (ownsContext) await context.close().catch(() => undefined);
    }
  },
  embeddedOwnerHandoff: async (commandContext: unknown, remoteUrl: string, runId: string) => {
    const command = commandContext as PlaywrightCommandContext;
    const browser = command.context.browser();
    const context = browser ? await browser.newContext() : command.context;
    const ownsContext = context !== command.context;
    const owner = await context.newPage();
    const follower = await context.newPage();
    const lateFollower = await context.newPage();
    const pages = [owner, follower, lateFollower];
    const failures: string[] = [];
    for (const page of pages) observePageFailures(page, failures);
    const pageUrl = new URL("/__convex_embedded_page", command.page.url()).toString();
    const browserUrl = `/@fs${browserDistPath}?handoff=${getTimerTime()}`;
    const storageId = `owner-handoff-${runId}`;
    const initialTitle = `${runId}:owner`;
    const handoffTitle = `${runId}:follower`;
    const terminatedTitle = `${runId}:terminated-follower`;
    const hosted = new ConvexHttpClient(remoteUrl);
    const remove = makeFunctionReference<"mutation">("documents:del");
    let remoteId: string | undefined;
    try {
      await installMetalDevicePage(owner, pageUrl, browserUrl, {
        device: "owner-handoff-owner",
        queryLimit: 100,
        remoteUrl,
        runId,
        storageId,
      });
      await installMetalDevicePage(follower, pageUrl, browserUrl, {
        device: "owner-handoff-follower",
        queryLimit: 100,
        remoteUrl,
        runId,
        storageId,
      });

      await owner.evaluate(
        async (title) =>
          await (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.create(title),
        initialTitle,
      );
      remoteId = await poll(async () => {
        const rows = (await hosted.query(listRootDocuments, {
          prefix: initialTitle,
        })) as unknown as Array<{ _id: string; title: string }>;
        return rows.find((row) => row.title === initialTitle)?._id;
      }, "initial owner mutation to reach Convex");
      await poll(
        async () =>
          await follower.evaluate(async (title) => {
            const state = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState;
            const rows = await state.rows();
            return rows.length === 1 && rows[0]?.title === title ? true : undefined;
          }, initialTitle),
        "follower to observe the owner mutation",
        async () =>
          await follower.evaluate(async () => {
            const state = (
              globalThis as typeof globalThis & {
                __embeddedMetalState: MetalDeviceState & {
                  connectionState(): { local: string; remote: string };
                };
              }
            ).__embeddedMetalState;
            return {
              connection: state.connectionState(),
              devtoolsRows: (await state.allDevtoolsRows()).map((row) => row.title),
              errors: state.errors,
              events: state.events.slice(-100),
              remoteTickTotals: state.remoteTickTotals,
            };
          }),
      );

      const incumbent = await poll(
        async () =>
          await follower.evaluate(() => {
            const events = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState.events;
            for (let index = events.length - 1; index >= 0; index -= 1) {
              const event = events[index];
              const detail = event?.detail as
                | { generation?: number; incarnation?: string; sequence?: number }
                | undefined;
              if (
                event?.type === "remote" &&
                typeof detail?.incarnation === "string" &&
                (event.status === "connected" || event.status === "idle")
              ) {
                return {
                  generation: detail.generation,
                  incarnation: detail.incarnation,
                  sequence: detail.sequence,
                  status: event.status,
                };
              }
            }
            return undefined;
          }),
        "follower to receive the incumbent leader incarnation",
      );

      await owner.evaluate(() => globalThis.dispatchEvent(new Event("pagehide")));
      await poll(
        async () =>
          await owner.evaluate(async () => {
            const state = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState;
            try {
              await state.rows();
              return undefined;
            } catch {
              return true;
            }
          }),
        "page-hidden owner to stop accepting storage requests",
      );
      const followerLocalId = await follower.evaluate(async () => {
        const state = (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
          .__embeddedMetalState;
        return (await state.one())._id;
      });
      await follower.evaluate(
        async ({ id, title }) =>
          await (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.writeDraft(id, title),
        { id: followerLocalId, title: handoffTitle },
      );

      await poll(async () => {
        const rows = (await hosted.query(listRootDocuments, {
          prefix: handoffTitle,
        })) as unknown as Array<{ _id: string; title: string }>;
        return rows.some((row) => row._id === remoteId && row.title === handoffTitle)
          ? true
          : undefined;
      }, "promoted follower mutation to reach Convex");
      const temporaryStorage = await follower.evaluate(() =>
        (
          globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
        ).__embeddedMetalState.events.some(
          (event) => event.type === "runtime" && event.degradation === "temporary-storage",
        ),
      );
      const replacement = await poll(
        async () =>
          await follower.evaluate(
            ({ allowSame, incumbentIncarnation }) => {
              const state = (
                globalThis as typeof globalThis & {
                  __embeddedMetalState: MetalDeviceState & {
                    connectionState(): { local: string; remote: string };
                  };
                }
              ).__embeddedMetalState;
              if (state.connectionState().remote !== "ready") return undefined;
              let firstSequence: number | undefined;
              let ready:
                | {
                    generation?: number;
                    incarnation: string;
                    sequence?: number;
                    status: string;
                  }
                | undefined;
              for (let index = 0; index < state.events.length; index += 1) {
                const event = state.events[index];
                const detail = event?.detail as
                  | { generation?: number; incarnation?: string; sequence?: number }
                  | undefined;
                if (
                  event?.type === "remote" &&
                  typeof detail?.incarnation === "string" &&
                  (allowSame || detail.incarnation !== incumbentIncarnation)
                ) {
                  firstSequence ??= detail.sequence;
                  if (event.status === "idle") {
                    ready = {
                      generation: detail.generation,
                      incarnation: detail.incarnation,
                      sequence: detail.sequence,
                      status: event.status,
                    };
                  }
                }
              }
              return ready ? { ...ready, firstSequence } : undefined;
            },
            { allowSame: temporaryStorage, incumbentIncarnation: incumbent.incarnation },
          ),
        "promoted follower incarnation to reach ready",
        async () =>
          await follower.evaluate(() => {
            const state = (
              globalThis as typeof globalThis & {
                __embeddedMetalState: MetalDeviceState & {
                  connectionState(): { local: string; remote: string };
                };
              }
            ).__embeddedMetalState;
            return {
              connection: state.connectionState(),
              errors: state.errors,
              events: state.events.slice(-100),
              remoteTickTotals: state.remoteTickTotals,
            };
          }),
      );

      await installMetalDevicePage(lateFollower, pageUrl, browserUrl, {
        device: "owner-handoff-late-follower",
        queryLimit: 100,
        remoteUrl,
        runId,
        storageId,
      });
      const lateTitle = await poll(
        async () =>
          await lateFollower.evaluate(async (title) => {
            const state = (
              globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
            ).__embeddedMetalState;
            const rows = await state.rows();
            return rows.length === 1 && rows[0]?.title === title ? rows[0].title : undefined;
          }, handoffTitle),
        "late follower to converge after ownership handoff",
      );
      await follower.close();
      const lateFollowerLocalId = await lateFollower.evaluate(async () => {
        const state = (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
          .__embeddedMetalState;
        return (await state.one())._id;
      });
      await lateFollower.evaluate(
        async ({ id, title }) =>
          await (
            globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState }
          ).__embeddedMetalState.writeDraft(id, title),
        { id: lateFollowerLocalId, title: terminatedTitle },
      );
      await poll(async () => {
        const rows = (await hosted.query(listRootDocuments, {
          prefix: terminatedTitle,
        })) as unknown as Array<{ _id: string; title: string }>;
        return rows.some((row) => row._id === remoteId && row.title === terminatedTitle)
          ? true
          : undefined;
      }, "second promoted follower mutation to reach Convex");
      const secondReplacement = await poll(
        async () =>
          await lateFollower.evaluate((previousIncarnation) => {
            const state = (
              globalThis as typeof globalThis & {
                __embeddedMetalState: MetalDeviceState & {
                  connectionState(): { local: string; remote: string };
                };
              }
            ).__embeddedMetalState;
            if (state.connectionState().remote !== "ready") return undefined;
            let firstSequence: number | undefined;
            let ready:
              | {
                  generation?: number;
                  incarnation: string;
                  sequence?: number;
                  status: string;
                }
              | undefined;
            for (const event of state.events) {
              const detail = event.detail as
                | { generation?: number; incarnation?: string; sequence?: number }
                | undefined;
              if (
                event.type !== "remote" ||
                typeof detail?.incarnation !== "string" ||
                detail.incarnation === previousIncarnation
              ) {
                continue;
              }
              firstSequence ??= detail.sequence;
              if (event.status === "idle") {
                ready = {
                  generation: detail.generation,
                  incarnation: detail.incarnation,
                  sequence: detail.sequence,
                  status: event.status,
                };
              }
            }
            return ready ? { ...ready, firstSequence } : undefined;
          }, replacement.incarnation),
        "replacement after owner termination to reach ready",
      );
      const finalTitle = await lateFollower.evaluate(async () => {
        const state = (globalThis as typeof globalThis & { __embeddedMetalState: MetalDeviceState })
          .__embeddedMetalState;
        return (await state.one()).title;
      });
      await assertNoPageFailures([lateFollower], failures);
      return {
        finalTitle,
        incumbent,
        lateTitle,
        replacement,
        secondReplacement,
        temporaryStorage,
      };
    } finally {
      if (remoteId) await hosted.mutation(remove, { id: remoteId }).catch(() => undefined);
      await Promise.all(
        pages.map((page) =>
          page
            .evaluate(async () => {
              await (
                globalThis as typeof globalThis & { __embeddedMetalState?: MetalDeviceState }
              ).__embeddedMetalState?.close();
            })
            .catch(() => undefined),
        ),
      );
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      if (ownsContext) await context.close().catch(() => undefined);
    }
  },
  embeddedBrowserLatencyBenchmark: async (
    commandContext: unknown,
    options: BrowserLatencyBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserLatencyBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?bench=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserLatencyBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserStartupBenchmark: async (
    commandContext: unknown,
    options: BrowserStartupBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserStartupBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?bench=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserStartupBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserStartupBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserRemoteBenchmark: async (
    commandContext: unknown,
    options: BrowserRemoteBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserRemoteBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?remote=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserRemoteBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserRemoteBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedBrowserScaleBenchmark: async (
    commandContext: unknown,
    options: BrowserScaleBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readBrowserScaleBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?scale=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const report = await runBrowserScaleBenchmark(context, pageUrl, browserUrl, benchOptions);
    const outPath = resolveBenchOutPath(benchOptions.out, browserScaleBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outPath, report };
  },
  embeddedMultiPage: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pageA = await context.context.newPage();
    const pageB = await context.context.newPage();
    try {
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel);
      await installEmbeddedPage(pageB, pageUrl, browserUrl, channel);
      await pageA.evaluate(async () => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState: EmbeddedPageState;
          }
        ).__embeddedPageState;
        await state.writeDocument("from-a");
      });
      await pageB.waitForFunction(() => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState?: EmbeddedPageState;
          }
        ).__embeddedPageState;
        return state?.updates.some((rows) => rows.some((row) => row.text === "from-a"));
      });
      await pageA.close();
      await pageB.evaluate(async () => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState: EmbeddedPageState;
          }
        ).__embeddedPageState;
        await state.writeDocument("from-b-after-close");
      });
      await pageB.waitForFunction(() => {
        const state = (
          globalThis as typeof globalThis & {
            __embeddedPageState?: EmbeddedPageState;
          }
        ).__embeddedPageState;
        return state?.updates.some((rows) => rows.some((row) => row.text === "from-b-after-close"));
      });
    } finally {
      await pageA.close().catch(() => undefined);
      await pageB.close().catch(() => undefined);
    }
  },
  embeddedRemoteDocumentMatches: async (
    _commandContext: unknown,
    url: string,
    text: string,
    body: string,
  ) => {
    const client = new ConvexHttpClient(url);
    const rows = await client.query(listRootDocuments, { prefix: text });
    return rows.some((row) => row.title === text && row.body === body);
  },
  embeddedRemoteDocumentExists: async (_commandContext: unknown, url: string, text: string) => {
    const client = new ConvexHttpClient(url);
    const rows = await client.query(listRootDocuments, { prefix: text });
    return rows.some((row) => row.title === text);
  },
  embeddedRemoteDocumentCreate: async (
    _commandContext: unknown,
    url: string,
    text: string,
    body: string,
  ) => {
    const client = new ConvexHttpClient(url);
    return await client.mutation(createRootDocument, {
      body,
      slug: text,
      title: text,
    });
  },
  embeddedMultiPageStress: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pages = await Promise.all([
      context.context.newPage(),
      context.context.newPage(),
      context.context.newPage(),
    ]);
    const closed = new Set<import("playwright").Page>();
    const failures: string[] = [];
    const expected = new Set<string>();
    for (const page of pages) observePageFailures(page, failures);
    try {
      await Promise.all(
        pages.map((page) =>
          installEmbeddedPage(page, pageUrl, browserUrl, channel, {
            clearStorageId: true,
          }),
        ),
      );
      await Promise.all(
        pages.map((page, index) => sendPageMessage(page, `initial-${index}`, expected)),
      );
      await waitForPageBodies(pages, expected);

      void pages[0]
        .evaluate(async () => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState: EmbeddedPageState;
            }
          ).__embeddedPageState;
          await state.writeDocument("closing-page");
        })
        .catch(() => undefined);
      await pages[0].close();
      closed.add(pages[0]);

      const active = [pages[1], pages[2]];
      for (let index = 0; index < 12; index += 1) {
        await sendPageMessage(active[index % active.length], `stress-${index}`, expected);
        if (index === 5) {
          await active[1].reload();
          await installEmbeddedPage(active[1], pageUrl, browserUrl, channel);
        }
        await waitForPageBodies(active, expected);
      }

      const fresh = await context.context.newPage();
      pages.push(fresh);
      observePageFailures(fresh, failures);
      await installEmbeddedPage(fresh, pageUrl, browserUrl, channel);
      await waitForPageBodies([fresh], expected);
      await assertNoPageFailures(
        pages.filter((page) => !closed.has(page)),
        failures,
      );
    } finally {
      await Promise.all(
        pages
          .filter((page) => !closed.has(page))
          .map((page) => page.close().catch(() => undefined)),
      );
    }
  },
  embeddedWatchOnlyLateSubscriber: async (commandContext: unknown, channel: string) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const pageA = await context.context.newPage();
    const pageB = await context.context.newPage();
    const pageC = await context.context.newPage();
    const pages = [pageA, pageB, pageC];
    const failures: string[] = [];
    for (const page of pages) observePageFailures(page, failures);
    const expected = new Set<string>();
    try {
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await installEmbeddedPage(pageB, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await sendPageMessage(pageA, "watch-only-seed", expected);
      await waitForPageBodies([pageA, pageB], expected);

      await installEmbeddedPage(pageC, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageC], expected);

      await pageC.reload();
      await installEmbeddedPage(pageC, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageC], expected);

      await pageA.reload();
      await installEmbeddedPage(pageA, pageUrl, browserUrl, channel, {
        initialQuery: false,
      });
      await waitForPageBodies([pageA, pageB, pageC], expected);
      await assertNoPageFailures(pages, failures);
    } finally {
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    }
  },
};

async function poll<T>(
  read: () => Promise<T | undefined>,
  label: string,
  diagnose?: () => Promise<unknown>,
): Promise<T> {
  const deadline = getTimerTime() + 30_000;
  while (getTimerTime() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = diagnose ? `\n${JSON.stringify(await diagnose(), null, 2)}` : "";
  throw new Error(`Timed out waiting for ${label}.${diagnostic}`);
}

async function waitForRemoteInvalidation(
  page: import("playwright").Page,
  eventStart: number,
): Promise<void> {
  await page.waitForFunction(
    (start) => {
      const events = (globalThis as typeof globalThis & { __embeddedMetalState?: MetalDeviceState })
        .__embeddedMetalState?.events;
      return events
        ?.slice(start)
        .some(
          (event) =>
            event.type === "remote" && (event.status === "starting" || event.status === "offline"),
        );
    },
    eventStart,
    { timeout: STATUS_HINT_DEADLINE_MS },
  );
}

async function waitForRemoteStatus(
  page: import("playwright").Page,
  eventStart: number,
  status: string,
): Promise<void> {
  await page.waitForFunction(
    ({ start, target }) => {
      const events = (globalThis as typeof globalThis & { __embeddedMetalState?: MetalDeviceState })
        .__embeddedMetalState?.events;
      return events
        ?.slice(start)
        .some((event) => event.type === "remote" && event.status === target);
    },
    { start: eventStart, target: status },
    { timeout: STATUS_HINT_DEADLINE_MS },
  );
}

const STATUS_HINT_DEADLINE_MS = 1_500;
