import { describe, expect, test } from "vite-plus/test";

import { OpfsDirectory, registerTursoFiles } from "../../src/browser/opfs";

describe("OPFS ownership", () => {
  test("fails closed when sync access handles are unsupported", async () => {
    const opfs = new OpfsDirectory(undefined, async () => ({
      getFileHandle: async () => ({}) as never,
    }));

    await expect(opfs.registerFile("documents.db")).rejects.toThrow(
      /requires OPFS createSyncAccessHandle support/,
    );
    expect(opfs.getFileHandle("documents.db")).toBeNull();
  });

  test("closes a partially acquired file set when WAL acquisition fails", async () => {
    const database = accessHandle();
    const quota = new DOMException("Storage quota exhausted.", "QuotaExceededError");
    const opfs = directory({
      "documents.db": async () => database.handle,
      "documents.db-wal": async () => {
        throw quota;
      },
    });

    await expect(registerTursoFiles(opfs, "documents.db")).rejects.toBe(quota);
    expect(database.closeCalls).toBe(1);
    expect(database.truncateCalls).toBe(0);
    expect(opfs.getFileHandle("documents.db")).toBeNull();
  });

  test("retries only an exclusive-handle reclaim race", async () => {
    const phases: string[] = [];
    const database = accessHandle();
    let attempts = 0;
    const opfs = directory(
      {
        "documents.db": async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new DOMException(
              "Predecessor still owns the handle.",
              "NoModificationAllowedError",
            );
          }
          return database.handle;
        },
      },
      (phase) => phases.push(phase),
    );

    await opfs.registerFile("documents.db");

    expect(attempts).toBe(2);
    expect(phases).toEqual(["worker:opfs:acquire:retry", "worker:opfs:acquire:reclaimed"]);
    opfs.closeAll();
    expect(database.closeCalls).toBe(1);
  });
});

function directory(
  files: Record<string, () => Promise<ReturnType<typeof accessHandle>["handle"]>>,
  debug?: (phase: string) => void,
): OpfsDirectory {
  return new OpfsDirectory(debug, async () => ({
    getFileHandle: async (path) => ({
      createSyncAccessHandle: files[path] ?? (async () => accessHandle().handle),
    }),
  }));
}

function accessHandle() {
  let closeCalls = 0;
  let truncateCalls = 0;
  return {
    get closeCalls() {
      return closeCalls;
    },
    handle: {
      close: () => {
        closeCalls += 1;
      },
      flush: () => undefined,
      getSize: () => 0,
      read: () => 0,
      truncate: () => {
        truncateCalls += 1;
      },
      write: () => 0,
    },
    get truncateCalls() {
      return truncateCalls;
    },
  };
}
