import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { getTimerTime } from "../../../src/time.js";
import { revisionVolumeId } from "../../../scripts/volume.js";
import { installMetalDevicePage, observePageFailures } from "../../browser/harness/page.js";
import { sleep } from "./env.js";
import { replaceMetalRevisionVolume } from "./options.js";
import { MetalWaitError } from "./types.js";
import type {
  BrowserScaleBenchSample,
  MetalDeviceState,
  MetalDeviceStatus,
  MetalDocument,
  MetalDocumentsSyncOptions,
  MetalDocumentsSyncResult,
  MetalEventSummary,
  MetalOpenTiming,
  MetalReconnectVolumeBenchOptions,
  MetalReconnectVolumeBenchReport,
  MetalRemoteTickTotals,
  MetalRevEntry,
  MetalScaleBenchOptions,
  MetalScaleBenchReport,
  PlaywrightCommandContext,
} from "./types.js";

async function assertMetalRemoteReachable(remoteUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(remoteUrl, { method: "GET", signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `Metal remote ${remoteUrl} is not reachable. Start the Convex backend in another process before running browser metal tests. ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function runMetalDocumentsSync(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: MetalDocumentsSyncOptions,
): Promise<MetalDocumentsSyncResult> {
  const browser = commandContext.context.browser();
  if (!browser) {
    throw new Error("Metal browser sync requires a Playwright browser with newContext support.");
  }
  const timeoutMs = options.timeoutMs ?? 45_000;
  await assertMetalRemoteReachable(options.remoteUrl, Math.min(timeoutMs, 5_000));
  const runId = `metal-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const deviceNames = ["a", "b", "c", "d", "e"] as const;
  const contexts = await Promise.all(deviceNames.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [pageA, pageB, pageC, pageD, pageE] = pages;
  if (
    pageA === undefined ||
    pageB === undefined ||
    pageC === undefined ||
    pageD === undefined ||
    pageE === undefined
  ) {
    throw new Error("Metal browser sync failed to allocate all browser devices.");
  }
  const initialPages = [pageA, pageB, pageC, pageD];
  const installedPages: import("playwright").Page[] = [];
  const failures: string[] = [];
  for (const page of pages) observePageFailures(page, failures);
  const installDevice = async (page: import("playwright").Page, device: string) => {
    await installMetalDevicePage(page, pageUrl, browserUrl, {
      device,
      queryLimit: 10_000,
      remoteUrl: options.remoteUrl,
      runId,
      storageId: `${runId}-device-${device}`,
    });
    installedPages.push(page);
  };

  try {
    await Promise.all(initialPages.map((page, index) => installDevice(page, deviceNames[index]!)));

    const createdTitle = `${runId}: created`;
    const updatedTitle = `${runId}: updated by device b`;
    const offlineATitle = `${runId}: offline edit from a`;
    const offlineBTitle = `${runId}: offline edit from b`;
    const snapshotTitle = `${runId}: snapshot base`;
    const afterSnapshotTitle = `${runId}: after snapshot`;

    const createdId = await metalCreate(pageA, createdTitle);
    await waitForMetalTitle(pageA, createdTitle, "device A local create", timeoutMs);
    await waitForAllMetalTitle(
      initialPages,
      createdTitle,
      "initial live devices import create",
      timeoutMs,
      deviceNames,
    );
    const createIdStable = (await metalOne(pageA))._id === createdId;

    await metalDraftWrite(pageB, (await metalOne(pageB))._id, updatedTitle);
    await waitForMetalTitle(pageB, updatedTitle, "device B local draft write", timeoutMs);
    await waitForAllMetalTitle(
      initialPages,
      updatedTitle,
      "initial live devices import B draft write",
      timeoutMs,
      deviceNames,
    );
    await installDevice(pageE, "e");
    const allPages = [...initialPages, pageE];
    await waitForAllMetalTitle(
      allPages,
      updatedTitle,
      "late device imports B draft write",
      timeoutMs,
      deviceNames,
    );

    const bodyBase = (await metalOne(pageA)).body;
    const bodyMarker = `${createdTitle} body`;
    const bodyIndex = bodyBase.indexOf(bodyMarker) + bodyMarker.length;
    if (bodyIndex < bodyMarker.length) throw new Error("Metal CRDT body marker was not found.");
    await metalBodyWrite(pageA, (await metalOne(pageA))._id, {
      index: bodyIndex,
      delete: 0,
      insert: " A",
    });
    const bodyA = `${bodyBase.slice(0, bodyIndex)} A${bodyBase.slice(bodyIndex)}`;
    await waitForAllMetalBody(
      allPages,
      bodyA,
      "device A CRDT body propagation",
      timeoutMs,
      deviceNames,
    );
    await metalBodyWrite(pageB, (await metalOne(pageB))._id, {
      index: bodyIndex + 2,
      delete: 0,
      insert: " B",
    });
    const bodyB = `${bodyA.slice(0, bodyIndex + 2)} B${bodyA.slice(bodyIndex + 2)}`;
    await waitForAllMetalBody(
      allPages,
      bodyB,
      "device B CRDT body propagation",
      timeoutMs,
      deviceNames,
    );

    await Promise.all([metalClose(pageA), metalClose(pageB)]);
    await Promise.all([metalOpen(pageA, false), metalOpen(pageB, false)]);
    await metalDraftWrite(pageA, (await metalOne(pageA))._id, offlineATitle);
    await metalDraftWrite(pageB, (await metalOne(pageB))._id, offlineBTitle);
    await waitForMetalTitle(pageA, offlineATitle, "device A offline local draft write", timeoutMs);
    await waitForMetalTitle(pageB, offlineBTitle, "device B offline local draft write", timeoutMs);
    await Promise.all([metalClose(pageA), metalClose(pageB)]);
    await Promise.all([metalOpen(pageA, false), metalOpen(pageB, false)]);
    await waitForMetalTitle(
      pageA,
      offlineATitle,
      "device A offline reopen keeps local draft",
      timeoutMs,
    );
    await waitForMetalTitle(
      pageB,
      offlineBTitle,
      "device B offline reopen keeps local draft",
      timeoutMs,
    );
    await Promise.all([metalClose(pageA), metalClose(pageB)]);
    await Promise.all([metalOpen(pageA, true), metalOpen(pageB, true)]);

    const conflictResult = await waitForMetalCondition(
      "offline edits converge with conflict signal",
      timeoutMs,
      async () => {
        const statuses = await Promise.all(allPages.map((page) => metalStatus(page)));
        assertMetalStatus(...statuses, failures);
        const titles = [offlineATitle, offlineBTitle];
        const rows = statuses.map((status) => singleMetalRow(status.rows));
        const finalTitle = rows[0]?.title ?? "";
        const sameTitle =
          titles.includes(finalTitle) && rows.every((row) => row?.title === finalTitle);
        const conflictObserved = metalConflictObserved(...statuses);
        return {
          detail: {
            devices: metalConflictWaitDetail(deviceNames, statuses),
            conflictObserved,
            finalTitle,
            sameTitle,
          },
          done: Boolean(sameTitle && conflictObserved),
          value: { finalTitle, conflictObserved },
        };
      },
    );

    await metalDraftWrite(pageA, (await metalOne(pageA))._id, snapshotTitle);
    await waitForAllMetalTitle(
      allPages,
      snapshotTitle,
      "snapshot base propagation",
      timeoutMs,
      deviceNames,
    );
    const beforeSnapshot = await metalStatus(pageA);
    const snapshot = await metalSnapshot(pageA, (await metalOne(pageA))._id);
    if (!snapshot?.doc) throw new Error("Snapshot create did not return a document.");
    if (snapshot.doc.title !== snapshotTitle) {
      throw new Error(`Snapshot captured ${snapshot.doc.title}, expected ${snapshotTitle}.`);
    }
    const snapshotSettlement = await waitForMetalCondition(
      "snapshot savepoint settlement",
      Math.min(timeoutMs, 10_000),
      async () => {
        const status = await metalStatus(pageA);
        const accepted =
          status.remoteTickTotals.pushAccepted > beforeSnapshot.remoteTickTotals.pushAccepted;
        const failed =
          status.remoteTickTotals.pushFailed > beforeSnapshot.remoteTickTotals.pushFailed;
        return {
          detail: { accepted, failed, snapshot, status: metalWaitDetail(snapshotTitle, status) },
          done: accepted || failed,
          value: { accepted, failed },
        };
      },
    );
    if (!snapshotSettlement.accepted) {
      throw new Error(
        `Snapshot savepoint replay failed: ${JSON.stringify({ snapshot, snapshotSettlement })}`,
      );
    }

    await metalDraftWrite(pageA, (await metalOne(pageA))._id, afterSnapshotTitle);
    await waitForAllMetalTitle(
      allPages,
      afterSnapshotTitle,
      "post-snapshot edit",
      timeoutMs,
      deviceNames,
    );
    const preview = await metalGetSnapshot(pageA, (await metalOne(pageA))._id, snapshot.rev.revId);
    if (!preview?.doc || preview.doc.title !== snapshotTitle) {
      throw new Error("Snapshot preview did not return the saved document contraction.");
    }

    const restored = await metalRestoreSnapshot(
      pageA,
      (await metalOne(pageA))._id,
      snapshot.rev.revId,
    );
    if (!restored?.doc || restored.doc.title !== snapshotTitle) {
      throw new Error("Snapshot restore did not return the saved document contraction.");
    }
    await waitForAllMetalTitle(
      allPages,
      snapshotTitle,
      "snapshot restore propagation",
      timeoutMs,
      deviceNames,
    );
    assertMetalStatus(...(await Promise.all(allPages.map((page) => metalStatus(page)))), failures);

    return {
      conflictObserved: conflictResult.conflictObserved,
      createIdStable,
      deviceCount: allPages.length,
      finalTitle: conflictResult.finalTitle,
      restoredTitle: restored.doc.title,
      runId,
      snapshotTitle: snapshot.doc.title,
    };
  } finally {
    await Promise.all(installedPages.map((page) => metalClose(page))).catch(() => undefined);
    await Promise.all(pages.map((page) => page.close())).catch(() => undefined);
    await Promise.all(contexts.map((context) => context.close())).catch(() => undefined);
  }
}

export async function runMetalScaleBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: MetalScaleBenchOptions,
): Promise<MetalScaleBenchReport> {
  const browser = commandContext.context.browser();
  if (!browser) {
    throw new Error("Metal scale benchmark requires a Playwright browser with newContext support.");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  await assertMetalRemoteReachable(options.remoteUrl, Math.min(timeoutMs, 5_000));
  const runId = `metal-scale-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const contexts = await Promise.all(
    Array.from({ length: options.clients }, () => browser.newContext()),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const labels = pages.map((_, index) => `device-${index}`);
  const installedPages: import("playwright").Page[] = [];
  const failures: string[] = [];
  for (const page of pages) observePageFailures(page, failures);
  try {
    await Promise.all(
      pages.map(async (page, index) => {
        await installMetalDevicePage(page, pageUrl, browserUrl, {
          device: labels[index]!,
          queryLimit: 10_000,
          remoteUrl: options.remoteUrl,
          runId,
          storageId: `${runId}-${labels[index]}`,
        });
        installedPages.push(page);
      }),
    );
    const primary = pages[0];
    if (!primary) throw new Error("Metal scale benchmark needs at least one browser device.");

    const seedTitle = `${runId}: seed`;
    const beforeSeed = await metalStatus(primary, true);
    const documentId = await metalCreate(primary, seedTitle);
    await waitForMetalPushSettlement(
      primary,
      beforeSeed.remoteTickTotals,
      "metal scale seed settlement",
      timeoutMs,
    );
    await waitForAllMetalTitle(
      pages,
      seedTitle,
      "metal scale seed convergence",
      timeoutMs,
      labels,
      options.skipRevList === true,
    );
    await waitForMetalAcknowledgments(primary, "metal scale seed receipt settlement", timeoutMs);
    const baselineStatuses = await Promise.all(pages.map((page) => metalStatus(page, true)));
    const baselineRemoteTicks = summarizeMetalRemoteTicks(baselineStatuses);
    const baselineEventCounts = baselineStatuses.map((status) => status.events.length);

    const revCreateSamples: number[] = [];
    const revCycleSamples: number[] = [];
    const revWriteSamples: number[] = [];
    for (let index = 0; index < options.revs; index += 1) {
      const cycleStartedAt = getTimerTime();
      const title = `${runId}: rev-${index}`;
      const beforeWrite = await metalStatus(primary, true);
      const writeStartedAt = getTimerTime();
      await metalDraftWrite(primary, documentId, title);
      await waitForMetalPushSettlement(
        primary,
        beforeWrite.remoteTickTotals,
        `metal scale rev ${index} draft settlement`,
        timeoutMs,
      );
      revWriteSamples.push(getTimerTime() - writeStartedAt);
      const beforeSnapshot = await metalStatus(primary, true);
      const startedAt = getTimerTime();
      const rev = await metalSnapshot(primary, documentId);
      await waitForMetalPushSettlement(
        primary,
        beforeSnapshot.remoteTickTotals,
        `metal scale rev ${index} savepoint settlement`,
        timeoutMs,
      );
      revCreateSamples.push(getTimerTime() - startedAt);
      revCycleSamples.push(getTimerTime() - cycleStartedAt);
      if (!rev) throw new Error(`rev.create returned null at metal scale rev ${index}`);
    }
    const revList = options.skipRevList ? null : await metalRevs(primary, documentId);

    const writeSamples: number[] = [];
    if (!Number.isSafeInteger(options.writes) || options.writes < 1) {
      throw new Error("Metal scale writes must be a positive integer.");
    }
    let fanoutWrites = 0;
    let finalTitle = options.revs > 0 ? `${runId}: rev-${options.revs - 1}` : seedTitle;
    while (fanoutWrites < options.writes) {
      fanoutWrites += 1;
      finalTitle = `${runId}: fanout-${fanoutWrites}`;
      const startedAt = getTimerTime();
      await metalDraftWrite(primary, documentId, finalTitle);
      writeSamples.push(getTimerTime() - startedAt);
    }
    const primaryAfterFanout = await metalStatus(primary, options.skipRevList === true);
    const primaryRowAfterFanout = singleMetalRow(primaryAfterFanout.rows);
    const primaryStorageRowAfterFanout = singleMetalRow(primaryAfterFanout.devtoolsRows);
    if (
      primaryRowAfterFanout?.title !== finalTitle ||
      primaryStorageRowAfterFanout?.title !== finalTitle
    ) {
      throw new Error(
        `Primary did not persist final awaited metal fanout write. Last state: ${JSON.stringify(
          metalWaitDetail(finalTitle, primaryAfterFanout),
        )}`,
      );
    }
    const streamConvergenceStartedAt = getTimerTime();
    await waitForAllMetalTitle(
      pages,
      finalTitle,
      "metal scale final convergence",
      timeoutMs,
      labels,
      options.skipRevList === true,
    );
    const streamConvergenceMs = getTimerTime() - streamConvergenceStartedAt;
    await waitForMetalAcknowledgments(primary, "metal scale receipt settlement", timeoutMs);
    const statuses = await Promise.all(
      pages.map((page) => metalStatus(page, options.skipRevList === true)),
    );
    assertMetalStatus(...statuses, failures);
    const rows = statuses.map((status) => singleMetalRow(status.rows));
    const observerFinalTitles = rows.map((row) => row?.title ?? null);
    const remotePullMs = summarizeMetalRemotePhase(
      statuses,
      baselineEventCounts,
      (event) => (event.tick?.pullAttempted ?? 0) > 0,
    );
    const remotePushMs = summarizeMetalRemotePhase(
      statuses,
      baselineEventCounts,
      (event) =>
        (event.tick?.pushAttempted ?? 0) > 0 ||
        (event.tick?.pushAccepted ?? 0) > 0 ||
        (event.tick?.pushConflicts ?? 0) > 0 ||
        (event.tick?.pushRebases ?? 0) > 0 ||
        (event.tick?.pushFailed ?? 0) > 0,
    );
    const settlementMs = summarizeMetalRemotePhase(
      statuses,
      baselineEventCounts,
      (event) => (event.tick?.receiptsPushed ?? 0) > 0,
    );
    const remoteTicks = subtractMetalRemoteTicks(
      summarizeMetalRemoteTicks(statuses),
      baselineRemoteTicks,
    );
    return {
      browser: "chromium",
      clients: options.clients,
      finalTitle,
      generatedAt: new Date().toISOString(),
      notes: [
        "remote is enabled; every browser device uses an isolated storage id and Playwright context",
        "revision volume is created through normal app mutations and authorized component calls",
        "revision history is not copied through a privileged peer transport",
        "fanout measures the final primary write converging to every benchmark device",
      ],
      observerFinalTitles,
      observerRevCounts: statuses.map((status) =>
        options.skipRevList ? null : metalStatusRevCount(status),
      ),
      observerStorageIds: statuses.map((status) => status.storageId),
      remoteTicks,
      revs: options.revs,
      results: {
        allObserversSawFinal: observerFinalTitles.every((title) => title === finalTitle),
        fanoutWrites,
        remotePullMs,
        remotePushMs,
        revCount: revList?.length ?? null,
        revCreateMs: summarizeBenchSamples(revCreateSamples),
        revCycleMs: summarizeBenchSamples(revCycleSamples),
        revListSkipped: options.skipRevList === true,
        revWriteMs: summarizeBenchSamples(revWriteSamples),
        settlementMs,
        streamConvergenceMs: summarizeBenchSamples([streamConvergenceMs]),
        writeMs: summarizeBenchSamples(writeSamples),
      },
      runId,
      version: 5,
      writes: options.writes,
    };
  } finally {
    await Promise.all(installedPages.map((page) => metalClose(page))).catch(() => undefined);
    await Promise.all(pages.map((page) => page.close())).catch(() => undefined);
    await Promise.all(contexts.map((context) => context.close())).catch(() => undefined);
  }
}

export async function runMetalReconnectVolumeBenchmark(
  commandContext: PlaywrightCommandContext,
  pageUrl: string,
  browserUrl: string,
  options: MetalReconnectVolumeBenchOptions,
): Promise<MetalReconnectVolumeBenchReport> {
  const browser = commandContext.context.browser();
  if (!browser) {
    throw new Error(
      "Metal reconnect-with-volume benchmark requires a Playwright browser with newContext support.",
    );
  }
  const timeoutMs = Math.min(300_000, options.timeoutMs ?? 120_000);
  await assertMetalRemoteReachable(options.remoteUrl, Math.min(timeoutMs, 5_000));
  const runId = `metal-reconnect-volume-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
  const clientCount = Math.max(2, options.clients);
  const labels = Array.from({ length: clientCount }, (_, index) =>
    index === 0 ? "writer" : index === 1 ? "observer" : `peer-${index}`,
  );
  const contexts = await Promise.all(labels.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const writer = pages[0];
  const observer = pages[1];
  if (!writer || !observer) throw new Error("Metal reconnect benchmark needs two pages.");
  const installedPages: import("playwright").Page[] = [];
  const failures: string[] = [];
  for (const page of pages) observePageFailures(page, failures);
  try {
    await Promise.all(
      pages.map(async (page, index) => {
        await installMetalDevicePage(page, pageUrl, browserUrl, {
          device: labels[index]!,
          queryLimit: Math.max(10_000, options.revs + 128),
          remoteUrl: options.remoteUrl,
          runId,
          storageId: `${runId}-${labels[index]}`,
        });
        installedPages.push(page);
      }),
    );

    const seedTitle = `${runId}: seed`;
    const documentId = await metalCreate(writer, seedTitle);
    await waitForAllMetalTitle(pages, seedTitle, "reconnect seed convergence", timeoutMs, labels);
    const seededDocuments = await Promise.all(pages.map((page) => metalOne(page)));
    const beforePointScopes = await Promise.all(pages.map((page) => metalStatus(page, true)));
    await Promise.all(
      pages.map((page, index) => metalWatchDocument(page, seededDocuments[index]!._id)),
    );
    await Promise.all(
      pages.map((page, index) =>
        waitForMetalPull(
          page,
          beforePointScopes[index]!.remoteTickTotals.pullAttempted,
          `reconnect point scope ${labels[index]}`,
          timeoutMs,
        ),
      ),
    );
    await waitForMetalAcknowledgments(writer, "reconnect seed receipt settlement", timeoutMs);
    const reconnectBaselines = await Promise.all(pages.map((page) => metalStatus(page, true)));
    const seededWriterStatus = reconnectBaselines[0]!;
    const baselineRemoteTicks = summarizeMetalRemoteTicks(reconnectBaselines);
    const baselineEventCounts = reconnectBaselines.map((status) => status.events.length);
    const convexDocumentId = metalConvexId(seededWriterStatus, documentId);

    await metalClose(observer);

    const seedStartedAt = getTimerTime();
    replaceMetalRevisionVolume({
      deployment: options.deployment,
      remoteUrl: options.remoteUrl,
      revs: options.revs,
      rowId: convexDocumentId,
    });
    const seedMs = getTimerTime() - seedStartedAt;
    const hostedClient = new ConvexHttpClient(options.remoteUrl);
    const hostedRevision = makeFunctionReference<"query">("revision:get");
    const hostedRevisionArgs = {
      rowId: convexDocumentId,
      revId: revisionVolumeId(Math.max(0, options.revs - 1)),
    };
    const hostedRevFirstReadStartedAt = getTimerTime();
    const hostedSeed = await hostedClient.query(hostedRevision, hostedRevisionArgs);
    const hostedRevFirstReadMs = getTimerTime() - hostedRevFirstReadStartedAt;
    const hostedRevReadSamples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const startedAt = getTimerTime();
      await hostedClient.query(hostedRevision, hostedRevisionArgs);
      hostedRevReadSamples.push(getTimerTime() - startedAt);
    }
    if (options.revs > 0 && hostedSeed === null) {
      throw new Error(
        "Imported hosted revision was not readable through the authorized app query.",
      );
    }

    const volumeFinalTitle = `${runId}: volume`;
    const beforeOfflineWrite = await metalStatus(writer, true);
    const offlineWriteStartedAt = getTimerTime();
    await metalDraftWrite(writer, documentId, volumeFinalTitle);
    const offlineWriteMs = getTimerTime() - offlineWriteStartedAt;
    const offlineRevStartedAt = getTimerTime();
    const offlineRev = await metalSnapshot(writer, documentId);
    const offlineRevCreateMs = getTimerTime() - offlineRevStartedAt;
    if (!offlineRev) throw new Error("rev.create returned null after hosted volume seed");
    await waitForMetalPushSettlement(
      writer,
      beforeOfflineWrite.remoteTickTotals,
      "reconnect offline write settlement",
      timeoutMs,
    );
    await waitForMetalProjectedTitle(
      writer,
      volumeFinalTitle,
      "writer volume final title",
      timeoutMs,
    );
    const reconnectStartedAt = getTimerTime();
    const openTiming = await metalOpenTimed(observer, true);
    await waitForAllMetalTitle(
      pages,
      volumeFinalTitle,
      "reconnect volume catchup",
      timeoutMs,
      labels,
      options.skipRevList === true,
    );
    const reconnectStartToConvergenceMs = getTimerTime() - reconnectStartedAt;
    const observerBeforeForeground = await metalStatus(observer, options.skipRevList === true);
    const observerForegroundDocument =
      singleMetalRow(observerBeforeForeground.rows) ??
      singleMetalRow(observerBeforeForeground.devtoolsRows) ??
      (await waitForMetalProjectedDocument(
        observer,
        "observer foreground base document",
        timeoutMs,
      ));
    const streamConvergenceStartedAt = getTimerTime();

    const foregroundTitle = `${runId}: foreground`;
    const foregroundWriteStartedAt = getTimerTime();
    await metalDraftWrite(observer, observerForegroundDocument._id, foregroundTitle);
    const foregroundDocWriteMs = getTimerTime() - foregroundWriteStartedAt;
    const foregroundRevStartedAt = getTimerTime();
    const foregroundRev = await metalSnapshot(observer, observerForegroundDocument._id);
    const foregroundRevCreateMs = getTimerTime() - foregroundRevStartedAt;
    if (!foregroundRev) throw new Error("foreground rev.create returned null after catchup");

    await waitForAllMetalTitle(
      pages,
      foregroundTitle,
      "reconnect final convergence",
      timeoutMs,
      labels,
      options.skipRevList === true,
    );
    const streamConvergenceMs = getTimerTime() - streamConvergenceStartedAt;
    const statuses = await Promise.all(
      pages.map((page) => metalStatus(page, options.skipRevList === true)),
    );
    assertMetalStatus(...statuses, failures);
    const writerStatus = statuses[0]!;
    const observerStatus = statuses[1]!;
    const writerFinalTitle = singleMetalRow(writerStatus.rows)?.title ?? null;
    const observerFinalTitle = singleMetalRow(observerStatus.rows)?.title ?? null;
    const clientFinalTitles = statuses.map((status) => singleMetalRow(status.rows)?.title ?? null);
    const finalConvergenceCorrect = clientFinalTitles.every((title) => title === foregroundTitle);
    const remoteTicks = {
      observer: subtractMetalRemoteTicks(
        observerStatus.remoteTickTotals,
        reconnectBaselines[1]!.remoteTickTotals,
      ),
      total: subtractMetalRemoteTicks(summarizeMetalRemoteTicks(statuses), baselineRemoteTicks),
      writer: subtractMetalRemoteTicks(
        writerStatus.remoteTickTotals,
        reconnectBaselines[0]!.remoteTickTotals,
      ),
    };
    return {
      browser: "chromium",
      clientFinalTitles,
      clientStorageIds: statuses.map((status) => status.storageId),
      clients: clientCount,
      foregroundTitle,
      generatedAt: new Date().toISOString(),
      notes: [
        "first slice uses isolated browser contexts: one live writer, one restarted observer, and any requested live peers",
        "observer is fully closed while retained revision history is imported into the component and one ordinary app write is settled",
        "the component import replaces revision rows and is restricted to an explicitly named non-production deployment",
        "hosted revision volume is verified through the app-authorized revision:get query; localRevCount reports only revision metadata currently mirrored into the device store",
        "clients is benchmark-controlled; clients below 2 are raised to the minimum writer plus observer shape",
        "firstLocalQueryMs measures reconnect start to the observer's first local seeded document query result",
        "reconnectStartToFirstRemoteEventMs measures reconnect start to the observer's first remote event after reopen",
        "reconnectStartToConvergenceMs ends when the restarted observer catches up to the offline authoritative write",
        "streamConvergenceMs measures an app write plus savepoint issued by the observer after catchup and converging back to every client",
        "foreground latency samples run on the reconnecting observer, not the live writer",
      ],
      observerFinalTitle,
      observerStorageId: observerStatus.storageId,
      remoteTicks,
      revs: options.revs,
      runId,
      seedTitle,
      volumeFinalTitle,
      writerFinalTitle,
      writerStorageId: writerStatus.storageId,
      results: {
        finalConvergenceCorrect,
        firstLocalQueryMs: summarizeBenchSamples([openTiming.firstLocalQueryMs]),
        foregroundDocWriteMs: summarizeBenchSamples([foregroundDocWriteMs]),
        foregroundRevCreateMs: summarizeBenchSamples([foregroundRevCreateMs]),
        localRowCountAtFirstQuery: openTiming.localRowCount,
        localTitleAtFirstQuery: openTiming.localTitle,
        offlineRevCreateMs: summarizeBenchSamples([offlineRevCreateMs]),
        offlineWriteMs: summarizeBenchSamples([offlineWriteMs]),
        reconnectStartToFirstRemoteEventMs: summarizeBenchSamples(
          observerStatus.firstRemoteEventAfterLastOpenMs === null
            ? []
            : [observerStatus.firstRemoteEventAfterLastOpenMs],
        ),
        reconnectStartToConvergenceMs: summarizeBenchSamples([reconnectStartToConvergenceMs]),
        remotePullMs: summarizeMetalRemotePhase(
          [observerStatus],
          [baselineEventCounts[1]!],
          (event) => (event.tick?.pullAttempted ?? 0) > 0,
        ),
        hostedRevFirstReadMs: summarizeBenchSamples([hostedRevFirstReadMs]),
        hostedRevReadMs: summarizeBenchSamples(hostedRevReadSamples),
        hostedSeedVisible: options.revs === 0 || hostedSeed !== null,
        localRevCount: options.skipRevList === true ? null : metalStatusRevCount(observerStatus),
        revListSkipped: options.skipRevList === true,
        streamConvergenceMs: summarizeBenchSamples([streamConvergenceMs]),
        storeJobs: remoteTicks.observer.storeJobs,
        seedMs: summarizeBenchSamples([seedMs]),
      },
      version: 3,
    };
  } finally {
    await Promise.all(installedPages.map((page) => metalClose(page))).catch(() => undefined);
    await Promise.all(pages.map((page) => page.close())).catch(() => undefined);
    await Promise.all(contexts.map((context) => context.close())).catch(() => undefined);
  }
}

async function metalOpen(page: import("playwright").Page, remoteEnabled: boolean): Promise<void> {
  await page.evaluate(async (remoteEnabled) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    await state.open(remoteEnabled);
  }, remoteEnabled);
}

async function metalOpenTimed(
  page: import("playwright").Page,
  remoteEnabled: boolean,
): Promise<MetalOpenTiming> {
  return await page.evaluate(async (remoteEnabled) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    return await state.openTimed(remoteEnabled);
  }, remoteEnabled);
}

async function metalWatchDocument(
  page: import("playwright").Page,
  id: string | null,
): Promise<void> {
  await page.evaluate(async (id) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    await state.setWatchDocument(id);
  }, id);
}

async function metalClose(page: import("playwright").Page): Promise<void> {
  await page
    .evaluate(async () => {
      const state = (
        globalThis as typeof globalThis & {
          __embeddedMetalState?: MetalDeviceState;
        }
      ).__embeddedMetalState;
      await state?.close();
    })
    .catch(() => undefined);
}

async function metalCreate(page: import("playwright").Page, title: string): Promise<string> {
  return await page.evaluate(async (title) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    return await state.create(title);
  }, title);
}

async function metalDraftWrite(
  page: import("playwright").Page,
  id: string,
  title: string,
): Promise<void> {
  await page.evaluate(
    async ({ id, title }) => {
      const state = (
        globalThis as typeof globalThis & {
          __embeddedMetalState: MetalDeviceState;
        }
      ).__embeddedMetalState;
      await state.writeDraft(id, title);
    },
    { id, title },
  );
}

async function metalBodyWrite(
  page: import("playwright").Page,
  id: string,
  body: { delete: number; index: number; insert: string },
): Promise<void> {
  await page.evaluate(
    async ({ id, body }) => {
      const state = (
        globalThis as typeof globalThis & {
          __embeddedMetalState: MetalDeviceState;
        }
      ).__embeddedMetalState;
      await state.writeBody(id, body);
    },
    { id, body },
  );
}

async function metalSnapshot(
  page: import("playwright").Page,
  id: string,
): Promise<MetalRevEntry | null> {
  return await page.evaluate(async (id) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    return await state.snapshot(id);
  }, id);
}

async function metalGetSnapshot(
  page: import("playwright").Page,
  id: string,
  revId: string,
): Promise<MetalRevEntry | null> {
  return await page.evaluate(
    async ({ id, revId }) => {
      const state = (
        globalThis as typeof globalThis & {
          __embeddedMetalState: MetalDeviceState;
        }
      ).__embeddedMetalState;
      return await state.getSnapshot(id, revId);
    },
    { id, revId },
  );
}

async function metalRestoreSnapshot(
  page: import("playwright").Page,
  id: string,
  revId: string,
): Promise<MetalRevEntry | null> {
  return await page.evaluate(
    async ({ id, revId }) => {
      const state = (
        globalThis as typeof globalThis & {
          __embeddedMetalState: MetalDeviceState;
        }
      ).__embeddedMetalState;
      return await state.restoreSnapshot(id, revId);
    },
    { id, revId },
  );
}

async function metalOne(page: import("playwright").Page): Promise<MetalDocument> {
  return await page.evaluate(async () => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    return await state.one();
  });
}

async function metalStatus(
  page: import("playwright").Page,
  skipRevList = false,
): Promise<MetalDeviceStatus> {
  return await page.evaluate(async (skipRevList) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    const rows = await state.rows();
    const allDevtoolsRows = await state.allDevtoolsRows();
    const devtoolsRows = await state.devtoolsRows();
    const dirtyHeads = await state.dirtyHeads();
    const idMappings = await state.idMappings();
    const projections = await state.projections();
    const revs: MetalDeviceStatus["revs"] = {};
    if (!skipRevList) {
      for (const row of rows) {
        try {
          revs[row._id] = await state.revs(row._id);
        } catch (error) {
          revs[row._id] = {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          };
        }
      }
    }
    return {
      allDevtoolsRows,
      devtoolsRows,
      dirtyHeads,
      errors: [...state.errors],
      events: [...state.events],
      idMappings,
      projections,
      remoteTickTotals: { ...state.remoteTickTotals },
      revs,
      rows,
      firstRemoteEventAfterLastOpenMs: state.firstRemoteEventAfterLastOpenMs(),
      storageId: state.storageId,
    };
  }, skipRevList);
}

async function waitForMetalPushSettlement(
  page: import("playwright").Page,
  before: MetalRemoteTickTotals,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const result = await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page, true);
    const accepted = status.remoteTickTotals.pushAccepted > before.pushAccepted;
    const failed = status.remoteTickTotals.pushFailed > before.pushFailed;
    return {
      detail: metalWaitDetail(label, status),
      done: accepted || failed,
      value: { accepted, failed },
    };
  });
  if (!result.accepted) throw new Error(`${label} failed.`);
}

async function waitForMetalPull(
  page: import("playwright").Page,
  before: number,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page, true);
    return {
      detail: metalWaitDetail(label, status),
      done: status.remoteTickTotals.pullAttempted > before,
      value: undefined,
    };
  });
}

async function waitForMetalAcknowledgments(
  page: import("playwright").Page,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page, true);
    return {
      detail: metalWaitDetail(label, status),
      done:
        status.remoteTickTotals.receiptsPushed >=
        status.remoteTickTotals.pushAccepted +
          status.remoteTickTotals.pushConflicts +
          status.remoteTickTotals.pushFailed,
      value: undefined,
    };
  });
}

async function metalRevs(
  page: import("playwright").Page,
  id: string,
): Promise<MetalRevEntry["rev"][]> {
  return await page.evaluate(async (id) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedMetalState: MetalDeviceState;
      }
    ).__embeddedMetalState;
    return await state.revs(id);
  }, id);
}

export function summarizeBenchSamples(values: number[]): BrowserScaleBenchSample {
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
    p95: percentile(0.95),
    p99: percentile(0.99),
    samples: values.length,
  };
}

function summarizeMetalRemoteTicks(
  statuses: MetalDeviceStatus[],
): MetalScaleBenchReport["remoteTicks"] {
  const totals: MetalScaleBenchReport["remoteTicks"] = {
    pullAttempted: 0,
    pushAccepted: 0,
    pushAttempted: 0,
    pushConflicts: 0,
    pushRebases: 0,
    pushFailed: 0,
    received: 0,
    retainedRevisions: 0,
    rowsApplied: 0,
    sent: 0,
    receiptsPushed: 0,
    storeJobs: 0,
  };
  for (const status of statuses) {
    totals.pullAttempted += status.remoteTickTotals.pullAttempted;
    totals.pushAccepted += status.remoteTickTotals.pushAccepted;
    totals.pushAttempted += status.remoteTickTotals.pushAttempted;
    totals.pushConflicts += status.remoteTickTotals.pushConflicts;
    totals.pushRebases += status.remoteTickTotals.pushRebases;
    totals.pushFailed += status.remoteTickTotals.pushFailed;
    totals.received += status.remoteTickTotals.received;
    totals.retainedRevisions += status.remoteTickTotals.retainedRevisions;
    totals.rowsApplied += status.remoteTickTotals.rowsApplied;
    totals.sent += status.remoteTickTotals.sent;
    totals.receiptsPushed += status.remoteTickTotals.receiptsPushed;
    totals.storeJobs += status.remoteTickTotals.storeJobs;
  }
  return totals;
}

function subtractMetalRemoteTicks(
  total: MetalScaleBenchReport["remoteTicks"],
  baseline: MetalScaleBenchReport["remoteTicks"],
): MetalScaleBenchReport["remoteTicks"] {
  return {
    pullAttempted: Math.max(0, total.pullAttempted - baseline.pullAttempted),
    pushAccepted: Math.max(0, total.pushAccepted - baseline.pushAccepted),
    pushAttempted: Math.max(0, total.pushAttempted - baseline.pushAttempted),
    pushConflicts: Math.max(0, total.pushConflicts - baseline.pushConflicts),
    pushRebases: Math.max(0, total.pushRebases - baseline.pushRebases),
    pushFailed: Math.max(0, total.pushFailed - baseline.pushFailed),
    received: Math.max(0, total.received - baseline.received),
    retainedRevisions: Math.max(0, total.retainedRevisions - baseline.retainedRevisions),
    rowsApplied: Math.max(0, total.rowsApplied - baseline.rowsApplied),
    sent: Math.max(0, total.sent - baseline.sent),
    receiptsPushed: Math.max(0, total.receiptsPushed - baseline.receiptsPushed),
    storeJobs: Math.max(0, total.storeJobs - baseline.storeJobs),
  };
}

function summarizeMetalRemotePhase(
  statuses: MetalDeviceStatus[],
  baselineEventCounts: number[],
  includes: (event: MetalEventSummary) => boolean,
): BrowserScaleBenchSample {
  const values = statuses.flatMap((status, index) =>
    status.events
      .slice(baselineEventCounts[index] ?? 0)
      .filter(
        (event) =>
          event.type === "remote" &&
          (event.status === "tick" || event.status === "idle" || event.status === "error") &&
          event.durationMs !== undefined &&
          includes(event),
      )
      .map((event) => event.durationMs!),
  );
  return summarizeBenchSamples(values);
}

async function waitForMetalTitle(
  page: import("playwright").Page,
  title: string,
  label: string,
  timeoutMs: number,
): Promise<MetalDocument> {
  return await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page);
    assertMetalStatus(status);
    const row = singleMetalRow(status.rows);
    return {
      detail: metalWaitDetail(title, status),
      done: row?.title === title,
      value: row!,
    };
  });
}

async function waitForMetalProjectedTitle(
  page: import("playwright").Page,
  title: string,
  label: string,
  timeoutMs: number,
): Promise<MetalDocument> {
  return await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page);
    assertMetalStatus(status);
    const row =
      singleMetalRow(status.rows) ??
      singleMetalRow(status.devtoolsRows) ??
      status.devtoolsRows.find((item) => item.title === title);
    return {
      detail: metalWaitDetail(title, status),
      done: row?.title === title,
      value: row!,
    };
  });
}

async function waitForMetalProjectedDocument(
  page: import("playwright").Page,
  label: string,
  timeoutMs: number,
): Promise<MetalDocument> {
  return await waitForMetalCondition(label, timeoutMs, async () => {
    const status = await metalStatus(page);
    assertMetalStatus(status);
    const row = singleMetalRow(status.rows) ?? singleMetalRow(status.devtoolsRows);
    return {
      detail: metalWaitDetail("<any>", status),
      done: row !== undefined,
      value: row!,
    };
  });
}

async function waitForAllMetalTitle(
  pages: import("playwright").Page[],
  title: string,
  label: string,
  timeoutMs: number,
  labels: readonly string[],
  skipRevList = false,
): Promise<void> {
  await waitForMetalCondition(label, timeoutMs, async () => {
    const statuses = await Promise.all(pages.map((page) => metalStatus(page, skipRevList)));
    assertMetalStatus(...statuses);
    const rows = statuses.map((status) => singleMetalRow(status.rows));
    return {
      detail: metalGroupWaitDetail(labels, title, statuses),
      done: rows.every((row) => row?.title === title),
      value: undefined,
    };
  });
}

async function waitForAllMetalBody(
  pages: import("playwright").Page[],
  body: string,
  label: string,
  timeoutMs: number,
  labels: readonly string[],
): Promise<void> {
  await waitForMetalCondition(label, timeoutMs, async () => {
    const statuses = await Promise.all(pages.map((page) => metalStatus(page, true)));
    assertMetalStatus(...statuses);
    const rows = statuses.map((status) => singleMetalRow(status.rows));
    return {
      detail: {
        expectedBody: body,
        devices: metalGroupWaitDetail(labels, label, statuses),
      },
      done: rows.every((row) => row?.body === body),
      value: undefined,
    };
  });
}

function metalStatusRevCount(status: MetalDeviceStatus): number {
  const row = singleMetalRow(status.rows);
  if (!row) return 0;
  const revs = status.revs[row._id];
  return Array.isArray(revs) ? revs.length : 0;
}

function metalGroupWaitDetail(
  labels: readonly string[],
  title: string,
  statuses: MetalDeviceStatus[],
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [index, status] of statuses.entries()) {
    detail[labels[index] ?? `device-${index}`] = metalWaitDetail(title, status);
  }
  return detail;
}

function metalWaitDetail(title: string, status: MetalDeviceStatus): unknown {
  const remoteTicks = status.events
    .filter((event) => event.type === "remote" && event.tick !== undefined)
    .map((event) => event.tick!);
  const remoteEvents = status.events.filter((event) => event.type === "remote");
  const remoteDebugEvents = status.events.filter(
    (event) =>
      event.type === "debug" &&
      (event.phase?.startsWith("worker:remote") || event.phase?.startsWith("worker:wasm:thread")),
  );
  const meaningfulRemoteTicks = remoteTicks.filter((tick) => {
    return (
      (tick.changedTables?.length ?? 0) > 0 ||
      (tick.pushAccepted ?? 0) > 0 ||
      (tick.pushAttempted ?? 0) > 0 ||
      (tick.pushFailed ?? 0) > 0 ||
      (tick.pushed ?? 0) > 0 ||
      (tick.received ?? 0) > 0 ||
      (tick.retainedRevisions ?? 0) > 0 ||
      (tick.rowsApplied ?? 0) > 0 ||
      (tick.sent ?? 0) > 0
    );
  });
  return {
    devtoolsRows: status.devtoolsRows.map((item) => ({ id: item._id, title: item.title })),
    allDevtoolsRows: status.allDevtoolsRows
      .slice(0, 12)
      .map((item) => ({ id: item._id, title: item.title })),
    dirtyHeads: status.dirtyHeads,
    events: status.events.slice(-24),
    errors: status.errors,
    remoteTickTotals: status.remoteTickTotals,
    remoteDebugEvents: remoteDebugEvents.slice(-80),
    remoteEvents: remoteEvents.slice(-24),
    meaningfulRemoteTicks: meaningfulRemoteTicks.slice(-24),
    remoteTicks: remoteTicks.slice(-24),
    idMappings: status.idMappings,
    projections: status.projections,
    revs: status.revs,
    rows: status.rows.map((item) => ({ id: item._id, title: item.title })),
    storageId: status.storageId,
    title,
  };
}

function metalConflictWaitDetail(
  labels: readonly string[],
  statuses: MetalDeviceStatus[],
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [index, status] of statuses.entries()) {
    detail[labels[index] ?? `device-${index}`] = {
      conflictCount: Object.values(status.revs).reduce(
        (sum, revs) =>
          sum + (Array.isArray(revs) ? revs.filter((rev) => rev.status === "conflict").length : 0),
        0,
      ),
      events: status.events.slice(-8),
      rows: status.rows.map((item) => ({ id: item._id, title: item.title })),
      storageId: status.storageId,
    };
  }
  return detail;
}

async function waitForMetalCondition<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<{ detail?: unknown; done: boolean; value: T }>,
): Promise<T> {
  const deadline = getTimerTime() + timeoutMs;
  let lastDetail: unknown;
  while (getTimerTime() < deadline) {
    try {
      const result = await check();
      lastDetail = result.detail;
      if (result.done) return result.value;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new MetalWaitError(label, lastDetail);
}

function assertMetalStatus(...statuses: Array<MetalDeviceStatus | string[]>): void {
  const errors = statuses.flatMap((status) => (Array.isArray(status) ? status : status.errors));
  if (errors.length > 0) {
    throw new Error(`Metal browser sync observed errors:\n${errors.join("\n")}`);
  }
}

function singleMetalRow(rows: MetalDocument[]): MetalDocument | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

function metalConvexId(status: MetalDeviceStatus, localId: string): string {
  const mapping = status.idMappings.find((entry) => entry.localId === localId);
  const convexId = mapping?.convexId;
  if (typeof convexId !== "string" || convexId.length === 0) {
    throw new Error(`Metal document ${localId} has no settled Convex ID mapping.`);
  }
  return convexId;
}

function metalConflictObserved(...statuses: MetalDeviceStatus[]): boolean {
  return statuses.some((status) => {
    if (
      Object.values(status.revs).some((revs) =>
        Array.isArray(revs) ? revs.some((rev) => rev.status === "conflict") : false,
      )
    ) {
      return true;
    }
    return status.events.some((event) => {
      if (event.type === "conflict") return true;
      if ((event.tick?.retainedRevisions ?? 0) > 0) return true;
      return false;
    });
  });
}
