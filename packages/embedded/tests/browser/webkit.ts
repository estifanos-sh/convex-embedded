import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test } from "vite-plus/test";

import type { EmbeddedEvent } from "../../src/events";
import { getTimerTime } from "../../src/time";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;

interface ConnectionState {
  local: "starting" | "ready" | "failed" | "closed";
  localError?: string;
  remote: string;
  remoteError?: string;
}

interface SmokeClient {
  close(): Promise<void>;
  connectionState(): ConnectionState;
  query(name: ReturnType<typeof makeFunctionReference>, args: Record<string, unknown>): Promise<unknown>;
  watchQuery(
    name: ReturnType<typeof makeFunctionReference>,
    args: Record<string, unknown>,
  ): { onUpdate(callback: () => void): () => void };
  subscribeInternalEvents?(listener: (event: EmbeddedEvent) => void): () => void;
}

const listDocuments = makeFunctionReference<"query", { limit?: number }, unknown[]>(
  "documents:list",
);

const BOOTSTRAP_DELIVERY_DEADLINE_MS = 20_000;

const clients = new Set<SmokeClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
});

function isolate(label: string): void {
  localStorage.setItem(
    "convex-embedded.storageId",
    `${label}-${getTimerTime()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function settle(client: SmokeClient): Promise<ConnectionState> {
  const deadline = getTimerTime() + 20_000;
  let state = client.connectionState();
  while (getTimerTime() < deadline && (state.local === "starting" || state.remote === "starting")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = client.connectionState();
  }
  return state;
}

describe("webkit runtime smoke", () => {
  test("never boots into a silent empty store: failures are surfaced", async () => {
    const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
    if (!url) throw new Error("Set VITE_CONVEX_URL before running the webkit smoke.");
    isolate("webkit-smoke");
    const { ConvexEmbeddedClient } = await import("@convex-dev/embedded/browser");
    const convex = new ConvexEmbeddedClient({ url }) as unknown as SmokeClient;
    clients.add(convex);

    const runtimeFailures: unknown[] = [];
    convex.subscribeInternalEvents?.((event) => {
      if (
        event.type === "runtime" &&
        (event as { degradation?: string }).degradation === "failed"
      ) {
        runtimeFailures.push(event);
      }
    });

    let queryError: unknown;
    const rows = await convex.query(listDocuments, {}).catch((error: unknown) => {
      queryError = error;
      return undefined;
    });

    const state = await settle(convex);

    if (state.local === "ready") {
      expect(state.remote === "ready" || state.remote === "error").toBe(true);
      expect(Array.isArray(rows)).toBe(true);
      return;
    }

    expect(state.local).toBe("failed");
    expect(typeof state.localError).toBe("string");
    expect((state.localError ?? "").length).toBeGreaterThan(0);
    expect(state.remote).not.toBe("starting");
    expect(queryError).toBeDefined();
    expect(runtimeFailures.length).toBeGreaterThan(0);
  }, 40_000);

  test(
    "bootstrap pull delivers pre-existing documents from the remote",
    async () => {
      const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
      if (!url) throw new Error("Set VITE_CONVEX_URL before running the webkit bootstrap gate.");
      isolate("webkit-bootstrap");
      const { ConvexEmbeddedClient } = await import("@convex-dev/embedded/browser");
      const convex = new ConvexEmbeddedClient({ url }) as unknown as SmokeClient;
      clients.add(convex);

      let delivered = 0;
      convex.subscribeInternalEvents?.((event) => {
        if (event.type !== "remote") return;
        const tick = (event as { tick?: { received?: number; rowsApplied?: number } }).tick;
        if (tick) delivered += (tick.received ?? 0) + (tick.rowsApplied ?? 0);
      });

      const stop = convex.watchQuery(listDocuments, { limit: 1000 }).onUpdate(() => undefined);

      const startedAt = getTimerTime();
      let count = 0;
      while (getTimerTime() - startedAt < BOOTSTRAP_DELIVERY_DEADLINE_MS && count < 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const rows = await convex
          .query(listDocuments, { limit: 1000 })
          .catch(() => [] as unknown[]);
        count = (rows as unknown[]).length;
      }
      const elapsed = getTimerTime() - startedAt;
      stop();

      const state = convex.connectionState();
      if (state.local !== "ready") {
        throw new Error(
          `webkit store did not open (persistent OPFS context required): ${state.localError}`,
        );
      }
      expect(count).toBeGreaterThanOrEqual(1);
      expect(delivered).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(BOOTSTRAP_DELIVERY_DEADLINE_MS);
    },
    45_000,
  );
});
