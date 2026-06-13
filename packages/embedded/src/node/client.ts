/**
 * Node implementation of the embedded Convex client.
 *
 * @remarks
 * This module is re-exported by `@convex-dev/embedded/node`. Prefer that
 * package entrypoint in application code.
 *
 * @packageDocumentation
 */
import { EmbeddedClient, type ConvexModules } from "../client";
import type { ConvexEmbeddedSchema } from "../schema";
import { loadNativeModule, type NativeModule } from "./artifact";
import { NativeStore } from "./native";

export type {
  ConvexEmbeddedMutationOptions,
  ConvexModules,
  MutationOptions,
  OptimisticLocalStore,
  OptimisticUpdate,
  Watch,
  WatchQueryOptions,
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
}

const nativeOverrides = new WeakMap<ConvexEmbeddedClientOptions, NativeModule>();

/**
 * Embedded Convex client for Node.
 *
 * @remarks
 * Convex functions execute in JavaScript in the current process; storage is
 * provided by the Rust/NAPI backend. The native artifact is loaded from the
 * package, or from `CONVEX_EMBEDDED_NATIVE` when set.
 *
 * @example
 * ```ts
 * import { ConvexEmbeddedClient } from "@convex-dev/embedded/node";
 * import { api } from "../convex/_generated/api";
 * import schema from "../convex/schema";
 *
 * const client = new ConvexEmbeddedClient({ schema, modules, path: "local.db" });
 * await client.mutation(api.todos.create, { text: "Write docs" });
 * ```
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
    const native = nativeOverrides.get(options) ?? loadNativeModule();
    nativeOverrides.delete(options);
    super({
      schema: options.schema,
      modules: options.modules,
      store: NativeStore.openWith(native.Store, options.path),
    });
  }
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
