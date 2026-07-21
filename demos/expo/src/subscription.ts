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
