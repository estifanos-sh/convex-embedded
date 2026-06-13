import type { FunctionReference } from "convex/server";
import { client } from "./client";

export type WatchHandle<T> = {
  current: T | undefined;
  error: unknown;
  stop: () => void;
};

export function watch<T>(
  query: FunctionReference<"query">,
  args: Record<string, unknown>,
  onChange: (handle: WatchHandle<T>) => void,
): WatchHandle<T> {
  const w = client.watchQuery(query, args);
  const handle: WatchHandle<T> = {
    current: w.localQueryResult() as T | undefined,
    error: undefined,
    stop: () => undefined,
  };
  const unsubscribe = w.onUpdate(() => {
    try {
      handle.current = w.localQueryResult() as T | undefined;
      handle.error = undefined;
    } catch (error) {
      handle.error = error;
    }
    onChange(handle);
  });
  handle.stop = unsubscribe;
  onChange(handle);
  return handle;
}
