/**
 * Node implementation of the embedded Convex client.
 *
 * @remarks
 * Use this entrypoint for Node processes that run embedded Convex functions
 * against the Rust/NAPI storage backend.
 *
 * @packageDocumentation
 */
import { createEmbeddedAuthState, EmbeddedClient, type ConvexModules } from "../client";
import type { ConvexEmbeddedSchema } from "../schema";
import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { loadNativeModule, validateNativeModule, type NativeModule } from "./artifact";
import { NativeStore } from "./native";

export type {
  ConvexEmbeddedMutationOptions,
  AuthTokenFetcher,
  ConvexModules,
  EmbeddedDataDelete,
  EmbeddedDataEvent,
  EmbeddedDataWrite,
  EmbeddedConnectionState,
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
   * @throws If the native artifact cannot be loaded or has an incompatible API
   * version. Runtime initialization may also reject if schema setup or database
   * opening fails.
   */
  constructor(options: ConvexEmbeddedClientOptions) {
    const native = validateNativeModule(
      nativeOverrides.get(options) ?? loadNativeModule(),
      "ConvexEmbeddedClient native artifact",
    );
    nativeOverrides.delete(options);
    const authState = createEmbeddedAuthState();
    super({
      schema: options.schema,
      modules: options.modules,
      store: openStore(native, options.path),
      authState,
      remote: options.url === undefined ? undefined : { url: options.url },
    });
  }
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
