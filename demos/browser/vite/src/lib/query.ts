export type QueryState<T> =
  | { query: "loading" }
  | { query: "ready"; value: T }
  | { query: "failed"; error: unknown };

export function readQuery<T>(read: () => T | undefined): QueryState<T> {
  try {
    const value = read();
    return value === undefined ? { query: "loading" } : { query: "ready", value };
  } catch (error) {
    return { query: "failed", error };
  }
}
