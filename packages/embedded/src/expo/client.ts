/**
 * Expo implementation of the embedded Convex client.
 *
 * @packageDocumentation
 */
import { embeddedManifest, embeddedSchema, modules } from "virtual:convex-embedded";
import { embeddedIdentity } from "virtual:convex-embedded/identity";

import { createEmbeddedAuthState, EmbeddedClient } from "../client";
import { openExpoStore } from "./store";

export type {
  AuthTokenFetcher,
  ConvexEmbeddedMutationOptions,
  EmbeddedConnectionState,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
  EmbeddedEvent,
  EmbeddedEventListener,
  EmbeddedOperationEvent,
  EmbeddedOperationKind,
  EmbeddedOperationPhase,
  EmbeddedRemoteEvent,
  EmbeddedRemoteStatus,
  EmbeddedSchedulerEvent,
  EmbeddedSpanEvent,
  EmbeddedSpanPhase,
  EmbeddedStorageEvent,
  Watch,
} from "../client";
export type { ConvexEmbeddedSchema } from "../schema";

const DEFAULT_PATH = "convex-embedded.sqlite3";

/** Configuration for the Expo native embedded client. @public */
export interface ConvexEmbeddedClientOptions {
  /**
   * Database path or app-data-relative filename.
   *
   * @defaultValue `"convex-embedded.sqlite3"`
   */
  path?: string;
  /** Convex deployment URL. Omit for a local-only client. */
  url?: string;
  /** Receive timeout for one native remote protocol tick. */
  receiveTimeoutMs?: number;
  /** Timeout for native remote query, mutation, and action work. */
  operationTimeoutMs?: number;
}

/**
 * Embedded Convex client backed by package-owned iOS and Android Rust storage.
 *
 * @remarks
 * This entry requires an Expo development or release build. Expo Go cannot
 * load custom native modules. Install `expo-crypto` with Expo's version-aware
 * installer, then configure Metro with
 * `@convex-dev/embedded/metro` so the generated placement contract and local
 * Convex modules are included in the application bundle. Pass `url` to enable
 * native remote replication over the same Rust driver used by Node.
 *
 * @example
 * ```ts
 * // Run once: npx expo install expo-crypto
 * import { ConvexEmbeddedClient } from "@convex-dev/embedded/expo";
 *
 * const client = new ConvexEmbeddedClient();
 * ```
 *
 * @public
 */
export class ConvexEmbeddedClient extends EmbeddedClient {
  /** Creates an Expo client and opens its native store during initialization. */
  constructor(options: ConvexEmbeddedClientOptions = {}) {
    const path = options.path ?? DEFAULT_PATH;
    if (path.length === 0 || path.includes("\0")) {
      throw new Error("Convex Embedded Expo database path must be a non-empty string.");
    }
    super({
      authState: createEmbeddedAuthState(),
      compatiblePriorRuntimes: embeddedIdentity.compatiblePriorRuntimes,
      manifest: embeddedManifest,
      moduleGraphHash: embeddedIdentity.moduleGraphHash,
      modules,
      remote:
        options.url === undefined
          ? undefined
          : {
              url: options.url,
              operationTimeoutMs: options.operationTimeoutMs,
              receiveTimeoutMs: options.receiveTimeoutMs,
            },
      storeSchema: embeddedSchema.runtimeStoreSchema,
      store: openExpoStore(path),
    });
  }
}
