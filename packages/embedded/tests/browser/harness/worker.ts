/** Reply to a browser-worker request with the shared success and failure envelope. */
export function workerRun(operation: () => Promise<unknown>): void {
  void operation()
    .then((result) => self.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ok: false,
      }),
    );
}
