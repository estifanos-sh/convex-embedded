/**
 * Node implementation of the embedded Convex client.
 *
 * @remarks
 * Use this entrypoint for Node processes that run embedded Convex functions
 * against the Rust/NAPI storage backend.
 *
 * @packageDocumentation
 */
import {
  createEmbeddedAuthState,
  EmbeddedClient,
  type ConvexLocalModules,
  type ConvexModules,
  validateLoadedSetupIdentity,
} from "../client";
import type { ConvexEmbeddedSchema } from "../schema";
import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { localCompatibilitySchema, localGraphHash, localReferenceName } from "../local/internal";
import { loadNativeModule, validateNativeModule, type NativeModule } from "./artifact";
import { NativeStore } from "./native";

export type {
  AuthTokenFetcher,
  ConvexLocalModules,
  ConvexModules,
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

/**
 * Configuration for {@link ConvexEmbeddedClient}.
 *
 * @example
 * ```ts
 * const options = {
 *   schema,
 *   modules,
 *   path: ".convex-embedded/db.sqlite3",
 * } satisfies ConvexEmbeddedClientOptions;
 * ```
 *
 * @public
 */
export interface ConvexEmbeddedClientOptions {
  /**
   * Convex schema definition used to configure embedded storage indexes.
   *
   * @remarks
   * Pass the default export from the app's `convex/schema` module.
   */
  schema: ConvexEmbeddedSchema;

  /**
   * Convex function modules executed by the local JavaScript runtime.
   *
   * @remarks
   * Keys are Convex module paths and values are module exports or lazy module
   * loaders.
   */
  modules: ConvexModules;

  /**
   * Device-only function modules, imported when the client starts.
   *
   * @remarks
   * Keys are module paths relative to the app's local function directory, without an extension;
   * values are lazy module loaders. Exports that are not registrations are left alone.
   *
   * @example
   * ```ts
   * const local = { "sync/drafts": () => import("./local/sync/drafts.js") };
   * ```
   */
  local?: Record<string, () => Promise<unknown>>;

  /**
   * Filesystem path for the embedded database.
   *
   * @remarks
   * Parent directories must be writable by the Node process.
   */
  path: string;

  /** Convex deployment URL. Omit it for a local-only runtime. */
  url?: string;
}

const nativeOverrides = new WeakMap<ConvexEmbeddedClientOptions, NativeModule>();

/**
 * Node embedded client backed by the Rust/NAPI storage artifact.
 *
 * @remarks
 * Convex functions execute in JavaScript in the current process; storage is
 * provided by the Rust/NAPI backend. The native artifact is loaded from the
 * package, or from `CONVEX_EMBEDDED_NATIVE` when set.
 *
 * @public
 */
export class ConvexEmbeddedClient extends EmbeddedClient {
  /**
   * Creates a Node embedded client backed by the Rust/NAPI storage artifact.
   *
   * @param options - Schema, function modules, and database path for the client.
   * Native artifact loading, schema setup, and database opening are deferred to
   * {@link EmbeddedClient.open}, which rejects if any of them fails.
   */
  constructor(options: ConvexEmbeddedClientOptions) {
    const authState = createEmbeddedAuthState();
    super({
      authState,
      hosted: options.url === undefined ? undefined : { url: options.url },
      start: async (setup) => {
        const local = options.local ? await namespaceLocalModules(options.local) : undefined;
        validateLoadedSetupIdentity(setup, local?.setupIdentities);
        const native = validateNativeModule(
          nativeOverrides.get(options) ?? loadNativeModule(),
          "ConvexEmbeddedClient native artifact",
        );
        nativeOverrides.delete(options);
        return {
          schema: options.schema,
          modules: options.modules,
          localModules: local?.modules,
          compatibilitySchemas: local?.compatibilitySchemas,
          localSetupIdentities: local?.setupIdentities,
          store: openStore(native, options.path),
          authState,
          remote: options.url === undefined ? undefined : { url: options.url },
        };
      },
    });
  }
}

async function namespaceLocalModules(
  local: NonNullable<ConvexEmbeddedClientOptions["local"]>,
): Promise<{
  modules: ConvexLocalModules;
  compatibilitySchemas: ConvexEmbeddedSchema[];
  setupIdentities: Record<string, string>;
}> {
  const compatibilitySchemas = new Set<ConvexEmbeddedSchema>();
  const setupIdentities: Record<string, string> = {};
  const entries = await Promise.all(
    Object.entries(local).map(async ([modulePath, load]) => {
      const loaded = await load();
      // Setup identity must originate in a generated local registry. Node deliberately does not
      // accept a caller-provided graph token or derive one from executable text: an unstamped
      // registration remains usable as a normal local function but fails closed for `open(setup)`.
      if (typeof loaded === "object" && loaded !== null) {
        for (const value of Object.values(loaded as Record<string, unknown>)) {
          const schema = localCompatibilitySchema(value);
          if (schema !== undefined) compatibilitySchemas.add(schema);
          const reference = localReferenceName(value);
          const graphHash = localGraphHash(value);
          if (reference !== undefined && graphHash !== undefined) {
            setupIdentities[reference] = graphHash;
          }
        }
      }
      return [`local/${modulePath}`, async () => loaded] as const;
    }),
  );
  return {
    modules: Object.fromEntries(entries),
    compatibilitySchemas: [...compatibilitySchemas],
    setupIdentities,
  };
}

function openStore(native: NativeModule, path: string): Promise<NativeStore> {
  return NativeStore.openWith(native.Store, path, {
    defaultIdentityKey: EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
    selectorKey: path,
  });
}

/**
 * Creates a client with an injected native module.
 *
 * @internal
 */
export function createConvexEmbeddedClientForTest(
  options: ConvexEmbeddedClientOptions,
  native: NativeModule,
): ConvexEmbeddedClient {
  nativeOverrides.set(options, native);
  return new ConvexEmbeddedClient(options);
}
