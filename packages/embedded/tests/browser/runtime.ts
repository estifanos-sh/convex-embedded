import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { commands } from "vitest/browser";

const send = makeFunctionReference<"mutation", { body: string; channel: string }, string>(
  "messages:send",
);
const list = makeFunctionReference<
  "query",
  { channel: string },
  Array<{ body: string; channel: string }>
>("messages:list");

interface RuntimeClient {
  close(): Promise<void>;
}

interface DebugEvent {
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

describe("browser runtime", () => {
  test("starts the packaged dedicated runtime worker", async () => {
    installDebugLogHook();
    await mark("capability start");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const channel = `capability-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const convex = track(new ConvexEmbeddedClient());

    const result = await settle(withTimeout(convex.query(list, { channel }), "capability query"));
    if (!result.ok) throw result.error;
    expect(result.value).toEqual([]);
    expect(debugEvents.some((event) => event.phase === "worker:bundle:import:done")).toBe(true);
    expect(debugEvents.some((event) => event.phase === "worker:opfs:register:done")).toBe(true);
  });

  test("runs packaged browser client through worker, WASM, OPFS, and virtual Convex modules", async () => {
    installDebugLogHook();
    await mark("start");
    const { ConvexEmbeddedClient } = await withTimeout(
      import("@convex-dev/embedded/browser"),
      "browser package import",
    );
    const channel = `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mark("construct clients", { channel });
    const convexA = track(new ConvexEmbeddedClient());
    const convexB = track(new ConvexEmbeddedClient());

    await mark("first mutation");
    const firstMutation = await settle(
      withTimeout(convexA.mutation(send, { body: "hi", channel }), "first mutation"),
    );
    if (!firstMutation.ok) throw firstMutation.error;
    await mark("first query from second client");
    await expect(withTimeout(convexB.query(list, { channel }), "first query")).resolves.toEqual([
      expect.objectContaining({ body: "hi", channel }),
    ]);

    await mark("watch start from second client");
    const watch = convexB.watchQuery(list, { channel });
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
    await waitFor(() => expect(watch.localQueryResult()).toHaveLength(1));

    await mark("second mutation from first client");
    const changed = nextUpdate();
    await withTimeout(convexA.mutation(send, { body: "again", channel }), "second mutation");
    await withTimeout(changed, "watch update");
    await waitFor(() =>
      expect(watch.localQueryResult()?.map((message) => message.body)).toEqual(["hi", "again"]),
    );
    expect(updateCount).toBeGreaterThanOrEqual(2);

    await mark("close first client");
    await withTimeout(convexA.close(), "close first client");
    clients.delete(convexA);

    await mark("third mutation from second client");
    await withTimeout(convexB.mutation(send, { body: "after-close", channel }), "third mutation");
    await waitFor(() =>
      expect(watch.localQueryResult()?.map((message) => message.body)).toEqual([
        "hi",
        "again",
        "after-close",
      ]),
    );

    await mark("close second client");
    stop();
    await withTimeout(convexB.close(), "close second client");
    clients.delete(convexB);

    await mark("reopen");
    const reopened = track(new ConvexEmbeddedClient());
    await expect(withTimeout(reopened.query(list, { channel }), "reopen query")).resolves.toEqual([
      expect.objectContaining({ body: "hi", channel }),
      expect.objectContaining({ body: "again", channel }),
      expect.objectContaining({ body: "after-close", channel }),
    ]);
  }, 45_000);

  test("coordinates two browser pages through one embedded runtime owner", async () => {
    const channel = `multipage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(browserCommands().embeddedMultiPage(channel), "multi-page embedded runtime");
  }, 45_000);

  test("delivers an existing watch result to late watch-only browser pages", async () => {
    const channel = `watch-only-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(
      browserCommands().embeddedWatchOnlyLateSubscriber(channel),
      "watch-only late subscriber",
    );
  }, 45_000);

  test("survives multi-page browser churn without losing observed data", async () => {
    const channel = `stress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await withTimeout(
      browserCommands().embeddedMultiPageStress(channel),
      "multi-page embedded runtime stress",
    );
  }, 60_000);
});

function track<T extends RuntimeClient>(client: T): T {
  clients.add(client);
  return client;
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
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

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`browser runtime timed out during ${label}`)),
          30_000,
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

function installDebugLogHook(): void {
  debugGlobal().__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => {
    debugEvents.push(event);
    void mark(event.phase, { detail: event.detail, source: event.source });
  };
}

async function mark(phase: string, detail?: unknown): Promise<void> {
  const entry = {
    detail,
    now: Date.now(),
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
  embeddedMultiPage(channel: string): Promise<void>;
  embeddedMultiPageStress(channel: string): Promise<void>;
  embeddedWatchOnlyLateSubscriber(channel: string): Promise<void>;
} {
  return commands as unknown as {
    embeddedMultiPage(channel: string): Promise<void>;
    embeddedMultiPageStress(channel: string): Promise<void>;
    embeddedWatchOnlyLateSubscriber(channel: string): Promise<void>;
  };
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
