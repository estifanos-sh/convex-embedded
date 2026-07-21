import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import * as React from "react";

import { client } from "@/src/client";

export type EmbeddedQueryState<Value> =
  | { status: "loading"; retry: () => void }
  | { status: "error"; error: Error; retry: () => void }
  | { status: "ready"; value: Value; retry: () => void };

/** Subscribe to an embedded query without introducing a Convex React provider. */
export function useEmbeddedQuery<Query extends FunctionReference<"query">>(
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

  React.useEffect(() => {
    setState({ status: "loading" });
    const watch = client.watchQuery(query, args);
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
  }, [args, attempt, query]);

  return { ...state, retry };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The embedded query failed.");
}
