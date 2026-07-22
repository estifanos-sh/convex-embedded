import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";

declare const __CONVEX_EMBEDDED_CONVEX_URL__: string;

export interface BrowserDebugEvent {
  detail?: unknown;
  phase: string;
  source: "browser" | "worker";
}

declare global {
  var __convexEmbeddedDemoClient: ConvexEmbeddedClient | undefined;
  var __CONVEX_EMBEDDED_DEBUG_EVENTS__: BrowserDebugEvent[] | undefined;
  var __CONVEX_EMBEDDED_DEBUG_LOG__:
    | ((event: Omit<BrowserDebugEvent, "source"> & { source: "worker" }) => void)
    | undefined;
}

// The demo is unreleased: protocol changes select a fresh store instead of replaying stale work.
const DEMO_STORAGE_ID = "document-demo-p21";
const remoteUrl = __CONVEX_EMBEDDED_CONVEX_URL__.trim();
if (!remoteUrl) {
  throw new Error(
    "Missing Convex deployment URL. Set VITE_CONVEX_URL in the repository root .env.local.",
  );
}
const debugEnabled = new URLSearchParams(globalThis.location?.search ?? "").has("debug");

if (debugEnabled) installDebugCapture();

try {
  if (globalThis.localStorage?.getItem("convex-embedded.storageId") !== DEMO_STORAGE_ID) {
    globalThis.localStorage?.setItem("convex-embedded.storageId", DEMO_STORAGE_ID);
  }
} catch {
  // Demo storage identity is a development convenience. If localStorage is unavailable,
  // the browser package falls back to its normal default.
}

export const client =
  globalThis.__convexEmbeddedDemoClient ??
  (globalThis.__convexEmbeddedDemoClient = new ConvexEmbeddedClient({ url: remoteUrl }));

export function subscribeBrowserDebug(listener: (event: BrowserDebugEvent) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<BrowserDebugEvent>).detail);
  globalThis.addEventListener("convex-embedded-debug", handler);
  return () => globalThis.removeEventListener("convex-embedded-debug", handler);
}

function installDebugCapture(): void {
  const storageKey = "convex-embedded.debug.events";
  globalThis.__CONVEX_EMBEDDED_DEBUG_EVENTS__ ??= readStoredDebugEvents(storageKey);
  const record = (event: BrowserDebugEvent) => {
    const events = (globalThis.__CONVEX_EMBEDDED_DEBUG_EVENTS__ ??= []);
    events.push(event);
    if (events.length > 100) events.splice(0, events.length - 100);
    try {
      globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(events));
    } catch {}
    globalThis.dispatchEvent(new CustomEvent("convex-embedded-debug", { detail: event }));
  };
  globalThis.__CONVEX_EMBEDDED_DEBUG_LOG__ = (event) => record(event);
  const lifecycle = (phase: string, detail?: unknown) =>
    record({ detail, phase: `browser:${phase}`, source: "browser" });
  globalThis.addEventListener("online", () => lifecycle("online"));
  globalThis.addEventListener("offline", () => lifecycle("offline"));
  globalThis.addEventListener("visibilitychange", () =>
    lifecycle("visibility", { state: document.visibilityState }),
  );
  globalThis.addEventListener("pagehide", (event) =>
    lifecycle("pagehide", { persisted: event.persisted }),
  );
  globalThis.addEventListener("pageshow", (event) =>
    lifecycle("pageshow", { persisted: event.persisted }),
  );
  lifecycle("capture", {
    online: navigator.onLine,
    visibility: document.visibilityState,
  });
}

function readStoredDebugEvents(storageKey: string): BrowserDebugEvent[] {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) ?? "[]");
    return Array.isArray(value) ? (value as BrowserDebugEvent[]).slice(-100) : [];
  } catch {
    return [];
  }
}
