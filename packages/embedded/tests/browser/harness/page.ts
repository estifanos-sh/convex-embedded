import { getTimerTime } from "../../../src/time.js";

import { devtoolsDistPath } from "../../bench/harness/paths.js";
import type {
  BrowserDirectPageState,
  BrowserLatencyBenchResult,
  BrowserLatencyBenchSample,
  BrowserLatencyBenchScenario,
  BrowserRemoteAdmissionTiming,
  BrowserRemoteRuntimeTiming,
  BrowserRemoteTickEvidence,
  BrowserScaleBenchSample,
  BrowserScalePageState,
  MetalDeviceState,
  MetalDocument,
  MetalEventSummary,
  MetalOpenTiming,
  MetalRemoteTickTotals,
  MetalRevEntry,
  MetalWatchTarget,
} from "../../bench/harness/types.js";

const disallowedBrowserRuntimeError =
  /leader became unresponsive|worker request|timed out|document write failed/i;

export interface EmbeddedPageState {
  channel: string;
  client: {
    doc: { write(table: string, id: string, fields: Record<string, unknown>): Promise<void> };
    mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
    query(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  errors: string[];
  updates: Array<Array<{ text: string }>>;
  writeDocument(body: string): Promise<void>;
}

export async function installEmbeddedPage(
  page: import("playwright").Page,
  url: string,
  browserUrl: string,
  channel: string,
  options: { clearStorageId?: boolean; initialQuery?: boolean } = {},
): Promise<void> {
  await page.goto(url);
  if (options.clearStorageId) {
    await page.evaluate(() => localStorage.removeItem("convex-embedded.storageId"));
  }
  await page.evaluate(
    async ({ browserUrl, channel, initialQuery, storageId }) => {
      if (storageId) localStorage.setItem("convex-embedded.storageId", storageId);
      (
        globalThis as typeof globalThis & {
          __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: unknown) => void;
        }
      ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
        void fetch(
          `/__convex_embedded_browser_log?entry=${encodeURIComponent(
            JSON.stringify({
              detail: event,
              now: Math.trunc(performance.now()),
              phase: "multipage:debug",
              runtime: performance.now(),
              url: location.href,
            }),
          )}`,
        ).catch(() => undefined);
      };
      const { ConvexEmbeddedClient } = await import(browserUrl);
      const client = new ConvexEmbeddedClient();
      const errors: string[] = [];
      const updates: Array<Array<{ text: string }>> = [];
      let observedData = false;
      const formatError = (error: unknown) =>
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const writeDocument = async (body: string) => {
        const title = `${channel}:${body}`;
        const row = (await client.mutation("documents:create", {})) as { _id: string };
        await client.mutation("documents:update", {
          id: row._id,
          title,
          updatedAt: Math.trunc(performance.now()),
        });
      };
      const pushRows = (rows: Array<{ title: string }>) => {
        const scopedRows = rows
          .filter((row) => row.title.startsWith(`${channel}:`))
          .map((row) => ({ text: row.title.slice(channel.length + 1) }));
        if (observedData && scopedRows.length === 0) {
          errors.push("observed empty query result after data had existed");
        }
        if (scopedRows.length > 0) observedData = true;
        updates.push(scopedRows);
      };
      if (initialQuery) {
        try {
          pushRows((await client.query("documents:list", {})) as Array<{ title: string }>);
        } catch (error) {
          errors.push(formatError(error));
          throw error;
        }
      }
      const watch = client.watchQuery("documents:list", {});
      watch.onUpdate(
        () => {
          pushRows((watch.localQueryResult() ?? []) as Array<{ title: string }>);
        },
        (error: unknown) => errors.push(formatError(error)),
      );
      (globalThis as typeof globalThis & { __embeddedPageState?: unknown }).__embeddedPageState = {
        channel,
        client,
        errors,
        updates,
        writeDocument,
      };
    },
    {
      browserUrl,
      channel,
      initialQuery: options.initialQuery ?? true,
      storageId: `browser-command-${channel}`,
    },
  );
}

export async function installMetalDevicePage(
  page: import("playwright").Page,
  url: string,
  browserUrl: string,
  options: {
    device: string;
    initialWatch?: "list" | "none";
    queryLimit: number;
    remoteUrl: string;
    runId: string;
    storageId: string;
  },
): Promise<void> {
  await page.goto(`${url}?metal=${encodeURIComponent(`${options.device}-${getTimerTime()}`)}`);
  await page.evaluate(
    async ({ browserUrl, device, initialWatch, queryLimit, remoteUrl, runId, storageId }) => {
      localStorage.setItem("convex-embedded.storageId", storageId);
      const { ConvexEmbeddedClient } = await import(browserUrl);
      type BrowserClient = {
        close(): Promise<void>;
        mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
        query(name: string, args: Record<string, unknown>): Promise<unknown>;
        __devtoolsRuntime?(
          request:
            | {
                cursor?: string | null;
                kind: "listRows";
                limit?: number;
                table: string;
              }
            | { kind: "snapshot" },
        ): Promise<{
          cursor?: string | null;
          isDone?: boolean;
          rows?: MetalDocument[];
          storage?: {
            dirtyHeads?: Array<Record<string, unknown>>;
            idMappings: Array<Record<string, unknown>>;
            projections: Array<Record<string, unknown>>;
          };
        }>;
        subscribeEvents(listener: (event: unknown) => void): () => void;
        watchQuery(
          name: string,
          args: Record<string, unknown>,
        ): {
          localQueryResult(): unknown;
          onUpdate(callback: () => void, onError?: (error: unknown) => void): () => void;
        };
      };
      let client: BrowserClient | undefined;
      let stopEvents: (() => void) | undefined;
      let stopWatch: (() => void) | undefined;
      let watchTarget: MetalWatchTarget =
        initialWatch === "none" ? { kind: "none" } : { kind: "list" };
      const errors: string[] = [];
      const events: MetalEventSummary[] = [];
      let lastOpenStartedAt: number | null = null;
      let firstRemoteEventAfterLastOpenMs: number | null = null;
      const remoteTickTotals: MetalRemoteTickTotals = {
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
        settlementsAcknowledged: 0,
        storeJobs: 0,
      };
      const pushEvent = (event: MetalEventSummary) => {
        if (
          event.type === "remote" &&
          lastOpenStartedAt !== null &&
          firstRemoteEventAfterLastOpenMs === null
        ) {
          firstRemoteEventAfterLastOpenMs = performance.now() - lastOpenStartedAt;
        }
        if (event.type === "remote" && event.tick !== undefined) {
          remoteTickTotals.pullAttempted += event.tick.pullAttempted ?? 0;
          remoteTickTotals.pushAccepted += event.tick.pushAccepted ?? 0;
          remoteTickTotals.pushAttempted += event.tick.pushAttempted ?? 0;
          remoteTickTotals.pushConflicts += event.tick.pushConflicts ?? 0;
          remoteTickTotals.pushRebases += event.tick.pushRebases ?? 0;
          remoteTickTotals.pushFailed += event.tick.pushFailed ?? 0;
          remoteTickTotals.received += event.tick.received ?? 0;
          remoteTickTotals.retainedRevisions += event.tick.retainedRevisions ?? 0;
          remoteTickTotals.rowsApplied += event.tick.rowsApplied ?? 0;
          remoteTickTotals.sent += event.tick.sent ?? 0;
          remoteTickTotals.settlementsAcknowledged += event.tick.settlementsAcknowledged ?? 0;
          remoteTickTotals.storeJobs += event.tick.storeJobs ?? 0;
        }
        events.push(event);
        if (events.length > 2_000) events.splice(0, events.length - 2_000);
      };
      (
        globalThis as typeof globalThis & {
          __CONVEX_EMBEDDED_DEBUG_LOG__?: (event: {
            detail?: unknown;
            phase: string;
            source: "worker";
          }) => void;
        }
      ).__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
        if (
          !event.phase.startsWith("worker:remote") &&
          !event.phase.startsWith("worker:coordination")
        ) {
          return;
        }
        pushEvent({ detail: event.detail, phase: event.phase, type: "debug" });
      };
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const formatError = (error: unknown) =>
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const bodyFor = (title: string) =>
        JSON.stringify([
          { type: "heading", props: { level: 1 }, content: title },
          { type: "paragraph", content: `${title} body` },
        ]);
      const startWatch = () => {
        stopWatch?.();
        stopWatch = undefined;
        if (!client || watchTarget.kind === "none") return;
        const watch =
          watchTarget.kind === "document"
            ? client.watchQuery("documents:get", { id: watchTarget.id })
            : client.watchQuery("documents:list", { limit: queryLimit });
        stopWatch = watch.onUpdate(
          () => {
            try {
              const result = watch.localQueryResult();
              if (watchTarget.kind === "document") {
                const row = result as MetalDocument | null;
                if (row && !row.title.startsWith(`${runId}:`)) {
                  errors.push(`target document escaped run scope: ${row.title}`);
                }
              } else {
                ((result ?? []) as MetalDocument[]).filter((row) =>
                  row.title.startsWith(`${runId}:`),
                );
              }
            } catch (error) {
              errors.push(formatError(error));
            }
          },
          (error) => errors.push(formatError(error)),
        );
      };
      const summarizeEvent = (event: unknown): MetalEventSummary => {
        if (!event || typeof event !== "object") return {};
        const item = event as {
          conflicts?: unknown[];
          durationMs?: number;
          error?: string;
          name?: string;
          phase?: string;
          status?: string;
          tick?: {
            changedTables?: string[];
            pullAttempted?: number;
            pushAccepted?: number;
            pushAttempted?: number;
            pushConflicts?: number;
            pushRebases?: number;
            pushFailed?: number;
            pushed?: number;
            received?: number;
            reconnected?: boolean;
            retainedRevisions?: number;
            rowsApplied?: number;
            sent?: number;
            settlementsAcknowledged?: number;
            storeJobs?: number;
          };
          type?: string;
        };
        return {
          ...(item.type === undefined ? {} : { type: item.type }),
          ...(item.name === undefined ? {} : { name: item.name }),
          ...(item.phase === undefined ? {} : { phase: item.phase }),
          ...(item.status === undefined ? {} : { status: item.status }),
          ...(item.durationMs === undefined ? {} : { durationMs: Number(item.durationMs) }),
          ...(item.error === undefined ? {} : { error: item.error }),
          ...(item.conflicts === undefined ? {} : { conflicts: item.conflicts }),
          ...(item.tick === undefined
            ? {}
            : {
                tick: {
                  changedTables: item.tick.changedTables,
                  pullAttempted: item.tick.pullAttempted,
                  pushAccepted: item.tick.pushAccepted,
                  pushAttempted: item.tick.pushAttempted,
                  pushConflicts: item.tick.pushConflicts,
                  pushRebases: item.tick.pushRebases,
                  pushFailed: item.tick.pushFailed,
                  pushed: item.tick.pushed,
                  received: item.tick.received,
                  reconnected: item.tick.reconnected,
                  retainedRevisions: item.tick.retainedRevisions,
                  rowsApplied: item.tick.rowsApplied,
                  sent: item.tick.sent,
                  settlementsAcknowledged: item.tick.settlementsAcknowledged,
                  storeJobs: item.tick.storeJobs,
                },
              }),
        };
      };
      const currentClient = () => {
        if (!client) throw new Error(`Metal device ${device} is not open.`);
        return client;
      };
      const revisionEntry = async (
        id: string,
        revision: Record<string, unknown> | null,
        document?: MetalDocument | null,
      ): Promise<MetalRevEntry | null> => {
        if (!revision) return null;
        const current =
          document ??
          ((await currentClient().query("documents:get", { id })) as MetalDocument | null);
        const value = revision.value as Omit<MetalDocument, "_id" | "_creationTime"> | undefined;
        return {
          doc:
            revision.deleted === true || !value || !current
              ? null
              : { _id: id, _creationTime: current._creationTime, ...value },
          rev: {
            revId: String(revision.revId),
            status: String(revision.status),
            updatedTime: Number(revision.createdAt),
            ...(typeof revision.origin === "string" ? { origin: revision.origin } : {}),
            ...(typeof revision.parentRevId === "string"
              ? { parentRevId: revision.parentRevId }
              : {}),
          },
        };
      };
      const rows = async () => {
        if (watchTarget.kind === "document") {
          const result = (await currentClient().query("documents:get", {
            id: watchTarget.id,
          })) as MetalDocument | null;
          return result && result.title.startsWith(`${runId}:`) ? [result] : [];
        }
        const result = (await currentClient().query("documents:list", {
          limit: queryLimit,
        })) as MetalDocument[];
        return result.filter((row) => row.title.startsWith(`${runId}:`));
      };
      const allDevtoolsRows = async () => {
        const result = await currentClient().__devtoolsRuntime?.({
          kind: "listRows",
          limit: 200,
          table: "documents",
        });
        return result?.rows ?? [];
      };
      const devtoolsRows = async () => {
        const rows: MetalDocument[] = [];
        let cursor: string | null = null;
        do {
          const result = (await currentClient().__devtoolsRuntime?.({
            cursor,
            kind: "listRows",
            limit: 1024,
            table: "documents",
          })) as { cursor?: string | null; rows?: MetalDocument[] } | undefined;
          rows.push(
            ...((result?.rows ?? []).filter((row: MetalDocument) =>
              row.title.startsWith(`${runId}:`),
            ) as MetalDocument[]),
          );
          cursor = result?.cursor ?? null;
        } while (cursor !== null);
        return rows;
      };
      const dirtyHeads = async () => {
        const result = await currentClient().__devtoolsRuntime?.({ kind: "snapshot" });
        return result?.storage?.dirtyHeads ?? [];
      };
      const projections = async () => {
        const result = await currentClient().__devtoolsRuntime?.({ kind: "snapshot" });
        return result?.storage?.projections ?? [];
      };
      const idMappings = async () => {
        const result = await currentClient().__devtoolsRuntime?.({ kind: "snapshot" });
        const currentRows = await rows();
        const currentIds = new Set(currentRows.map((row) => row._id));
        return (result?.storage?.idMappings ?? []).filter((row) => {
          return (
            row.table === "documents" &&
            typeof row.localId === "string" &&
            currentIds.has(row.localId)
          );
        });
      };
      const close = async () => {
        stopWatch?.();
        stopWatch = undefined;
        stopEvents?.();
        stopEvents = undefined;
        const closing = client;
        client = undefined;
        await closing?.close();
        await delay(1_300);
      };
      const openTimed = async (remoteEnabled: boolean): Promise<MetalOpenTiming> => {
        await close();
        const startedAt = performance.now();
        lastOpenStartedAt = startedAt;
        firstRemoteEventAfterLastOpenMs = null;
        const created = new ConvexEmbeddedClient(
          remoteEnabled ? { url: remoteUrl } : {},
        ) as BrowserClient;
        client = created;
        stopEvents = created.subscribeEvents((event) => {
          const summary = summarizeEvent(event);
          pushEvent(summary);
        });
        startWatch();
        const initialRows = await rows();
        return {
          firstLocalQueryMs: performance.now() - startedAt,
          localRowCount: initialRows.length,
          localTitle:
            initialRows.length === 1 ? initialRows[0]!.title : (initialRows.at(-1)?.title ?? null),
        };
      };
      const open = async (remoteEnabled: boolean) => {
        await openTimed(remoteEnabled);
      };
      const state: MetalDeviceState = {
        writeBody: async (id, body) => {
          await currentClient().mutation("documents:writeBody", { id, splices: [body] });
        },
        writeDraft: async (id, title) => {
          await currentClient().mutation("documents:update", {
            id,
            title,
            updatedAt: Math.trunc(performance.now()),
          });
        },
        close,
        create: async (title) => {
          const doc = (await currentClient().mutation("documents:create", {
            body: bodyFor(title),
            slug: title,
            title,
            updatedAt: Math.trunc(performance.now()),
          })) as MetalDocument;
          return doc._id;
        },
        allDevtoolsRows,
        devtoolsRows,
        dirtyHeads,
        errors,
        events,
        getSnapshot: async (id, revId) =>
          await revisionEntry(
            id,
            (await currentClient().query("documents:revision", { id, revId })) as Record<
              string,
              unknown
            > | null,
          ),
        one: async () => {
          const current = await rows();
          if (current.length !== 1) {
            throw new Error(
              `Expected one ${runId} document on ${device}, got ${current.length}: ${JSON.stringify(
                {
                  allRows: await allDevtoolsRows(),
                  dirtyHeads: await dirtyHeads(),
                  idMappings: await idMappings(),
                  remoteTickTotals,
                },
              )}`,
            );
          }
          return current[0]!;
        },
        open,
        openTimed,
        firstRemoteEventAfterLastOpenMs: () => firstRemoteEventAfterLastOpenMs,
        idMappings,
        projections,
        remoteTickTotals,
        restoreSnapshot: async (id, revId) => {
          const restored = (await currentClient().mutation("documents:restore", {
            id,
            revId,
          })) as { document: MetalDocument; revision: Record<string, unknown> };
          return await revisionEntry(id, restored.revision, restored.document);
        },
        revs: async (id) => {
          const revisions: MetalRevEntry["rev"][] = [];
          let cursor: string | null = null;
          do {
            const result = (await currentClient().query("documents:history", {
              id,
              cursor,
              numItems: 100,
            })) as {
              continueCursor: string;
              isDone: boolean;
              page: MetalRevEntry["rev"][];
            };
            revisions.push(
              ...result.page.map((revision) => ({
                revId: String((revision as Record<string, unknown>).revId),
                status: String((revision as Record<string, unknown>).status),
                updatedTime: Number((revision as Record<string, unknown>).createdAt),
              })),
            );
            cursor = result.isDone ? null : result.continueCursor;
            if (result.isDone) break;
          } while (cursor !== null);
          return revisions;
        },
        rows,
        setWatchDocument: async (id) => {
          watchTarget = id === null ? { kind: "none" } : { kind: "document", id };
          startWatch();
        },
        snapshot: async (id) =>
          await revisionEntry(
            id,
            (await currentClient().mutation("documents:savepoint", { id })) as Record<
              string,
              unknown
            >,
          ),
        storageId,
      };
      (
        globalThis as typeof globalThis & {
          __embeddedMetalState?: MetalDeviceState;
        }
      ).__embeddedMetalState = state;
      await state.open(true);
    },
    { ...options, browserUrl },
  );
}

export async function installDirectRemoteBenchPage(
  page: import("playwright").Page,
  pageUrl: string,
  convexBrowserUrl: string,
  convexServerUrl: string,
  remoteUrl: string,
  prefix: string,
): Promise<void> {
  await page.goto(`${pageUrl}?direct=${encodeURIComponent(prefix)}`);
  await page.evaluate(
    async ({ convexBrowserUrl, convexServerUrl, prefix, remoteUrl }) => {
      const [{ ConvexClient }, { makeFunctionReference }] = await Promise.all([
        import(convexBrowserUrl),
        import(convexServerUrl),
      ]);
      type Row = { _id: string; title: string; updatedAt: number };
      const client = new ConvexClient(remoteUrl);
      const summaries = makeFunctionReference("documents:summaries");
      const get = makeFunctionReference("documents:get");
      const create = makeFunctionReference("documents:create");
      const update = makeFunctionReference("documents:update");
      const writeSlug = makeFunctionReference("documents:writeSlug");
      const remove = makeFunctionReference("documents:remove");
      let rows: Row[] = [];
      let summaryKeys: string[] = [];
      let stopDocument: (() => void) | undefined;
      let documentTitle: string | undefined;
      let documentSlug: string | undefined;
      let listTransitions = 0;
      let pointTransitions = 0;
      let nextWaiter = 1;
      const listeners = new Set<() => void>();
      const waiters = new Map<number, Promise<number>>();
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const waitFor = (read: () => boolean, label: string, timeoutMs: number): Promise<number> =>
        new Promise((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = () => {
            clearTimeout(timer);
            listeners.delete(check);
          };
          const check = () => {
            if (!read()) return;
            finish();
            resolve(performance.now());
          };
          timer = setTimeout(() => {
            finish();
            reject(new Error(`Timed out waiting for ${label}.`));
          }, timeoutMs);
          listeners.add(check);
          check();
        });
      const arm = (promise: Promise<number>) => {
        const id = nextWaiter++;
        waiters.set(id, promise);
        return id;
      };
      const stop = client.onUpdate(
        summaries,
        { limit: 40, prefix },
        (value: unknown) => {
          if (Array.isArray(value)) {
            rows = value as Row[];
            const first = rows[0];
            if (first) summaryKeys = Object.keys(first).sort();
          }
          listTransitions += 1;
          notify();
        },
        (error: Error) => {
          throw error;
        },
      );
      const state: BrowserDirectPageState = {
        armDocumentSlug: (slug, timeoutMs) =>
          arm(waitFor(() => documentSlug === slug, `document slug ${slug}`, timeoutMs)),
        armDocumentTitle: (title, timeoutMs) =>
          arm(waitFor(() => documentTitle === title, `document title ${title}`, timeoutMs)),
        armMissing: (title, timeoutMs) =>
          arm(
            waitFor(() => !rows.some((row) => row.title === title), `${title} deletion`, timeoutMs),
          ),
        armTitle: (title, timeoutMs) =>
          arm(waitFor(() => rows.some((row) => row.title === title), title, timeoutMs)),
        close: async () => {
          stop();
          stopDocument?.();
          await client.close();
        },
        create: async (title, body) => {
          const created = (await client.mutation(create, {
            body,
            slug: title,
            title,
            updatedAt: performance.now(),
          })) as { _id: string };
          return { id: created._id };
        },
        remove: async (id) => {
          await client.mutation(remove, { id });
        },
        rows: () => rows,
        select: (id) => {
          stopDocument?.();
          stopDocument = client.onUpdate(get, { id }, (value: unknown) => {
            const document = value as { slug?: string; title?: string } | null;
            documentTitle = document?.title;
            documentSlug = document?.slug;
            pointTransitions += 1;
            notify();
          });
        },
        summaryKeys: () => summaryKeys,
        listTransitionCount: () => listTransitions,
        pointTransitionCount: () => pointTransitions,
        transitionCount: () => listTransitions,
        update: async (id, title, updatedAt) => {
          const startedAt = performance.now();
          await client.mutation(update, { id, title, updatedAt });
          return { consistencyMs: performance.now() - startedAt };
        },
        writeSlug: async (id, slug) => {
          const startedAt = performance.now();
          await client.mutation(writeSlug, { id, slug });
          return { consistencyMs: performance.now() - startedAt };
        },
        wait: async (id) => {
          const waiter = waiters.get(id);
          if (!waiter) throw new Error(`Unknown direct benchmark waiter ${id}.`);
          try {
            return await waiter;
          } finally {
            waiters.delete(id);
          }
        },
      };
      (
        globalThis as typeof globalThis & { __convexBrowserRemote?: BrowserDirectPageState }
      ).__convexBrowserRemote = state;
    },
    { convexBrowserUrl, convexServerUrl, prefix, remoteUrl },
  );
}

export async function installBrowserRemoteBenchPage(
  page: import("playwright").Page,
  pageUrl: string,
  browserUrl: string,
  remoteUrl: string,
  storageId: string,
  prefix: string,
): Promise<void> {
  await page.goto(`${pageUrl}?remote=${encodeURIComponent(storageId)}`);
  await page.evaluate(
    async ({ browserUrl, prefix, remoteUrl, storageId }) => {
      localStorage.setItem("convex-embedded.storageId", storageId);
      const { ConvexEmbeddedClient } = await import(browserUrl);
      const client = new ConvexEmbeddedClient({ url: remoteUrl });
      type Summary = { _id: string; title: string; updatedAt: number };
      type Document = { _id: string; body: string; title: string };
      type Tick = BrowserRemoteTickEvidence;
      const events: Tick[] = [];
      let accepted = 0;
      let cacheServes = 0;
      let resultWrites = 0;
      let summaryKeys: string[] = [];
      let runtimeAdmission: BrowserRemoteRuntimeTiming | undefined;
      let rows: Summary[] = [];
      const documents = new Map<string, Document | null>();
      const documentStops = new Map<string, () => void>();
      let listTransitions = 0;
      let pointTransitions = 0;
      let nextWaiter = 1;
      const listeners = new Set<() => void>();
      const waiters = new Map<number, Promise<number>>();
      const absoluteNow = () => performance.now();
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const waitFor = (read: () => boolean, label: string, timeoutMs: number): Promise<number> =>
        new Promise((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = () => {
            clearTimeout(timer);
            listeners.delete(check);
          };
          const check = () => {
            if (!read()) return;
            finish();
            resolve(absoluteNow());
          };
          timer = setTimeout(() => {
            finish();
            reject(new Error(`Timed out waiting for ${label}.`));
          }, timeoutMs);
          listeners.add(check);
          check();
        });
      const arm = (promise: Promise<number>) => {
        const id = nextWaiter++;
        waiters.set(id, promise);
        return id;
      };
      const watchDocument = (id: string) => {
        if (documentStops.has(id)) return;
        const documentWatch = client.watchQuery("documents:get", { id });
        const refreshDocument = () => {
          documents.set(id, documentWatch.localQueryResult() as Document | null);
          pointTransitions += 1;
          notify();
        };
        documentStops.set(id, documentWatch.onUpdate(refreshDocument));
        refreshDocument();
      };
      client.subscribeInternalEvents?.((event: unknown) => {
        const operation = event as {
          kind?: string;
          phase?: string;
          timing?: BrowserRemoteRuntimeTiming;
          type?: string;
        };
        if (
          operation.type === "operation" &&
          operation.kind === "mutation" &&
          operation.phase === "finish" &&
          operation.timing
        ) {
          runtimeAdmission = operation.timing;
          return;
        }
        const data = event as { source?: string; type?: string };
        if (data.type === "data" && data.source === "cache") {
          cacheServes += 1;
          notify();
          return;
        }
        const remote = event as {
          durationMs?: number;
          foreground?: { actorQueueDepth?: number; actorQueueMs?: number };
          tick?: Partial<Tick> & { changedResults?: string[] };
          type?: string;
        };
        if (remote.type !== "remote" || !remote.tick) return;
        const tick = remote.tick;
        accepted += tick.pushAccepted ?? 0;
        const tickResultWrites = tick.changedResults?.length ?? 0;
        resultWrites += tickResultWrites;
        events.push({
          actorQueueDepth: remote.foreground?.actorQueueDepth ?? 0,
          actorQueueMs: remote.foreground?.actorQueueMs ?? 0,
          durationMs: remote.durationMs ?? 0,
          pullAttempted: tick.pullAttempted ?? 0,
          pushAccepted: tick.pushAccepted ?? 0,
          pushAttempted: tick.pushAttempted ?? 0,
          received: tick.received ?? 0,
          resultWrites: tickResultWrites,
          rowsApplied: tick.rowsApplied ?? 0,
          sent: tick.sent ?? 0,
          storeJobs: tick.storeJobs ?? 0,
        });
        notify();
      });
      const watch = client.watchQuery("documents:summaries", { limit: 40, prefix });
      const refresh = () => {
        try {
          const value = watch.localQueryResult();
          if (Array.isArray(value)) {
            rows = value as Summary[];
            const first = rows[0];
            if (first) summaryKeys = Object.keys(first).sort();
          }
        } finally {
          listTransitions += 1;
          notify();
        }
      };
      const stop = watch.onUpdate(refresh);
      refresh();
      const evidenceSince = (cursor: number): Tick =>
        events.slice(cursor).reduce<Tick>(
          (total, tick) => ({
            actorQueueDepth: Math.max(total.actorQueueDepth, tick.actorQueueDepth),
            actorQueueMs: total.actorQueueMs + tick.actorQueueMs,
            durationMs: total.durationMs + tick.durationMs,
            pullAttempted: total.pullAttempted + tick.pullAttempted,
            pushAccepted: total.pushAccepted + tick.pushAccepted,
            pushAttempted: total.pushAttempted + tick.pushAttempted,
            received: total.received + tick.received,
            resultWrites: total.resultWrites + tick.resultWrites,
            rowsApplied: total.rowsApplied + tick.rowsApplied,
            sent: total.sent + tick.sent,
            storeJobs: total.storeJobs + tick.storeJobs,
          }),
          {
            actorQueueDepth: 0,
            actorQueueMs: 0,
            durationMs: 0,
            pullAttempted: 0,
            pushAccepted: 0,
            pushAttempted: 0,
            received: 0,
            resultWrites: 0,
            rowsApplied: 0,
            sent: 0,
            storeJobs: 0,
          },
        );
      const state = {
        accepted: () => accepted,
        cacheServeCount: () => cacheServes,
        resultWriteCount: () => resultWrites,
        summaryKeys: () => summaryKeys,
        armBody: (title: string, body: string, timeoutMs: number) =>
          arm(
            (async () => {
              await waitFor(
                () => rows.some((row) => row.title === title),
                `${title} summary`,
                timeoutMs,
              );
              const summary = rows.find((row) => row.title === title);
              if (!summary) throw new Error(`Missing ${title} summary after subscription update.`);
              watchDocument(summary._id);
              return await waitFor(
                () => documents.get(summary._id)?.body === body,
                `${title} body ${body}`,
                timeoutMs,
              );
            })(),
          ),
        armMissing: (title: string, timeoutMs: number) =>
          arm(
            waitFor(() => !rows.some((row) => row.title === title), `${title} deletion`, timeoutMs),
          ),
        close: async () => {
          stop();
          for (const stopDocument of documentStops.values()) stopDocument();
          documentStops.clear();
          await client.close();
        },
        create: async (title: string, body: string) => {
          const acceptedBefore = accepted;
          const startedAt = absoluteNow();
          const created = (await client.mutation("documents:create", {
            body,
            slug: title,
            title,
            updatedAt: performance.now(),
          })) as { _id: string };
          return {
            acceptedBefore,
            admissionMs: absoluteNow() - startedAt,
            id: created._id,
            startedAt,
          };
        },
        eventCount: () => events.length,
        evidenceSince,
        remove: async (id: string) => await client.mutation("documents:remove", { id }),
        // Cut 7 §4.5: disclosing the selected row via its point query places a non-member row in the
        // partial list's index range, so the list evaluates foreign and is served from the cache.
        select: (id: string) => watchDocument(id),
        rows: () => rows,
        listTransitionCount: () => listTransitions,
        pointTransitionCount: () => pointTransitions,
        transitionCount: () => listTransitions,
        update: async (id: string, title: string, updatedAt: number) => {
          const acceptedBefore = accepted;
          const startedAt = absoluteNow();
          let admission: BrowserRemoteAdmissionTiming | undefined;
          runtimeAdmission = undefined;
          await client.mutation(
            "documents:update",
            { id, title, updatedAt },
            {
              onTiming: (timing: BrowserRemoteAdmissionTiming) => {
                admission = timing;
              },
            },
          );
          if (!admission) throw new Error("Embedded mutation did not report admission timing.");
          if (!runtimeAdmission) {
            throw new Error("Embedded mutation did not report runtime admission timing.");
          }
          return {
            acceptedBefore,
            admission,
            admissionMs: absoluteNow() - startedAt,
            runtime: runtimeAdmission,
          };
        },
        wait: async (id: number) => {
          const waiter = waiters.get(id);
          if (!waiter) throw new Error(`Unknown remote benchmark waiter ${id}.`);
          try {
            return await waiter;
          } finally {
            waiters.delete(id);
          }
        },
        waitForPushAccepted: (after: number) =>
          waitFor(() => accepted > after, "writer settlement", 30_000),
        write: async (id: string, body: { delete: number; index: number; insert: string }) => {
          const acceptedBefore = accepted;
          const startedAt = absoluteNow();
          let admission: BrowserRemoteAdmissionTiming | undefined;
          runtimeAdmission = undefined;
          await client.mutation(
            "documents:writeBody",
            { splices: [body], id },
            {
              onTiming: (timing: BrowserRemoteAdmissionTiming) => {
                admission = timing;
              },
            },
          );
          if (!admission) throw new Error("Embedded mutation did not report admission timing.");
          if (!runtimeAdmission) {
            throw new Error("Embedded mutation did not report runtime admission timing.");
          }
          return {
            acceptedBefore,
            admission,
            admissionMs: absoluteNow() - startedAt,
            runtime: runtimeAdmission,
            startedAt,
          };
        },
      };
      (
        globalThis as typeof globalThis & { __embeddedBrowserRemote?: unknown }
      ).__embeddedBrowserRemote = state;
    },
    { browserUrl, prefix, remoteUrl, storageId },
  );
}

export async function installBrowserScalePage(
  page: import("playwright").Page,
  url: string,
  browserUrl: string,
  options: { prefix: string; queryLimit: number; storageId: string },
): Promise<void> {
  await page.goto(
    `${url}?scale=${encodeURIComponent(`${getTimerTime()}-${Math.random().toString(36).slice(2)}`)}`,
  );
  await page.evaluate(
    async ({ browserUrl, prefix, queryLimit, storageId }) => {
      localStorage.setItem("convex-embedded.storageId", storageId);
      const { ConvexEmbeddedClient } = await import(browserUrl);
      const client = new ConvexEmbeddedClient();
      const waiters = new Set<() => void>();
      let latestTitles: string[] = [];
      let updateCount = 0;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const documentFields = (title: string) => {
        const now = Math.trunc(performance.now());
        return {
          body: JSON.stringify([
            { content: title, props: { level: 1 }, type: "heading" },
            { content: title, type: "paragraph" },
          ]),
          slug: `scale-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
          title,
          updatedAt: now,
        };
      };
      const summarize = (values: number[]): BrowserScaleBenchSample => {
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
      };
      const refreshTitles = () => {
        const rows = (watch.localQueryResult() ?? []) as Array<{ title: string }>;
        latestTitles = rows.filter((row) => row.title.startsWith(prefix)).map((row) => row.title);
      };
      const waitFor = async (condition: () => boolean, label: string, timeoutMs = 15_000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (condition()) return;
          let waiter: (() => void) | undefined;
          await Promise.race([
            delay(25),
            new Promise<void>((resolve) => {
              waiter = () => {
                if (waiter) waiters.delete(waiter);
                resolve();
              };
              waiters.add(waiter);
            }),
          ]);
          if (waiter) waiters.delete(waiter);
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const watch = client.watchQuery("documents:list", { limit: queryLimit });
      const stop = watch.onUpdate(() => {
        updateCount += 1;
        refreshTitles();
        const pending = [...waiters];
        waiters.clear();
        for (const waiter of pending) waiter();
      });
      await waitFor(() => Array.isArray(watch.localQueryResult()), "initial scale watch");
      refreshTitles();

      const run = async (durationMs: number) => {
        const created = (await client.mutation(
          "documents:create",
          documentFields(`${prefix}seed`),
        )) as { _id: string };
        await waitFor(() => latestTitles.includes(`${prefix}seed`), "seed document fanout");

        const writeSamples: number[] = [];
        const deadline = performance.now() + durationMs;
        let fanoutWrites = 0;
        let finalTitle = `${prefix}seed`;
        do {
          fanoutWrites += 1;
          finalTitle = `${prefix}fanout-${fanoutWrites}`;
          const startedAt = performance.now();
          const fields = documentFields(finalTitle);
          await client.mutation("documents:update", {
            id: created._id,
            title: fields.title,
            updatedAt: fields.updatedAt,
          });
          writeSamples.push(performance.now() - startedAt);
        } while (performance.now() < deadline);
        await waitFor(() => latestTitles.includes(finalTitle), "primary final fanout");

        return {
          fanoutWrites,
          finalTitle,
          writeMs: summarize(writeSamples),
        };
      };
      const state: BrowserScalePageState = {
        get latestTitle() {
          return latestTitles.at(-1) ?? null;
        },
        get updateCount() {
          return updateCount;
        },
        run,
        waitForTitle: (title) => waitFor(() => latestTitles.includes(title), title),
      };
      (
        globalThis as typeof globalThis & {
          __embeddedBrowserScale?: BrowserScalePageState;
        }
      ).__embeddedBrowserScale = state;
      (
        globalThis as typeof globalThis & {
          __embeddedBrowserScaleDispose?: () => void;
        }
      ).__embeddedBrowserScaleDispose = () => {
        stop();
        void client.close();
      };
    },
    { ...options, browserUrl },
  );
}

export async function installBrowserBenchPage(
  page: import("playwright").Page,
  url: string,
  browserUrl: string,
  scenario: BrowserLatencyBenchScenario,
  role: "primary" | "secondary",
): Promise<void> {
  const queryLimit = Math.max(100, scenario.rowCount + 128);
  await page.goto(
    `${url}?bench=${encodeURIComponent(`${role}-${getTimerTime()}-${Math.random()}`)}`,
  );
  await page.evaluate(
    async ({ browserUrl, devtoolsUrl, queryLimit, role, scenario, storageId }) => {
      localStorage.setItem("convex-embedded.storageId", storageId);
      const [{ ConvexEmbeddedClient }, devtoolsModule] = await Promise.all([
        import(browserUrl),
        scenario.devtoolsOpen && role === "primary"
          ? import(devtoolsUrl)
          : Promise.resolve(undefined),
      ]);
      const client = new ConvexEmbeddedClient();
      const operations: Array<{
        durationMs?: number;
        kind: string;
        name: string;
        phase: string;
        status: string;
        timing?: {
          commitMs: number;
          notifyMs: number;
          totalMs: number;
        };
      }> = [];
      client.subscribeEvents?.((event: unknown) => {
        const operation = event as {
          durationMs?: number;
          kind?: string;
          name?: string;
          phase?: string;
          status?: string;
          timing?: { commitMs: number; notifyMs: number; totalMs: number };
          type?: string;
        };
        if (operation.type === "operation") {
          operations.push({
            durationMs: operation.durationMs,
            kind: operation.kind ?? "",
            name: operation.name ?? "",
            phase: operation.phase ?? "",
            status: operation.status ?? "",
            timing: operation.timing,
          });
        }
      });
      const formatError = (error: unknown) =>
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      let devtoolsMountError: string | undefined;
      let mounted: { unmount?: () => void } | undefined;
      try {
        if (devtoolsModule && "createEmbeddedDevtoolsSource" in devtoolsModule) {
          const source = devtoolsModule.createEmbeddedDevtoolsSource(client);
          mounted = { unmount: () => source.dispose() };
        }
      } catch (error) {
        devtoolsMountError = formatError(error);
      }
      const watchers: Array<() => void> = [];
      const prefix = `${storageId}:`;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 10_000) => {
        const deadline = performance.now() + timeoutMs;
        let lastError: unknown;
        while (performance.now() < deadline) {
          try {
            await assertion();
            return;
          } catch (error) {
            lastError = error;
            await delay(25);
          }
        }
        throw lastError;
      };
      const documentFields = (title: string) => {
        const now = Math.trunc(performance.now());
        return {
          body: JSON.stringify([
            { content: title, props: { level: 1 }, type: "heading" },
            { content: title, type: "paragraph" },
          ]),
          slug: `document-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
          title,
          updatedAt: now,
        };
      };
      const writeDocument = async (title: string) => {
        await client.mutation("documents:create", documentFields(title));
      };
      const queryRows = async () => {
        const rows = (await client.query("documents:list", { limit: queryLimit })) as Array<{
          _id: string;
          title: string;
        }>;
        return rows.filter((row) => row.title.startsWith(prefix));
      };
      const startWatch = async () => {
        const watch = client.watchQuery("documents:list", { limit: queryLimit });
        const stop = watch.onUpdate(() => undefined);
        watchers.push(stop);
        await waitFor(() => {
          const result = (watch.localQueryResult() ?? []) as Array<{ title: string }>;
          if (!Array.isArray(result)) throw new Error("watch result is not ready");
        });
      };
      if (scenario.watchActive) await startWatch();
      if (role === "secondary" && scenario.tabs === "two") await startWatch();

      const summarize = (values: number[]) => {
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
      const timeMutation = async (
        operation: string,
        run: () => Promise<unknown>,
      ): Promise<BrowserLatencyBenchSample> => {
        const before = operations.length;
        const startedAt = performance.now();
        await run();
        const measuredMs = performance.now() - startedAt;
        const event = operations
          .slice(before)
          .find((entry) => entry.kind === "mutation" && entry.phase === "finish");
        if (!event || event.status !== "success" || !event.timing) {
          throw new Error(`missing mutation timing event for ${operation}`);
        }
        return {
          commitMs: event.timing.commitMs,
          envelopeMs: event.durationMs ?? 0,
          measuredMs,
          notifyMs: event.timing.notifyMs,
          operation,
          outsideRuntimeMs: (event.durationMs ?? 0) - event.timing.totalMs,
          totalRuntimeMs: event.timing.totalMs,
        };
      };
      const run = async (
        activeScenario: BrowserLatencyBenchScenario,
        iterations: number,
        warmups: number,
        latencyP90BudgetMs: number,
      ): Promise<BrowserLatencyBenchResult> => {
        const seedStartedAt = performance.now();
        for (let index = 0; index < activeScenario.rowCount; index += 1) {
          await writeDocument(`${prefix}seed-${index}`);
        }
        const seedMs = performance.now() - seedStartedAt;
        await waitFor(async () => {
          const rows = await queryRows();
          if (rows.length < activeScenario.rowCount) {
            throw new Error(`only observed ${rows.length} seeded rows`);
          }
        });
        let rows = await queryRows();
        for (let index = 0; index < warmups; index += 1) {
          await writeDocument(`${prefix}warmup-${index}`);
        }
        rows = await queryRows();
        const samples: BrowserLatencyBenchSample[] = [];
        for (let index = 0; index < iterations; index += 1) {
          samples.push(
            await timeMutation("documents:create", () => writeDocument(`${prefix}sample-${index}`)),
          );
        }
        rows = await queryRows();
        const summaries = {
          commitMs: summarize(samples.map((sample) => sample.commitMs)),
          envelopeMs: summarize(samples.map((sample) => sample.envelopeMs)),
          measuredMs: summarize(samples.map((sample) => sample.measuredMs)),
          notifyMs: summarize(samples.map((sample) => sample.notifyMs)),
          outsideRuntimeMs: summarize(samples.map((sample) => sample.outsideRuntimeMs)),
          totalRuntimeMs: summarize(samples.map((sample) => sample.totalRuntimeMs)),
        };
        const suspicious: string[] = [];
        if (activeScenario.rowCount > rows.length) {
          suspicious.push(`observedRows=${rows.length} below rowCount=${activeScenario.rowCount}`);
        }
        if (summaries.outsideRuntimeMs.p90 > Math.max(4, summaries.totalRuntimeMs.p90 * 2)) {
          suspicious.push(
            `outsideRuntime p90 ${summaries.outsideRuntimeMs.p90.toFixed(2)}ms dominates runtime p90 ${summaries.totalRuntimeMs.p90.toFixed(2)}ms`,
          );
        }
        if (summaries.measuredMs.p90 > latencyP90BudgetMs) {
          suspicious.push(
            `measured p90 ${summaries.measuredMs.p90.toFixed(2)}ms exceeds browser latency budget ${latencyP90BudgetMs}ms`,
          );
        }
        if (summaries.envelopeMs.p90 > 16) {
          suspicious.push(
            `envelope p90 ${summaries.envelopeMs.p90.toFixed(2)}ms exceeds one frame`,
          );
        }
        if (activeScenario.devtoolsOpen && devtoolsMountError) {
          suspicious.push(`devtools mount failed in isolated page: ${devtoolsMountError}`);
        }
        return {
          ...activeScenario,
          observedRows: rows.length,
          samples,
          seedMs,
          summaries,
          suspicious,
        };
      };
      (
        globalThis as typeof globalThis & {
          __embeddedBrowserBench?: unknown;
        }
      ).__embeddedBrowserBench = { run };
      (
        globalThis as typeof globalThis & {
          __embeddedBrowserBenchDispose?: () => void;
        }
      ).__embeddedBrowserBenchDispose = () => {
        for (const stop of watchers) stop();
        mounted?.unmount?.();
        void client.close();
      };
    },
    {
      browserUrl,
      devtoolsUrl: `/@fs${devtoolsDistPath}?bench=${getTimerTime()}`,
      queryLimit,
      role,
      scenario,
      storageId: `browser-bench-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
    },
  );
}

export function observePageFailures(page: import("playwright").Page, failures: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("Convex functions should not be imported in the browser.")) return;
    if (message.type() === "error" || disallowedBrowserRuntimeError.test(text)) {
      failures.push(`[console:${message.type()}] ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    failures.push(`[pageerror] ${error.message}`);
  });
}

export async function sendPageMessage(
  page: import("playwright").Page,
  body: string,
  expected: Set<string>,
): Promise<void> {
  await page.evaluate(async (body) => {
    const state = (
      globalThis as typeof globalThis & {
        __embeddedPageState: EmbeddedPageState;
      }
    ).__embeddedPageState;
    await state.writeDocument(body);
  }, body);
  expected.add(body);
}

export async function waitForPageBodies(
  pages: import("playwright").Page[],
  expected: Set<string>,
): Promise<void> {
  const bodies = [...expected];
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        (expectedBodies) => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState?: EmbeddedPageState;
            }
          ).__embeddedPageState;
          const latest = state?.updates.at(-1) ?? [];
          const actual = new Set(latest.map((row) => row.text));
          return expectedBodies.every((body) => actual.has(body));
        },
        bodies,
        { timeout: 15_000 },
      ),
    ),
  );
}

export async function assertNoPageFailures(
  pages: import("playwright").Page[],
  failures: string[],
): Promise<void> {
  const stateErrors = (
    await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const state = (
            globalThis as typeof globalThis & {
              __embeddedPageState?: EmbeddedPageState;
            }
          ).__embeddedPageState;
          return state?.errors ?? [];
        }),
      ),
    )
  ).flat();
  const allFailures = [...failures, ...stateErrors];
  if (allFailures.length > 0) {
    throw new Error(`Browser multi-page stress observed failures:\n${allFailures.join("\n")}`);
  }
}
