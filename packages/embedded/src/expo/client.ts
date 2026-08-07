/**
 * Expo implementation of the embedded Convex client.
 *
 * @packageDocumentation
 */
import { embeddedManifest, embeddedSchema, localModules, modules } from "virtual:convex-embedded";
import { embeddedIdentity } from "virtual:convex-embedded/identity";

import { createEmbeddedAuthState, EmbeddedClient, validateLoadedSetupIdentity } from "../client";
import { localCompatibilitySchema, localGraphHash, localReferenceName } from "../local/internal";
import type { ConvexEmbeddedSchema } from "../schema";
import { openExpoStore } from "./store";

export type {
  AuthTokenFetcher,
  EmbeddedConnectionError,
  EmbeddedConnectionErrorCode,
  EmbeddedConnectionState,
  EmbeddedLocalConnectionState,
  EmbeddedMutationSettlement,
  EmbeddedReplicationConnectionState,
  EmbeddedRetainedRevision,
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
 * `@estifanos-sh/convex-embedded/metro` so the generated placement contract and local
 * Convex modules are included in the application bundle. Pass `url` to enable
 * native remote replication over the same Rust driver used by Node.
 *
 * @example
 * ```ts
 * // Run once: npx expo install expo-crypto
 * import { ConvexEmbeddedClient } from "@estifanos-sh/convex-embedded/expo";
 *
 * const client = new ConvexEmbeddedClient();
 * await client.open();
 * ```
 *
 * @public
 */
export class ConvexEmbeddedClient extends EmbeddedClient {
  /** Creates an inert Expo client; {@link EmbeddedClient.open} acquires the native store. */
  constructor(options: ConvexEmbeddedClientOptions = {}) {
    const path = options.path ?? DEFAULT_PATH;
    if (path.length === 0 || path.includes("\0")) {
      throw new Error("Convex Embedded Expo database path must be a non-empty string.");
    }
    super({
      authState: createEmbeddedAuthState(),
      hosted:
        options.url === undefined
          ? undefined
          : {
              url: options.url,
              operationTimeoutMs: options.operationTimeoutMs,
              receiveTimeoutMs: options.receiveTimeoutMs,
            },
      start: async (setup) => {
        const local = await localModuleMetadata(localModules);
        validateLoadedSetupIdentity(setup, local.setupIdentities, embeddedIdentity.moduleGraphHash);
        return {
          localModules,
          compatibilitySchemas: local.compatibilitySchemas,
          localSetupIdentities: local.setupIdentities,
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
        };
      },
    });
  }
}

async function localModuleMetadata(moduleLoaders: Record<string, () => Promise<unknown>>): Promise<{
  compatibilitySchemas: ConvexEmbeddedSchema[];
  setupIdentities: Record<string, string>;
}> {
  const compatibilitySchemas = new Set<ConvexEmbeddedSchema>();
  const setupIdentities: Record<string, string> = {};
  for (const load of Object.values(moduleLoaders)) {
    const module = await load();
    if (typeof module !== "object" || module === null) continue;
    for (const value of Object.values(module as Record<string, unknown>)) {
      const schema = localCompatibilitySchema(value);
      if (schema !== undefined) compatibilitySchemas.add(schema);
      const reference = localReferenceName(value);
      const graphHash = localGraphHash(value);
      if (reference !== undefined && graphHash !== undefined) {
        setupIdentities[reference] = graphHash;
      }
    }
  }
  return { compatibilitySchemas: [...compatibilitySchemas], setupIdentities };
}
