import { ConvexEmbeddedClient } from "@convex-dev/embedded/browser";
import { getConvexUrl } from "@convex-dev/static-hosting";

declare const __CONVEX_EMBEDDED_CONVEX_URL__: string | null;

// The demo is unreleased: protocol changes select a fresh store instead of replaying stale work.
const DEMO_STORAGE_ID = "document-demo-p17";
const configuredConvexUrl = __CONVEX_EMBEDDED_CONVEX_URL__?.trim() ?? "";
const remoteUrl = configuredConvexUrl || hostedRemoteUrl();

function hostedRemoteUrl(): string {
  try {
    return getConvexUrl();
  } catch {
    return "";
  }
}

try {
  if (globalThis.localStorage?.getItem("convex-embedded.storageId") !== DEMO_STORAGE_ID) {
    globalThis.localStorage?.setItem("convex-embedded.storageId", DEMO_STORAGE_ID);
  }
} catch {
  // Demo storage identity is a development convenience. If localStorage is unavailable,
  // the browser package falls back to its normal default.
}

export const client = new ConvexEmbeddedClient(remoteUrl ? { url: remoteUrl } : undefined);
