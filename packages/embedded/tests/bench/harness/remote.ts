import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { getTimerTime } from "../../../src/time.js";
import {
  installBrowserRemoteBenchPage,
  installDirectRemoteBenchPage,
  observePageFailures,
} from "../../browser/harness/page.js";
import { sleep } from "./env.js";
import { browserDistPath, convexBrowserWebPath, convexServerPath } from "./paths.js";
import type {
  BrowserDirectPageState,
  BrowserRemoteBenchOptions,
  BrowserRemoteBenchReport,
  BrowserRemoteBenchSample,
  BrowserRemoteDirectSample,
  BrowserRemoteEmbeddedSample,
  BrowserRemoteNetworkEvidence,
  BrowserRemotePageState,
  BrowserRemoteSocketTrace,
  BrowserRemoteStats,
  PlaywrightCommandContext,
} from "./types.js";

export async function runBrowserRemoteBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: BrowserRemoteBenchOptions,
): Promise<BrowserRemoteBenchReport> {
  const browser = commandContext.context.browser();
  if (!browser) throw new Error("Hosted browser benchmark requires an isolated browser context.");
  const contexts = await Promise.all(
    Array.from({ length: 4 }, async () => await browser.newContext()),
  );
  const [directWriter, directObserver, embeddedWriter, embeddedObserver] = await Promise.all(
    contexts.map(async (context) => await context.newPage()),
  );
  const pages = [directWriter, directObserver, embeddedWriter, embeddedObserver];
  const failures: string[] = [];
  for (const page of pages) observePageFailures(page, failures);
  const directWriterNetwork = observeRemoteSocket(directWriter);
  const directObserverNetwork = observeRemoteSocket(directObserver);
  const embeddedWriterNetwork = observeRemoteSocket(embeddedWriter);
  const embeddedObserverNetwork = observeRemoteSocket(embeddedObserver);
  const prefix = `remote-bench-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const directPrefix = `${prefix}:direct`;
  const embeddedPrefix = `${prefix}:embedded`;
  const hosted = new ConvexHttpClient(options.remoteUrl);
  const createDocument = makeFunctionReference<"mutation">("documents:write");
  const updateDocument = makeFunctionReference<"mutation">("documents:write");
  const removeDocument = makeFunctionReference<"mutation">("documents:del");
  const fillerIds: string[] = [];
  let unrelatedDocumentId: string | undefined;
  const convexBrowserUrl = `/@fs${convexBrowserWebPath}?direct=${getTimerTime()}`;
  const convexServerUrl = `/@fs${convexServerPath}?direct=${getTimerTime()}`;
  const directListState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
      ).__convexBrowserRemote.listTransitionCount(),
    );
  const directPointState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
      ).__convexBrowserRemote.pointTransitionCount(),
    );
  const embeddedListState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.listTransitionCount(),
    );
  const embeddedPointState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.pointTransitionCount(),
    );
  const embeddedCacheServeState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.cacheServeCount(),
    );
  const embeddedResultWriteState = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.resultWriteCount(),
    );
  const embeddedSummaryKeys = (page: import("playwright").Page) =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.summaryKeys(),
    );
  try {
    const fillers = await Promise.all(
      [directPrefix, embeddedPrefix].flatMap((scope) =>
        Array.from({ length: 39 }, async (_, index) => {
          const title = `${scope}:filler:${index.toString().padStart(2, "0")}`;
          return (await hosted.mutation(createDocument, {
            body: "filler",
            slug: title,
            title,
            updatedAt: index,
          })) as { _id: string };
        }),
      ),
    );
    fillerIds.push(...fillers.map((document) => document._id));
    await Promise.all([
      installDirectRemoteBenchPage(
        directWriter,
        pageUrl,
        convexBrowserUrl,
        convexServerUrl,
        options.remoteUrl,
        directPrefix,
      ),
      installDirectRemoteBenchPage(
        directObserver,
        pageUrl,
        convexBrowserUrl,
        convexServerUrl,
        options.remoteUrl,
        directPrefix,
      ),
      installBrowserRemoteBenchPage(
        embeddedWriter,
        pageUrl,
        browserUrl,
        options.remoteUrl,
        `${prefix}-writer`,
        embeddedPrefix,
      ),
      installBrowserRemoteBenchPage(
        embeddedObserver,
        pageUrl,
        browserUrl,
        options.remoteUrl,
        `${prefix}-observer`,
        embeddedPrefix,
      ),
    ]);

    const directTitle = `${directPrefix}:seed`;
    const embeddedTitle = `${embeddedPrefix}:seed`;
    const directBody = "seed";
    let embeddedBody = "seed";
    const directCreateWaiter = await directObserver.evaluate(
      ({ timeoutMs, title }) =>
        (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.armTitle(title, timeoutMs),
      { timeoutMs: options.timeoutMs, title: directTitle },
    );
    const directCreated = await directWriter.evaluate(
      async ({ body, title }) =>
        await (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.create(title, body),
      { body: directBody, title: directTitle },
    );
    await directObserver.evaluate((id) => {
      (
        globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
      ).__convexBrowserRemote.select(id);
    }, directCreated.id);
    await waitDirectRemote(directObserver, directCreateWaiter);
    const embeddedCreateWaiter = await armRemoteBody(
      embeddedObserver,
      embeddedTitle,
      embeddedBody,
      options.timeoutMs,
    );
    const embeddedCreated = await embeddedWriter.evaluate(
      async ({ body, title }) => {
        const state = (
          globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
        ).__embeddedBrowserRemote;
        return await state.create(title, body);
      },
      { body: embeddedBody, title: embeddedTitle },
    );
    await waitRemoteWaiter(embeddedObserver, embeddedCreateWaiter);
    await embeddedWriter.evaluate(
      async (accepted) =>
        await (
          globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
        ).__embeddedBrowserRemote.waitForPushAccepted(accepted),
      embeddedCreated.acceptedBefore,
    );

    const writeDirect = async (index: number): Promise<BrowserRemoteDirectSample> => {
      const nextValue = `${directPrefix}:slug:${index}`;
      const directWaiter = await directObserver.evaluate(
        ({ timeoutMs, value }) =>
          (
            globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
          ).__convexBrowserRemote.armDocumentSlug(value, timeoutMs),
        { timeoutMs: options.timeoutMs, value: nextValue },
      );
      const directDelivery = directObserverNetwork.armReceived(nextValue, options.timeoutMs);
      const directNetworkCursors = [directWriterNetwork.cursor(), directObserverNetwork.cursor()];
      const directListTransitionsBefore = await directListState(directObserver);
      const directPointTransitionsBefore = await directPointState(directObserver);
      const directStartedAt = getTimerTime();
      const directPeer = waitDirectRemote(directObserver, directWaiter).then(() => getTimerTime());
      const directMutation = await directWriter.evaluate(
        async ({ id, value }) =>
          await (
            globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
          ).__convexBrowserRemote.writeSlug(id, value),
        { id: directCreated.id, value: nextValue },
      );
      const [directPeerAt, directDeliveryAt] = await Promise.all([directPeer, directDelivery]);
      const directPeerMs = directPeerAt - directStartedAt;
      const directQueryDeliveryMs = directDeliveryAt - directStartedAt;
      return {
        consistencyMs: directMutation.consistencyMs,
        listTransitions: (await directListState(directObserver)) - directListTransitionsBefore,
        network: mergeRemoteNetworkEvidence(
          directWriterNetwork.evidenceSince(directNetworkCursors[0]),
          directObserverNetwork.evidenceSince(directNetworkCursors[1]),
        ),
        peerApplyMs: Math.max(0, directPeerAt - directDeliveryAt),
        peerMs: directPeerMs,
        queryDeliveryMs: directQueryDeliveryMs,
        transitions: (await directPointState(directObserver)) - directPointTransitionsBefore,
      };
    };

    const writeEmbedded = async (index: number): Promise<BrowserRemoteEmbeddedSample> => {
      const insert = String.fromCharCode(97 + (((index % 26) + 26) % 26));
      const nextEmbeddedBody = `${embeddedBody}${insert}`;
      const embeddedWaiter = await armRemoteBody(
        embeddedObserver,
        embeddedTitle,
        nextEmbeddedBody,
        options.timeoutMs,
      );
      const embeddedDelivery = embeddedObserverNetwork.armReceived(
        nextEmbeddedBody,
        options.timeoutMs,
      );
      const embeddedNetworkCursors = [
        embeddedWriterNetwork.cursor(),
        embeddedObserverNetwork.cursor(),
      ];
      const embeddedListTransitionsBefore = await embeddedListState(embeddedObserver);
      const embeddedPointTransitionsBefore = await embeddedPointState(embeddedObserver);
      const embeddedCacheServesBefore = await embeddedCacheServeState(embeddedObserver);
      const embeddedResultWritesBefore = await embeddedResultWriteState(embeddedObserver);
      const [writerCursor, observerCursor] = await Promise.all([
        embeddedWriter.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __embeddedBrowserRemote: BrowserRemotePageState;
            }
          ).__embeddedBrowserRemote.eventCount(),
        ),
        embeddedObserver.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __embeddedBrowserRemote: BrowserRemotePageState;
            }
          ).__embeddedBrowserRemote.eventCount(),
        ),
      ]);
      const embeddedStartedAt = getTimerTime();
      const embeddedPeer = waitRemoteWaiter(embeddedObserver, embeddedWaiter).then(() =>
        getTimerTime(),
      );
      const mutation = await embeddedWriter.evaluate(
        async ({ id, index, insert }) =>
          await (
            globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
          ).__embeddedBrowserRemote.write(id, { delete: 0, index, insert }),
        { id: embeddedCreated.id, index: embeddedBody.length, insert },
      );
      const settlement = embeddedWriter
        .evaluate(
          async (accepted) =>
            await (
              globalThis as typeof globalThis & {
                __embeddedBrowserRemote: BrowserRemotePageState;
              }
            ).__embeddedBrowserRemote.waitForPushAccepted(accepted),
          mutation.acceptedBefore,
        )
        .then(() => getTimerTime());
      const [embeddedPeerAt, embeddedDeliveryAt, embeddedSettledAt] = await Promise.all([
        embeddedPeer,
        embeddedDelivery,
        settlement,
      ]);
      const [writerEvidence, observerEvidence] = await Promise.all([
        embeddedWriter.evaluate(
          (cursor) =>
            (
              globalThis as typeof globalThis & {
                __embeddedBrowserRemote: BrowserRemotePageState;
              }
            ).__embeddedBrowserRemote.evidenceSince(cursor),
          writerCursor,
        ),
        embeddedObserver.evaluate(
          (cursor) =>
            (
              globalThis as typeof globalThis & {
                __embeddedBrowserRemote: BrowserRemotePageState;
              }
            ).__embeddedBrowserRemote.evidenceSince(cursor),
          observerCursor,
        ),
      ]);
      const embeddedPeerMs = embeddedPeerAt - embeddedStartedAt;
      const embeddedQueryDeliveryMs = embeddedDeliveryAt - embeddedStartedAt;
      embeddedBody = nextEmbeddedBody;
      return {
        admissionMs: mutation.admissionMs,
        cacheServes: (await embeddedCacheServeState(embeddedObserver)) - embeddedCacheServesBefore,
        listTransitions:
          (await embeddedListState(embeddedObserver)) - embeddedListTransitionsBefore,
        network: mergeRemoteNetworkEvidence(
          embeddedWriterNetwork.evidenceSince(embeddedNetworkCursors[0]),
          embeddedObserverNetwork.evidenceSince(embeddedNetworkCursors[1]),
        ),
        observer: observerEvidence,
        peerApplyMs: Math.max(0, embeddedPeerAt - embeddedDeliveryAt),
        peerMs: embeddedPeerMs,
        queryDeliveryMs: embeddedQueryDeliveryMs,
        resultWrites:
          (await embeddedResultWriteState(embeddedObserver)) - embeddedResultWritesBefore,
        runtime: mutation.runtime,
        settlementMs: embeddedSettledAt - embeddedStartedAt,
        transitions: (await embeddedPointState(embeddedObserver)) - embeddedPointTransitionsBefore,
        writer: writerEvidence,
      };
    };

    const write = async (index: number): Promise<BrowserRemoteBenchSample> => {
      const order = index % 2 === 0 ? "direct-first" : "embedded-first";
      let direct: BrowserRemoteDirectSample;
      let embedded: BrowserRemoteEmbeddedSample;
      if (order === "direct-first") {
        direct = await writeDirect(index);
        embedded = await writeEmbedded(index);
      } else {
        embedded = await writeEmbedded(index);
        direct = await writeDirect(index);
      }
      return {
        delta: {
          peerApplyMs: embedded.peerApplyMs - direct.peerApplyMs,
          peerMs: embedded.peerMs - direct.peerMs,
          queryDeliveryMs: embedded.queryDeliveryMs - direct.queryDeliveryMs,
        },
        direct,
        embedded,
        index,
        order,
      };
    };

    let lastWarmup: BrowserRemoteBenchSample | undefined;
    for (let index = 0; index < options.warmups; index += 1) {
      lastWarmup = await write(-options.warmups + index);
    }

    // Cut 7 §10 benchmark preconditions (fail-closed): the retained list result must omit `body`,
    // and a body edit must not disturb it. A demo/fixture edit that violates these fails the setup,
    // not the cut. These run after warmups so the summaries cache entry has settled from a pull.
    const partialKeys = ["_id", "title", "updatedAt"];
    const observerSummaryKeys = await embeddedSummaryKeys(embeddedObserver);
    const directSummaryKeys = await directObserver.evaluate(() =>
      (
        globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
      ).__convexBrowserRemote.summaryKeys(),
    );
    for (const [label, keys] of [
      ["Embedded", observerSummaryKeys],
      ["direct", directSummaryKeys],
    ] as const) {
      if (keys.includes("body")) {
        throw new Error(
          `Cut 7 precondition failed: the ${label} retained list result includes \`body\`; documents:summaries must omit it so it exercises the retained-result cache, not row membership.`,
        );
      }
      if (keys.length > 0 && JSON.stringify(keys) !== JSON.stringify(partialKeys)) {
        throw new Error(
          `Cut 7 precondition failed: the ${label} retained list projection is ${JSON.stringify(keys)}, expected ${JSON.stringify(partialKeys)}.`,
        );
      }
    }
    const observerCacheServes = await embeddedCacheServeState(embeddedObserver);
    if (observerCacheServes <= 0) {
      throw new Error(
        "Cut 7 precondition failed: the Embedded partial list produced zero cache serves, so it is not foreign/cache-served. A membership-served list cannot prove the retained partial-result cache.",
      );
    }
    if (
      lastWarmup &&
      (lastWarmup.embedded.listTransitions !== 0 || lastWarmup.embedded.resultWrites !== 0)
    ) {
      throw new Error(
        `Cut 7 precondition failed: a warmup body edit disturbed the retained list result (listTransitions=${lastWarmup.embedded.listTransitions}, resultWrites=${lastWarmup.embedded.resultWrites}). writeBody must patch no list-visible field.`,
      );
    }

    const samples: BrowserRemoteBenchSample[] = [];
    for (let index = 0; index < options.iterations; index += 1) {
      samples.push(await write(index));
    }

    const directLifecycleTitle = `${directPrefix}:lifecycle`;
    const directLifecycleWaiter = await directObserver.evaluate(
      ({ timeoutMs, title }) =>
        (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.armTitle(title, timeoutMs),
      { timeoutMs: options.timeoutMs, title: directLifecycleTitle },
    );
    await directWriter.evaluate(
      async ({ id, title, updatedAt }) =>
        await (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.update(id, title, updatedAt),
      { id: directCreated.id, title: directLifecycleTitle, updatedAt: options.iterations + 1 },
    );
    await waitDirectRemote(directObserver, directLifecycleWaiter);

    const embeddedLifecycleTitle = `${embeddedPrefix}:lifecycle`;
    const lifecycleCacheServesBefore = await embeddedCacheServeState(embeddedObserver);
    const lifecycleResultWritesBefore = await embeddedResultWriteState(embeddedObserver);
    const embeddedLifecycleWaiter = await armRemoteBody(
      embeddedObserver,
      embeddedLifecycleTitle,
      embeddedBody,
      options.timeoutMs,
    );
    const embeddedLifecycleAccepted = await embeddedWriter.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.accepted(),
    );
    await embeddedWriter.evaluate(
      async ({ id, title, updatedAt }) =>
        await (
          globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
        ).__embeddedBrowserRemote.update(id, title, updatedAt),
      { id: embeddedCreated.id, title: embeddedLifecycleTitle, updatedAt: options.iterations + 1 },
    );
    await Promise.all([
      waitRemoteWaiter(embeddedObserver, embeddedLifecycleWaiter),
      embeddedWriter.evaluate(
        async (accepted) =>
          await (
            globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
          ).__embeddedBrowserRemote.waitForPushAccepted(accepted),
        embeddedLifecycleAccepted,
      ),
    ]);
    const titleEditCacheServes =
      (await embeddedCacheServeState(embeddedObserver)) - lifecycleCacheServesBefore;
    const titleEditResultWrites =
      (await embeddedResultWriteState(embeddedObserver)) - lifecycleResultWritesBefore;

    const unrelatedTitle = `unrelated-${prefix}`;
    const unrelatedDocument = (await hosted.mutation(createDocument, {
      body: "seed",
      slug: unrelatedTitle,
      title: unrelatedTitle,
      updatedAt: 0,
    })) as { _id: string };
    unrelatedDocumentId = unrelatedDocument._id;
    const unrelatedDirectNetworkCursor = directObserverNetwork.cursor();
    const unrelatedEmbeddedNetworkCursor = embeddedObserverNetwork.cursor();
    const unrelatedDirectTransitions = await directListState(directObserver);
    const unrelatedEmbeddedTransitions = await embeddedListState(embeddedObserver);
    const unrelatedEmbeddedEvents = await embeddedObserver.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.eventCount(),
    );
    await hosted.mutation(updateDocument, {
      id: unrelatedDocument._id,
      title: `${unrelatedTitle}-changed`,
      updatedAt: 1,
    });
    await sleep(250);
    const unrelated = {
      directNetwork: directObserverNetwork.evidenceSince(unrelatedDirectNetworkCursor),
      directTransitions: (await directListState(directObserver)) - unrelatedDirectTransitions,
      embeddedNetwork: embeddedObserverNetwork.evidenceSince(unrelatedEmbeddedNetworkCursor),
      embeddedObserver: await embeddedObserver.evaluate(
        (cursor) =>
          (
            globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
          ).__embeddedBrowserRemote.evidenceSince(cursor),
        unrelatedEmbeddedEvents,
      ),
      embeddedTransitions:
        (await embeddedListState(embeddedObserver)) - unrelatedEmbeddedTransitions,
    };
    await hosted.mutation(removeDocument, { id: unrelatedDocument._id });
    unrelatedDocumentId = undefined;

    const finalDirectTitle = directLifecycleTitle;
    const finalEmbeddedTitle = embeddedLifecycleTitle;
    const directMissingWaiter = await directObserver.evaluate(
      ({ timeoutMs, title }) =>
        (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.armMissing(title, timeoutMs),
      { timeoutMs: options.timeoutMs, title: finalDirectTitle },
    );
    await directWriter.evaluate(
      async (id) =>
        await (
          globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
        ).__convexBrowserRemote.remove(id),
      directCreated.id,
    );
    await waitDirectRemote(directObserver, directMissingWaiter);

    const embeddedMissingWaiter = await embeddedObserver.evaluate(
      ({ timeoutMs, title }) =>
        (
          globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
        ).__embeddedBrowserRemote.armMissing(title, timeoutMs),
      { timeoutMs: options.timeoutMs, title: finalEmbeddedTitle },
    );
    const embeddedDeleteAccepted = await embeddedWriter.evaluate(() =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.accepted(),
    );
    await embeddedWriter.evaluate(
      async (id) =>
        await (
          globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
        ).__embeddedBrowserRemote.remove(id),
      embeddedCreated.id,
    );
    await Promise.all([
      waitRemoteWaiter(embeddedObserver, embeddedMissingWaiter),
      embeddedWriter.evaluate(
        async (accepted) =>
          await (
            globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
          ).__embeddedBrowserRemote.waitForPushAccepted(accepted),
        embeddedDeleteAccepted,
      ),
    ]);

    const summaries = {
      deltaPeerApplyMs: summarizeRemote(samples.map((sample) => sample.delta.peerApplyMs)),
      deltaPeerMs: summarizeRemote(samples.map((sample) => sample.delta.peerMs)),
      deltaQueryDeliveryMs: summarizeRemote(samples.map((sample) => sample.delta.queryDeliveryMs)),
      directConsistencyMs: summarizeRemote(samples.map((sample) => sample.direct.consistencyMs)),
      directPeerMs: summarizeRemote(samples.map((sample) => sample.direct.peerMs)),
      embeddedAdmissionMs: summarizeRemote(samples.map((sample) => sample.embedded.admissionMs)),
      embeddedPeerMs: summarizeRemote(samples.map((sample) => sample.embedded.peerMs)),
      embeddedRuntimeCommitMs: summarizeRemote(
        samples.map((sample) => sample.embedded.runtime.commitMs),
      ),
      embeddedRuntimeMs: summarizeRemote(samples.map((sample) => sample.embedded.runtime.totalMs)),
      embeddedSettlementMs: summarizeRemote(samples.map((sample) => sample.embedded.settlementMs)),
    };
    const suspicious = [...failures];
    if (samples.some((sample) => sample.direct.transitions !== 1))
      suspicious.push("native point query did not produce exactly one changed-result callback");
    if (samples.some((sample) => sample.embedded.transitions !== 1))
      suspicious.push(
        "Embedded document point query did not produce exactly one changed-result callback",
      );
    if (samples.some((sample) => sample.direct.listTransitions !== 0))
      suspicious.push("native point update invalidated the retained list result");
    if (samples.some((sample) => sample.embedded.listTransitions !== 0))
      suspicious.push("body-only CRDT edit invalidated the retained list result");
    if (unrelated.directTransitions !== 0 || unrelated.embeddedTransitions !== 0)
      suspicious.push("unrelated document write changed a scoped documents result");
    if (unrelated.embeddedObserver.storeJobs !== 0)
      suspicious.push("unrelated document write caused an Embedded observer store job");
    if (samples.some((sample) => sample.embedded.observer.rowsApplied !== 0))
      suspicious.push("a body-only CRDT sample applied plain rows instead of zero");
    if (samples.some((sample) => sample.embedded.observer.received !== 1))
      suspicious.push("a body-only CRDT sample received a field count other than one");
    if (samples.some((sample) => sample.embedded.resultWrites !== 0))
      suspicious.push("a body-only CRDT sample wrote the retained-result cache");
    if (observerSummaryKeys.includes("body"))
      suspicious.push("the Embedded retained list projection includes body");
    if (samples.every((sample) => sample.embedded.cacheServes === 0) && observerCacheServes <= 0)
      suspicious.push("the Embedded partial list was never served from the retained-result cache");
    if (titleEditResultWrites <= 0)
      suspicious.push("a title edit did not rewrite the retained-result cache");
    const deployment = new URL(options.remoteUrl).hostname.split(".")[0] ?? "unknown";
    return {
      artifact: {
        browserBundle: createHash("sha256").update(readFileSync(browserDistPath)).digest("hex"),
        deployment,
        remoteUrl: options.remoteUrl,
      },
      browser: "chromium",
      cache: {
        embeddedListFunction: "documents:summaries",
        embeddedListOmitsBody: !observerSummaryKeys.includes("body"),
        embeddedSummaryKeys: observerSummaryKeys,
        bodyEditCacheServes: samples.reduce(
          (total, sample) => total + sample.embedded.cacheServes,
          0,
        ),
        bodyEditListWrites: samples.reduce(
          (total, sample) => total + sample.embedded.listTransitions,
          0,
        ),
        bodyEditResultWrites: samples.reduce(
          (total, sample) => total + sample.embedded.resultWrites,
          0,
        ),
        titleEditCacheServes,
        titleEditResultWrites,
      },
      generatedAt: new Date().toISOString(),
      iterations: options.iterations,
      lifecycle: { create: true, crdt: true, delete: true, plain: true },
      notes: [
        "direct and Embedded paths use independent writer and observer clients against one deployment",
        "each direct sample patches one plain slug field observed by one documents:read point query",
        "each Embedded sample splices one CRDT body field observed by one documents:read point query",
        "both observer paths retain the same documents:summaries partial list ({_id,title,updatedAt}, no body) in the engine-owned retained-result cache",
        "the partial list is foreign/cache-served: cacheServes is nonzero and its resultRows are empty, so row applies never re-emit it",
        "every Embedded body sample requires one point delta, zero plain-row applies, zero list transitions, and zero retained-result writes",
        "the edited field (body/slug) is absent from the partial list, so neither writeBody nor writeSlug is a list-visible patch (Cut 7 §10 precondition)",
        "title/list propagation is exercised once as lifecycle coverage and is excluded from latency samples; a title edit does rewrite the cache",
        "queryDeliveryMs is the observer websocket frame containing the expected result; peerApplyMs ends at the retained-query callback",
        "Convex mutation consistencyMs resolves only after the writer transition passes the mutation timestamp",
        "sample order alternates deterministically so neither path always receives the first network window",
        "warmups are excluded and every sample starts after the preceding pair has converged",
      ],
      remoteUrl: options.remoteUrl,
      samples,
      summaries,
      suspicious,
      unrelated,
      version: 4,
      warmups: options.warmups,
    };
  } finally {
    await Promise.all(
      pages.map((page) =>
        page
          .evaluate(async () => {
            const target = globalThis as typeof globalThis & {
              __convexBrowserRemote?: BrowserDirectPageState;
              __embeddedBrowserRemote?: BrowserRemotePageState;
            };
            await target.__convexBrowserRemote?.close();
            await target.__embeddedBrowserRemote?.close();
          })
          .catch(() => undefined),
      ),
    );
    await Promise.all(pages.map(async (page) => await page.close().catch(() => undefined)));
    await Promise.all(contexts.map(async (context) => await context.close()));
    await Promise.all(
      fillerIds.map(async (id) => {
        await hosted.mutation(removeDocument, { id }).catch(() => undefined);
      }),
    );
    if (unrelatedDocumentId !== undefined) {
      await hosted.mutation(removeDocument, { id: unrelatedDocumentId }).catch(() => undefined);
    }
  }
}

function observeRemoteSocket(page: import("playwright").Page): BrowserRemoteSocketTrace {
  const frames: Array<{ at: number; direction: "received" | "sent"; payload: string }> = [];
  const listeners = new Set<() => void>();
  page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      frames.push({ at: getTimerTime(), direction: "received", payload: frame.payload.toString() });
      for (const listener of listeners) listener();
    });
    socket.on("framesent", (frame) => {
      frames.push({ at: getTimerTime(), direction: "sent", payload: frame.payload.toString() });
      for (const listener of listeners) listener();
    });
  });
  return {
    armReceived: (value, timeoutMs) => {
      const cursor = frames.length;
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        const check = () => {
          const match = frames
            .slice(cursor)
            .find((frame) => frame.direction === "received" && frame.payload.includes(value));
          if (!match) return;
          finish();
          resolve(match.at);
        };
        timer = setTimeout(() => {
          finish();
          reject(new Error(`Timed out waiting for websocket result containing ${value}.`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
    cursor: () => frames.length,
    evidenceSince: (cursor) =>
      frames.slice(cursor).reduce<BrowserRemoteNetworkEvidence>(
        (evidence, frame) => {
          if (frame.direction === "received") evidence.received += 1;
          else {
            evidence.sent += 1;
            evidence.queryAdds += countProtocolOperations(frame.payload, "Add");
            evidence.queryRemoves += countProtocolOperations(frame.payload, "Remove");
          }
          return evidence;
        },
        { queryAdds: 0, queryRemoves: 0, received: 0, sent: 0 },
      ),
  };
}

function countProtocolOperations(payload: string, operation: "Add" | "Remove"): number {
  return payload.match(new RegExp(`\\"type\\":\\"${operation}\\"`, "g"))?.length ?? 0;
}

function mergeRemoteNetworkEvidence(
  ...entries: BrowserRemoteNetworkEvidence[]
): BrowserRemoteNetworkEvidence {
  return entries.reduce<BrowserRemoteNetworkEvidence>(
    (total, entry) => ({
      queryAdds: total.queryAdds + entry.queryAdds,
      queryRemoves: total.queryRemoves + entry.queryRemoves,
      received: total.received + entry.received,
      sent: total.sent + entry.sent,
    }),
    { queryAdds: 0, queryRemoves: 0, received: 0, sent: 0 },
  );
}

async function waitDirectRemote(page: import("playwright").Page, waiter: number): Promise<number> {
  return await page.evaluate(
    async (id) =>
      await (
        globalThis as typeof globalThis & { __convexBrowserRemote: BrowserDirectPageState }
      ).__convexBrowserRemote.wait(id),
    waiter,
  );
}

async function armRemoteBody(
  page: import("playwright").Page,
  title: string,
  body: string,
  timeoutMs: number,
): Promise<number> {
  return await page.evaluate(
    ({ body, timeoutMs, title }) =>
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.armBody(title, body, timeoutMs),
    { body, timeoutMs, title },
  );
}

async function waitRemoteWaiter(page: import("playwright").Page, waiter: number): Promise<number> {
  return await page.evaluate(
    async (id) =>
      await (
        globalThis as typeof globalThis & { __embeddedBrowserRemote: BrowserRemotePageState }
      ).__embeddedBrowserRemote.wait(id),
    waiter,
  );
}

function summarizeRemote(values: number[]): BrowserRemoteStats {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
  return {
    max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length),
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    samples: sorted.length,
  };
}
