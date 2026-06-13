/**
 * Small platform-neutral helpers shared across the client, runner, and browser coordinator.
 *
 * @internal
 */

/** A promise paired with its resolve/reject handles. */
export interface Deferred<T = void> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

/**
 * Creates a {@link Deferred}: a promise alongside its externally-callable settle handles.
 *
 * @internal
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/**
 * Builds a prefixed random id, preferring `crypto.randomUUID` and falling back to a timestamp +
 * `Math.random` suffix where it is unavailable.
 *
 * @internal
 */
export function randomId(prefix: string): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `${prefix}:${crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
