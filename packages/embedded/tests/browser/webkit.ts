import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { getTimerTime } from "../../src/time";
import { read as readTime } from "../testkit/time";

declare const __CONVEX_EMBEDDED_HOSTED_URL__: string | null;

interface ConnectionState {
  local:
    | { status: "starting" | "ready" | "closed" }
    | { error: { message: string }; status: "failed" };
  replication:
    | { status: "disabled" | "starting" | "offline" | "closed" }
    | { status: "online"; sync: "pending" | "idle" }
    | { error: { message: string }; status: "error" };
}

interface SmokeClient {
  close(): Promise<void>;
  connectionState(): ConnectionState;
  open(): Promise<void>;
  query(
    name: ReturnType<typeof makeFunctionReference>,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  watchQuery(
    name: ReturnType<typeof makeFunctionReference>,
    args: Record<string, unknown>,
  ): { onUpdate(callback: () => void): () => void };
}

const listDocuments = makeFunctionReference<
  "query",
  { limit?: number; prefix?: string },
  unknown[]
>("documents:read");
const createDocument = makeFunctionReference<
  "mutation",
  { body?: string; slug?: string; title?: string; updatedAt?: number },
  { _id: string }
>("documents:write");
const removeDocument = makeFunctionReference<"mutation", { id: string }, null>("documents:del");

const INITIAL_PULL_DEADLINE_MS = 20_000;

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
  while (
    getTimerTime() < deadline &&
    (state.local.status === "starting" ||
      state.replication.status === "starting" ||
      (state.replication.status === "online" && state.replication.sync === "pending"))
  ) {
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
    const { ConvexEmbeddedClient } = await import("@estifanos-sh/convex-embedded/browser");
    const convex = new ConvexEmbeddedClient({ url }) as unknown as SmokeClient;
    clients.add(convex);

    await convex.open().catch(() => undefined);

    let queryError: unknown;
    const rows = await convex.query(listDocuments, {}).catch((error: unknown) => {
      queryError = error;
      return undefined;
    });

    const state = await settle(convex);

    if (state.local.status === "ready") {
      expect(["online", "offline", "error"]).toContain(state.replication.status);
      expect(Array.isArray(rows)).toBe(true);
      return;
    }

    expect(state.local.status).toBe("failed");
    if (state.local.status !== "failed") throw new Error("Expected a failed local state.");
    expect(typeof state.local.error.message).toBe("string");
    expect(state.local.error.message.length).toBeGreaterThan(0);
    expect(state.replication.status).not.toBe("starting");
    expect(queryError).toBeDefined();
  }, 40_000);

  test("initial pull delivers pre-existing documents from the remote", async () => {
    const url = __CONVEX_EMBEDDED_HOSTED_URL__?.trim();
    if (!url) throw new Error("Set VITE_CONVEX_URL before running the WebKit initial-pull gate.");
    const hosted = new ConvexHttpClient(url);
    const marker = `webkit-pull-${getTimerTime()}-${Math.random().toString(36).slice(2)}`;
    const created = await hosted.mutation(createDocument, {
      body: marker,
      slug: marker,
      title: marker,
      updatedAt: readTime(),
    });
    try {
      isolate("webkit-pull");
      const { ConvexEmbeddedClient } = await import("@estifanos-sh/convex-embedded/browser");
      const convex = new ConvexEmbeddedClient({ url }) as unknown as SmokeClient;
      clients.add(convex);

      await convex.open();

      const args = { limit: 1, prefix: marker };
      const stop = convex.watchQuery(listDocuments, args).onUpdate(() => undefined);

      const startedAt = getTimerTime();
      let count = 0;
      while (getTimerTime() - startedAt < INITIAL_PULL_DEADLINE_MS && count < 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const rows = await convex.query(listDocuments, args).catch(() => [] as unknown[]);
        count = (rows as unknown[]).length;
      }
      const elapsed = getTimerTime() - startedAt;
      stop();

      const state = await settle(convex);
      if (state.local.status !== "ready") {
        throw new Error(
          `webkit store did not open (persistent OPFS context required): ${state.local.status === "failed" ? state.local.error.message : state.local.status}`,
        );
      }
      expect(state.replication).toEqual({ status: "online", sync: "idle" });
      expect(count).toBe(1);
      expect(elapsed).toBeLessThan(INITIAL_PULL_DEADLINE_MS);
    } finally {
      await hosted.mutation(removeDocument, { id: created._id });
    }
  }, 45_000);
});
