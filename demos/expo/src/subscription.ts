import {
  type FunctionArgs,
  getFunctionName,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, type Value } from "convex/values";
import * as React from "react";

export type EmbeddedQueryState<Value> =
  | { status: "loading"; retry: () => void }
  | { status: "error"; error: Error; retry: () => void }
  | { status: "ready"; value: Value; retry: () => void };

export interface EmbeddedQueryWatch<Value> {
  localQueryResult(): Value | undefined;
  onUpdate(callback: () => void): () => void;
}

export interface EmbeddedQueryClient {
  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
  ): EmbeddedQueryWatch<FunctionReturnType<Query>>;
}

export type EmbeddedQueryWaitOptions<Value> = {
  accept?: (value: Value) => boolean;
  onError?: (error: Error) => void;
  onUpdate?: (value: Value) => void;
  signal?: AbortSignal;
  timeoutMessage?: string;
  timeoutMs?: number;
};

export type EmbeddedQuerySubscription<Value> = {
  close: () => void;
  result: Promise<Value>;
};

/**
 * Open a watched query and retain its remote scope until the caller closes the subscription.
 */
export function openQuerySubscription<Query extends FunctionReference<"query">>(
  client: EmbeddedQueryClient,
  query: Query,
  args: FunctionArgs<Query>,
  options: EmbeddedQueryWaitOptions<FunctionReturnType<Query>> = {},
): EmbeddedQuerySubscription<FunctionReturnType<Query>> {
  let closed = false;
  let settled = false;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectResult: (error: unknown) => void = () => undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", close);
    unsubscribe?.();
    if (!settled) {
      settled = true;
      rejectResult(abortError());
    }
  };

  const result = new Promise<FunctionReturnType<Query>>((resolve, reject) => {
    rejectResult = reject;
    if (options.signal?.aborted) {
      close();
      return;
    }

    options.signal?.addEventListener("abort", close, { once: true });
    const fail = (error: unknown) => {
      if (settled) {
        options.onError?.(toError(error));
        return;
      }
      settled = true;
      reject(error);
      close();
    };
    const read = (watch: EmbeddedQueryWatch<FunctionReturnType<Query>>) => {
      try {
        const value = watch.localQueryResult();
        if (value === undefined) return;
        if (settled) {
          options.onUpdate?.(value);
          return;
        }
        if (options.accept && !options.accept(value)) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        resolve(value);
      } catch (error: unknown) {
        fail(error);
      }
    };

    try {
      const watch = client.watchQuery(query, args);
      unsubscribe = watch.onUpdate(() => read(watch));
      if (closed) unsubscribe();
      else read(watch);
    } catch (error: unknown) {
      fail(error);
    }

    if (options.timeoutMs !== undefined && !settled && !closed) {
      timeout = setTimeout(() => {
        fail(new Error(options.timeoutMessage ?? "The embedded query did not become ready."));
      }, options.timeoutMs);
    }
  });

  return { close, result };
}

/**
 * Wait for a watched query value, keeping the subscription alive while an initially absent remote
 * row is pulled into embedded storage.
 */
export function waitForQuerySubscription<Query extends FunctionReference<"query">>(
  client: EmbeddedQueryClient,
  query: Query,
  args: FunctionArgs<Query>,
  options: EmbeddedQueryWaitOptions<FunctionReturnType<Query>> = {},
): Promise<FunctionReturnType<Query>> {
  const subscription = openQuerySubscription(client, query, args, options);
  return subscription.result.finally(subscription.close);
}

/** Identify a query subscription by its Convex function path and argument values. */
export function queryIdentity<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): string {
  return JSON.stringify([getFunctionName(query), convexToJson(args as Value)]);
}

export function useQuerySubscription<Query extends FunctionReference<"query">>(
  client: EmbeddedQueryClient,
  query: Query,
  args: FunctionArgs<Query>,
): EmbeddedQueryState<FunctionReturnType<Query>> {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<
    | { status: "loading" }
    | { status: "error"; error: Error }
    | { status: "ready"; value: FunctionReturnType<Query> }
  >({ status: "loading" });
  const retry = React.useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  const identity = queryIdentity(query, args);
  const request = React.useMemo(
    () => ({ args, query }),
    // Convex API references are fresh proxies on every property access. Their function path and
    // encoded argument values are the stable subscription identity, matching Convex's useQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity],
  );

  React.useEffect(() => {
    setState({ status: "loading" });
    const watch = client.watchQuery(request.query, request.args);
    const read = () => {
      try {
        const value = watch.localQueryResult();
        if (value !== undefined) setState({ status: "ready", value });
      } catch (error: unknown) {
        setState({ status: "error", error: toError(error) });
      }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, [attempt, client, request]);

  return { ...state, retry };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The embedded query failed.");
}

function abortError(): Error {
  const error = new Error("The embedded query was cancelled.");
  error.name = "AbortError";
  return error;
}
