/**
 * Shared types and the platform-neutral embedded Convex client base.
 *
 * @remarks
 * Most applications import {@link ConvexEmbeddedClient} from
 * `@convex-dev/embedded/browser` or `@convex-dev/embedded/node`. The shared
 * types in this module describe query watches, optimistic mutation options,
 * and Convex module maps used by those platform clients.
 *
 * @packageDocumentation
 */
import { convexToJson, type Value } from "convex/values";
import { getFunctionName } from "convex/server";
import type {
  ArgsAndOptions,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";
import type { OptimisticLocalStore, OptimisticUpdate, QueryJournal } from "convex/browser";
import { equals, normalizeObject } from "./runtime/codec";
import { createRunner, type ModuleMap, type Runner, type StopOnUpdate } from "./runtime/runner";
import { toStoreSchema, type ConvexEmbeddedSchema } from "./schema";
import type { StorageBackend } from "./storage/types";
import { randomId } from "./util";

export type { ConvexEmbeddedSchema } from "./schema";
export type { OptimisticLocalStore, OptimisticUpdate } from "convex/browser";

/**
 * Options for a watched query.
 *
 * @remarks
 * Watch options mirror the shape of Convex browser watch options where the
 * embedded runtime can support the same local behavior.
 *
 * @example
 * ```ts
 * const watch = client.watchQuery(api.todos.list, {});
 * ```
 *
 * @public
 */
export interface WatchQueryOptions {
  /**
   * A Convex query journal from a previous execution.
   *
   * @todo Use this for journal-aware reactivity once local query invalidation supports replaying
   * query dependencies more precisely.
   */
  journal?: QueryJournal;
}

/**
 * Options accepted by {@link EmbeddedClient.mutation}.
 *
 * @remarks
 * This intentionally uses Convex's `OptimisticUpdate` type so existing
 * optimistic update code keeps the same call shape when running against the
 * embedded client.
 *
 * @typeParam Args - Convex mutation argument object accepted by the mutation.
 *
 * @example
 * ```ts
 * await client.mutation(api.todos.create, { text: "Ship it" }, {
 *   optimisticUpdate: (store, args) => {
 *     store.setQuery(api.todos.list, {}, [{ text: args.text }]);
 *   },
 * });
 * ```
 *
 * @public
 */
export interface MutationOptions<Args extends Record<string, Value>> {
  /**
   * Applies temporary local query edits while the mutation is pending.
   *
   * @todo Replace the current snapshot rollback implementation with Convex-style ordered replay of
   * all pending optimistic updates over base query results.
   */
  optimisticUpdate?: OptimisticUpdate<Args> | undefined;
}

/**
 * Embedded-client alias for Convex-style mutation options.
 *
 * @typeParam Args - Convex mutation argument object accepted by the mutation.
 *
 * @public
 */
export type ConvexEmbeddedMutationOptions<Args extends Record<string, Value>> =
  MutationOptions<Args>;

/**
 * A local watched query handle.
 *
 * @remarks
 * Watches are lazy. Calling {@link Watch.onUpdate} starts the underlying local
 * subscription, and the returned cleanup function stops that subscription when
 * the last listener is removed.
 *
 * @typeParam T - Return type of the watched Convex query.
 *
 * @example
 * ```ts
 * const watch = client.watchQuery(api.todos.list, {});
 * const unsubscribe = watch.onUpdate(() => {
 *   console.log(watch.localQueryResult());
 * });
 * ```
 *
 * @public
 */
export interface Watch<T> {
  /**
   * Registers a callback that runs after the local query result changes.
   *
   * @param callback - Function invoked after the local query result changes.
   * @returns A function that unsubscribes this callback.
   */
  onUpdate(callback: () => void): () => void;

  /**
   * Returns the latest local query result, or `undefined` while no result has been produced.
   *
   * @returns The most recent query result, or `undefined` before the first result.
   * @throws The latest query error when the watched query is currently in an error state.
   */
  localQueryResult(): T | undefined;

  /**
   * Returns the latest local query log lines when available.
   *
   * @returns Query log lines captured during the latest local execution.
   */
  localQueryLogs(): string[] | undefined;

  /**
   * Returns the latest query journal when available.
   *
   * @returns The latest Convex query journal for this watched query.
   */
  journal(): QueryJournal | undefined;
}

/**
 * Convex function modules keyed by module path.
 *
 * @remarks
 * The Node client receives this map directly. The browser client usually gets
 * it from the bundler plugin through the generated virtual module.
 *
 * @public
 */
export type ConvexModules = ModuleMap;

/**
 * Platform-neutral embedded client configuration.
 *
 * @remarks
 * Platform clients adapt this shape to browser WASM/OPFS storage or Node
 * native storage before constructing the shared client.
 *
 * @internal
 */
export interface EmbeddedClientOptions {
  /** Convex schema used to configure embedded storage tables and indexes. */
  schema: ConvexEmbeddedSchema;
  /** Convex function modules executed by the local runtime. */
  modules: ConvexModules;
  /** Storage backend, or a promise for one, owned by the client. */
  store: StorageBackend | Promise<StorageBackend>;
}

/**
 * Platform-neutral embedded client configuration for a prebuilt runtime.
 *
 * @remarks
 * Browser clients use this form when a worker-backed runner owns the runtime
 * and storage lifecycle.
 *
 * @internal
 */
export interface EmbeddedRuntimeClientOptions {
  /** Optional cleanup hook invoked by {@link EmbeddedClient.close}. */
  close?: () => Promise<void> | void;
  /** Prebuilt runner used to execute Convex functions. */
  runner: Runner | Promise<Runner>;
}

interface ClientState {
  close: () => Promise<void> | void;
  runner: Runner;
}

/**
 * State per watched query. `baseValue`/`baseError` come from the runtime; `value`/`error` are
 * derived by {@link EmbeddedClient.recompute} — the pure fold of every pending optimistic update
 * over base state. Nothing is ever snapshot or restored: derived state is recomputed from base.
 */
interface QueryState<T = unknown> {
  args: Record<string, unknown>;
  baseError: unknown;
  baseValue: T | undefined;
  callbacks: Set<() => void>;
  error: unknown;
  key: string;
  journal: QueryJournal | undefined;
  logs: string[] | undefined;
  name: string;
  ref: FunctionReference<"query">;
  stop: StopOnUpdate | undefined;
  value: T | undefined;
}

type OptimisticMutationId = number;

/**
 * A pending optimistic mutation: one element of the fold. `touched` records the keys its update
 * wrote during the most recent recompute, which drives base refreshes on completion and the
 * indeterminate drop-on-fresh-base trigger.
 *
 * @internal
 */
interface PendingOptimisticMutation<Args extends Record<string, Value> = Record<string, Value>> {
  args: Args;
  id: OptimisticMutationId;
  indeterminate: boolean;
  optimisticUpdate: OptimisticUpdate<Args>;
  timer: ReturnType<typeof setTimeout> | undefined;
  touched: Set<string>;
}

/** How long an indeterminate mutation's optimistic state survives without a fresh base value. */
const INDETERMINATE_OPTIMISTIC_TIMEOUT_MS = 30_000;

/**
 * Platform-neutral embedded Convex client.
 *
 * @remarks
 * Convex functions execute in JavaScript; storage is supplied by a platform
 * backend. Applications should use the platform-specific
 * `ConvexEmbeddedClient` exports instead of constructing this base class.
 *
 * @internal
 */
export class EmbeddedClient {
  private closed = false;
  private readonly clientId = randomId("client");
  private closePromise: Promise<void> | undefined;
  private nextMutationId = 1;
  private nextOptimisticMutationId: OptimisticMutationId = 1;
  private readonly pendingOptimisticMutations = new Map<
    OptimisticMutationId,
    PendingOptimisticMutation
  >();
  private readonly queries = new Map<string, QueryState>();
  private readonly state: Promise<ClientState>;

  constructor(options: EmbeddedClientOptions | EmbeddedRuntimeClientOptions) {
    this.state = this.init(options);
    // Keep the floating init promise from surfacing as an unhandled rejection. Callers of
    // query/mutation/close still observe the real rejection through `await this.state`.
    void this.state.catch(() => undefined);
  }

  /**
   * Executes a Convex query against the embedded runtime.
   *
   * @typeParam Query - Convex query function reference type.
   * @param query - Convex query function reference.
   * @param args - Query arguments.
   * @returns The query return value.
   * @throws An error thrown by the query handler, argument validation, return
   * validation, storage setup, or a closed client.
   *
   * @example
   * ```ts
   * const todos = await client.query(api.todos.list, {});
   * ```
   */
  async query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    const normalized = toArgs(args[0]);
    // A one-shot `query()` returns to its caller only — it never feeds the reactive cache. The
    // watcher loop is the sole producer of `baseValue`/`baseError`, so a concurrent watched read
    // cannot tear against this result. Mirrors Convex's `client.query()`.
    return (await runner.runQuery(query, normalized)) as FunctionReturnType<Query>;
  }

  /**
   * Executes a Convex mutation against the embedded runtime.
   *
   * @typeParam Mutation - Convex mutation function reference type.
   * @param mutation - Convex mutation function reference.
   * @param argsAndOptions - Mutation arguments followed by optional mutation options.
   * @returns The mutation return value.
   * @throws An error thrown by the mutation handler, optimistic update,
   * validation, storage commit, or a closed client.
   *
   * @example
   * ```ts
   * await client.mutation(api.todos.create, { text: "Write docs" });
   * ```
   */
  async mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...argsAndOptions: ArgsAndOptions<Mutation, MutationOptions<FunctionArgs<Mutation>>>
  ): Promise<FunctionReturnType<Mutation>> {
    this.ensureOpen();
    const { runner } = await this.state;
    this.ensureOpen();
    const [args, options] = argsAndOptions;
    const normalized = toArgs(args) as FunctionArgs<Mutation>;
    const optimistic = options?.optimisticUpdate
      ? this.startOptimisticMutation(options.optimisticUpdate, normalized)
      : undefined;
    try {
      const result = (await runner.runMutation(mutation, normalized, {
        mutationId: this.allocateMutationId(),
      })) as FunctionReturnType<Mutation>;
      if (optimistic !== undefined) await this.completeOptimisticMutation(optimistic);
      return result;
    } catch (error) {
      if (optimistic !== undefined) {
        if (isIndeterminateMutationError(error)) this.markIndeterminate(optimistic);
        else this.dropOptimisticMutation(optimistic);
      }
      throw error;
    }
  }

  /**
   * Creates a local watched query handle.
   *
   * @remarks
   * The watch starts when a callback is registered with {@link Watch.onUpdate}.
   * Call {@link Watch.localQueryResult} from the callback to read the latest
   * local result.
   *
   * @typeParam Query - Convex query function reference type.
   * @param query - Convex query function reference.
   * @param argsAndOptions - Query arguments followed by optional watch options.
   * @returns A watch handle for reading local query state and registering update callbacks.
   * @throws A synchronous error if the client has already been closed.
   *
   * @example
   * ```ts
   * const watch = client.watchQuery(api.todos.list, {});
   * const stop = watch.onUpdate(() => {
   *   render(watch.localQueryResult() ?? []);
   * });
   * ```
   */
  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: ArgsAndOptions<Query, WatchQueryOptions>
  ): Watch<FunctionReturnType<Query>> {
    this.ensureOpen();
    const [args] = argsAndOptions;
    const name = getFunctionName(query);
    const normalized = toArgs(args);
    const key = queryKey(name, normalized);
    return {
      onUpdate: (callback) => this.listen(query, key, normalized, callback),
      localQueryResult: () => {
        const state = this.queries.get(key);
        if (state?.error) throw state.error;
        return state?.value as FunctionReturnType<Query> | undefined;
      },
      localQueryLogs: () => this.queries.get(key)?.logs,
      journal: () => this.queries.get(key)?.journal,
    };
  }

  /**
   * Closes the embedded store and stops active watched queries.
   *
   * @remarks
   * Closing is idempotent. After close begins, query and mutation calls reject
   * or throw because the client no longer accepts work.
   *
   * @returns A promise that settles after storage/runtime cleanup has run.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const state of this.queries.values()) {
      state.stop?.();
      state.stop = undefined;
      state.callbacks.clear();
    }
    this.queries.clear();
    for (const pending of this.pendingOptimisticMutations.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    this.pendingOptimisticMutations.clear();
    this.closePromise = this.state
      .then(async ({ close }) => {
        await close();
      })
      .catch(() => undefined);
    return this.closePromise;
  }

  private async init(
    options: EmbeddedClientOptions | EmbeddedRuntimeClientOptions,
  ): Promise<ClientState> {
    if ("runner" in options) {
      const runner = await options.runner;
      if (this.closed) {
        await options.close?.();
      }
      return { close: options.close ?? (() => undefined), runner };
    }

    const schema = toStoreSchema(options.schema);
    const store = await options.store;
    try {
      await store.setup(schema);
    } catch (error) {
      await store.close();
      throw error;
    }
    if (this.closed) {
      await store.close();
    }
    return { close: () => store.close(), runner: createRunner(options.modules, store, schema) };
  }

  private listen<Query extends FunctionReference<"query">>(
    query: Query,
    key: string,
    args: Record<string, unknown>,
    callback: () => void,
  ): () => void {
    this.ensureOpen();
    const name = getFunctionName(query);
    const state = this.queryState(key, name, args, query);
    state.callbacks.add(callback);
    void this.startQuery(query, args, state);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      state.callbacks.delete(callback);
      // Only tear down if this exact state still occupies the key. If it was already evicted and a
      // fresh state took its place (same key, new subscription), deleting here would orphan the
      // newcomer.
      if (this.queries.get(state.key) !== state) return;
      if (!state.callbacks.size) {
        state.stop?.();
        state.stop = undefined;
        this.queries.delete(state.key);
      }
    };
  }

  private async startQuery<Query extends FunctionReference<"query">>(
    query: Query,
    args: Record<string, unknown>,
    state: QueryState,
  ): Promise<void> {
    try {
      if (state.stop) return;
      const { runner } = await this.state;
      if (this.closed || state.stop || !state.callbacks.size) return;
      state.stop = runner.onUpdate(
        query,
        args,
        (value) => {
          this.dropIndeterminateTouching(state.key);
          state.baseError = undefined;
          state.baseValue = value;
          this.recompute([state]);
        },
        (error) => {
          state.baseError = error;
          this.recompute([state]);
        },
      );
    } catch (error) {
      state.baseError = error;
      this.recompute([state]);
    }
  }

  private queryState(
    key: string,
    name: string,
    args: Record<string, unknown>,
    ref: FunctionReference<"query">,
  ): QueryState {
    let state = this.queries.get(key);
    if (!state) {
      state = {
        args,
        baseError: undefined,
        baseValue: undefined,
        callbacks: new Set(),
        error: undefined,
        key,
        journal: undefined,
        logs: undefined,
        name,
        ref,
        stop: undefined,
        value: undefined,
      };
      this.queries.set(key, state);
    }
    return state;
  }

  private emit(state: QueryState): void {
    for (const callback of Array.from(state.callbacks)) {
      try {
        callback();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private startOptimisticMutation<Args extends Record<string, Value>>(
    optimisticUpdate: OptimisticUpdate<Args>,
    args: Args,
  ): OptimisticMutationId {
    const id = this.nextOptimisticMutationId++;
    this.pendingOptimisticMutations.set(id, {
      args,
      id,
      indeterminate: false,
      optimisticUpdate: optimisticUpdate as OptimisticUpdate<Record<string, Value>>,
      timer: undefined,
      touched: new Set(),
    });
    this.recompute(undefined, id);
    return id;
  }

  private async completeOptimisticMutation(id: OptimisticMutationId): Promise<void> {
    const pending = this.pendingOptimisticMutations.get(id);
    if (!pending) return;
    const { runner } = await this.state;
    const keys = [...pending.touched];
    // Await phase: read fresh base for every key this mutation touched WITHOUT mutating client
    // state. The optimistic overlay stays applied throughout, so the UI never flickers mid-await.
    const refreshed: { state: QueryState; ok: boolean; value?: unknown; error?: unknown }[] = [];
    for (const key of keys) {
      if (this.closed) return;
      const state = this.queries.get(key);
      if (!state) continue;
      try {
        const value = await runner.runQuery(state.ref, state.args);
        refreshed.push({ ok: true, state, value });
      } catch (error) {
        refreshed.push({ error, ok: false, state });
      }
    }
    if (this.closed) return;
    // Swap phase: install fresh base, drop now-covered indeterminate pendings, remove this
    // pending, and recompute exactly once — all synchronously, so there is no intermediate render
    // where base is visible without the optimistic overlay.
    const touched: QueryState[] = [];
    for (const entry of refreshed) {
      this.dropIndeterminateTouching(entry.state.key);
      if (entry.ok) {
        entry.state.baseError = undefined;
        entry.state.baseValue = entry.value;
        entry.state.logs = [];
      } else {
        entry.state.baseError = entry.error;
      }
      touched.push(entry.state);
    }
    this.removePending(id);
    this.recompute(touched);
  }

  /** An indeterminate mutation may still commit, so its optimistic state is kept until then. */
  private markIndeterminate(id: OptimisticMutationId): void {
    const pending = this.pendingOptimisticMutations.get(id);
    if (!pending) return;
    pending.indeterminate = true;
    const timer = setTimeout(
      () => this.dropOptimisticMutation(id),
      INDETERMINATE_OPTIMISTIC_TIMEOUT_MS,
    );
    (timer as { unref?: () => void }).unref?.();
    pending.timer = timer;
  }

  /** Drops an indeterminate pending once a fresh base value covers a key it touched. */
  private dropIndeterminateTouching(key: string): void {
    for (const pending of this.pendingOptimisticMutations.values()) {
      if (pending.indeterminate && pending.touched.has(key)) this.removePending(pending.id);
    }
  }

  private dropOptimisticMutation(id: OptimisticMutationId): void {
    if (this.removePending(id)) this.recompute();
  }

  private removePending(id: OptimisticMutationId): PendingOptimisticMutation | undefined {
    const pending = this.pendingOptimisticMutations.get(id);
    if (!pending) return undefined;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pendingOptimisticMutations.delete(id);
    return pending;
  }

  /**
   * Recomputes every derived query value as the pure fold of pending optimistic updates over
   * base values: `derived = fold(pendings, base)`. There is no rollback path — removing a
   * pending and recomputing IS the rollback. Updates read through an overlay so later pendings
   * observe earlier pendings' writes; keys written that nobody watches live only inside the
   * overlay and are reproduced by the next recompute.
   *
   * @param alwaysEmit - States whose callbacks fire even when their derived value is unchanged
   * (fresh base values notify their listeners, matching watch semantics).
   * @param rethrowId - A pending whose first application error is thrown to the caller instead
   * of reported asynchronously.
   */
  private recompute(alwaysEmit?: Iterable<QueryState>, rethrowId?: OptimisticMutationId): void {
    const overlay = new Map<string, unknown>();
    const overlayArgs = new Map<string, { name: string; args: Record<string, unknown> }>();
    let hasRethrow = false;
    let rethrowError: unknown;
    let applying: PendingOptimisticMutation | undefined;

    const view: OptimisticLocalStore = {
      getQuery: (query, ...queryArgs) => {
        const normalized = toArgs(queryArgs[0]);
        const key = queryKey(getFunctionName(query), normalized);
        if (overlay.has(key)) return overlay.get(key) as never;
        const state = this.queries.get(key);
        if (!state || state.baseError) return undefined;
        return state.baseValue as never;
      },
      getAllQueries: (query) => {
        const name = getFunctionName(query);
        const results: { args: never; value: never }[] = [];
        const seen = new Set<string>();
        for (const state of this.queries.values()) {
          if (state.name !== name) continue;
          seen.add(state.key);
          const value = overlay.has(state.key)
            ? overlay.get(state.key)
            : state.baseError
              ? undefined
              : state.baseValue;
          results.push({ args: state.args as never, value: value as never });
        }
        for (const [key, meta] of overlayArgs) {
          if (meta.name !== name || seen.has(key)) continue;
          results.push({ args: meta.args as never, value: overlay.get(key) as never });
        }
        return results;
      },
      setQuery: (query, queryArgs, value) => {
        const name = getFunctionName(query);
        const normalized = toArgs(queryArgs);
        const key = queryKey(name, normalized);
        overlay.set(key, value);
        overlayArgs.set(key, { name, args: normalized });
        applying?.touched.add(key);
      },
    };

    let settled = false;
    while (!settled) {
      settled = true;
      overlay.clear();
      overlayArgs.clear();
      for (const pending of this.pendingOptimisticMutations.values()) {
        applying = pending;
        pending.touched = new Set();
        try {
          const result: unknown = pending.optimisticUpdate(view, pending.args);
          assertSynchronousOptimisticUpdate(result);
        } catch (error) {
          this.removePending(pending.id);
          if (pending.id === rethrowId) {
            // A boolean sentinel — not `error !== undefined` — so an update that throws `undefined`
            // is still rethrown to the caller rather than silently swallowed.
            hasRethrow = true;
            rethrowError = error;
          } else {
            queueMicrotask(() => {
              throw error;
            });
          }
          settled = false;
          break;
        }
      }
      applying = undefined;
    }

    const changed = new Set<QueryState>(alwaysEmit ?? []);
    for (const state of this.queries.values()) {
      const overlaid = overlay.has(state.key);
      const value = overlaid ? overlay.get(state.key) : state.baseValue;
      const error = overlaid ? undefined : state.baseError;
      // Value equality (not reference) so a structurally-identical recompute does not emit, and
      // consumers keep referential stability. Errors compare by reference.
      if (!equals(state.value, value) || state.error !== error) {
        state.value = value;
        state.error = error;
        changed.add(state);
      }
    }
    for (const state of changed) this.emit(state);

    if (hasRethrow) throw rethrowError;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("ConvexEmbeddedClient has already been closed.");
    }
  }

  private allocateMutationId(): string {
    const id = `${this.clientId}:${this.nextMutationId}`;
    this.nextMutationId += 1;
    return id;
  }
}

function queryKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, args: convexToJson(args as Value) });
}

function toArgs(args: unknown): Record<string, unknown> {
  return normalizeObject((args ?? {}) as Record<string, unknown>);
}

function isIndeterminateMutationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConvexEmbeddedMutationIndeterminateError";
}

function assertSynchronousOptimisticUpdate(result: unknown): void {
  if (isPromiseLike(result)) {
    throw new Error("Optimistic update handlers must be synchronous.");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
