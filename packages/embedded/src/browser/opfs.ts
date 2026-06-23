import { getTimerTime } from "../time";

type SyncAccessHandle = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
};

type DirectoryHandle = {
  getFileHandle(
    path: string,
    options: { create: boolean },
  ): Promise<{
    createSyncAccessHandle(options?: { mode: "readwrite" }): Promise<SyncAccessHandle>;
  }>;
};

declare const navigator:
  | undefined
  | {
      storage?: {
        getDirectory?: () => Promise<DirectoryHandle>;
        persist?: () => Promise<boolean>;
        persisted?: () => Promise<boolean>;
      };
    };

declare const DedicatedWorkerGlobalScope: undefined | (new () => unknown);
declare const self: unknown;

const ACCESS_HANDLE_RETRY_BASE_MS = 10;
const ACCESS_HANDLE_RETRY_MAX_MS = 250;
const ACCESS_HANDLE_RETRY_BUDGET_MS = 15_000;

type OpfsDebug = (phase: string, detail?: unknown) => void;
type OpfsRoot = () => Promise<DirectoryHandle>;

/**
 * OPFS file registry used by the Rust Turso IO bridge.
 *
 * @internal
 */
export class OpfsDirectory {
  private nextHandle = 0;
  private readonly byHandle = new Map<number, SyncAccessHandle>();
  private readonly byPath = new Map<string, { handle: number; sync: SyncAccessHandle }>();

  constructor(
    private readonly debug?: OpfsDebug,
    private readonly root: OpfsRoot = opfsRoot,
  ) {}

  async registerFile(path: string): Promise<void> {
    if (this.byPath.has(path)) return;
    const root = await this.root();
    const file = await root.getFileHandle(path, { create: true });
    if (typeof file.createSyncAccessHandle !== "function") {
      throw new Error(
        "ConvexEmbeddedClient browser storage requires OPFS createSyncAccessHandle support.",
      );
    }
    const sync = await createSyncAccessHandleWithRetry(file, this.debug);
    this.nextHandle += 1;
    this.byPath.set(path, { handle: this.nextHandle, sync });
    this.byHandle.set(this.nextHandle, sync);
  }

  closeFile(handle: number): number {
    const sync = this.byHandle.get(handle);
    this.debug?.("worker:opfs:close-file", { handle, registered: sync !== undefined });
    if (!sync) return 0;
    this.byHandle.delete(handle);
    for (const [path, file] of this.byPath) {
      if (file.handle === handle) {
        this.byPath.delete(path);
        break;
      }
    }
    sync.close();
    return 0;
  }

  removeFile(path: string): number {
    const file = this.byPath.get(path);
    this.debug?.("worker:opfs:remove-file", { path, registered: file !== undefined });
    if (file) {
      file.sync.truncate(0);
      file.sync.flush();
    }
    return 0;
  }

  closeAll(): void {
    for (const file of this.byPath.values()) {
      try {
        file.sync.close();
      } catch {}
    }
    this.byPath.clear();
    this.byHandle.clear();
  }

  getFileHandle(path: string): number | null {
    return this.byPath.get(path)?.handle ?? null;
  }

  read(handle: number, buffer: Uint8Array, offset: number): number {
    return this.file(handle).read(buffer, { at: Number(offset) });
  }

  write(handle: number, buffer: Uint8Array, offset: number): number {
    return this.file(handle).write(buffer, { at: Number(offset) });
  }

  sync(handle: number): number {
    this.file(handle).flush();
    return 0;
  }

  truncate(handle: number, size: number): number {
    this.debug?.("worker:opfs:truncate", { handle, size });
    this.file(handle).truncate(size);
    return 0;
  }

  size(handle: number): number {
    return this.file(handle).getSize();
  }

  private file(handle: number): SyncAccessHandle {
    const file = this.byHandle.get(handle);
    if (!file) throw new Error(`unknown OPFS file handle: ${handle}`);
    return file;
  }
}

/**
 * Asks the browser to mark this origin's storage persistent so OPFS is exempt from Safari's 7-day
 * ITP eviction of an idle origin. iOS grants silently from interaction history; the result is
 * advisory, so this is fire-and-forget and never blocks or fails store open.
 *
 * @internal
 */
export function requestStoragePersistence(debug?: OpfsDebug): void {
  if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function") return;
  void navigator.storage
    .persist()
    .then((granted) => debug?.("worker:opfs:persist", { granted }))
    .catch(() => undefined);
}

async function opfsRoot(): Promise<DirectoryHandle> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    throw new Error(
      "ConvexEmbeddedClient browser storage requires navigator.storage.getDirectory.",
    );
  }
  return navigator.storage.getDirectory();
}

async function createSyncAccessHandleWithRetry(
  file: {
    createSyncAccessHandle(options?: { mode: "readwrite" }): Promise<SyncAccessHandle>;
  },
  debug?: OpfsDebug,
): Promise<SyncAccessHandle> {
  const startedAt = now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const sync = await openExclusiveSyncAccessHandle(file);
      if (attempt > 0) {
        debug?.("worker:opfs:acquire:reclaimed", { attempt, waitedMs: now() - startedAt });
      }
      return sync;
    } catch (error) {
      if (!isNoModificationAllowedError(error)) throw error;
      // A dead predecessor's exclusive handle outlives its Web Lock until the browser reclaims it.
      // The storage-owner lock already serializes LIVE owners, so a NoModificationAllowedError here
      // is a reclaim race, not a live conflict: back off and wait for the reclaim, capped by budget.
      const waitedMs = now() - startedAt;
      if (waitedMs >= ACCESS_HANDLE_RETRY_BUDGET_MS) {
        throw Object.assign(
          new Error(
            "ConvexEmbeddedClient browser storage is already open in another tab or stale runtime. Close or reload other tabs using this embedded database.",
          ),
          { cause: error },
        );
      }
      const delay = Math.min(
        ACCESS_HANDLE_RETRY_MAX_MS,
        ACCESS_HANDLE_RETRY_BASE_MS * 2 ** attempt,
      );
      debug?.("worker:opfs:acquire:retry", { attempt, delayMs: delay, waitedMs });
      await sleep(delay);
    }
  }
}

async function openExclusiveSyncAccessHandle(file: {
  createSyncAccessHandle(options?: { mode: "readwrite" }): Promise<SyncAccessHandle>;
}): Promise<SyncAccessHandle> {
  try {
    return await file.createSyncAccessHandle({ mode: "readwrite" });
  } catch (error) {
    if (isNoModificationAllowedError(error)) throw error;
    return file.createSyncAccessHandle();
  }
}

function now(): number {
  return getTimerTime();
}

function isNoModificationAllowedError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "NoModificationAllowedError"
    : typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "NoModificationAllowedError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Registers the database, WAL, and SHM files Turso opens for a database path.
 *
 * @internal
 */
export async function registerTursoFiles(opfs: OpfsDirectory, path: string): Promise<void> {
  try {
    await opfs.registerFile(path);
    await opfs.registerFile(`${path}-wal`);
    await opfs.registerFile(`${path}-shm`);
  } catch (error) {
    opfs.closeAll();
    throw error;
  }
}

/**
 * Clears the database, WAL, and SHM files for a storage path back to empty so a fresh
 * current-format store can be created in their place. The OPFS sync-access handles are owned by
 * this JS registry (the Rust IO bridge can only look them up, never re-register), so a store whose
 * physical bytes an incompatible build left unreadable is reset here rather than in Rust. Truncating
 * the WAL alongside the database matters: a leftover WAL from the old format would re-corrupt the
 * fresh database on replay.
 *
 * @internal
 */
export async function resetTursoFiles(opfs: OpfsDirectory, path: string): Promise<void> {
  opfs.closeAll();
  await registerTursoFiles(opfs, path);
  for (const suffix of ["", "-wal", "-shm"]) {
    opfs.removeFile(`${path}${suffix}`);
  }
}

/**
 * Creates the wasm imports consumed by the Rust OPFS `IO` implementation.
 *
 * @internal
 */
export function opfsImports(
  opfs: OpfsDirectory,
  memory: { buffer: ArrayBufferLike },
): Record<string, unknown> {
  return {
    opfs_is_dedicated_worker: isDedicatedWorker,
    opfs_get_file(ptr: number, len: number): number {
      try {
        return opfs.getFileHandle(getString(memory, ptr, len)) ?? -404;
      } catch {
        return -1;
      }
    },
    opfs_close_file(handle: number): number {
      try {
        return opfs.closeFile(handle);
      } catch {
        return -1;
      }
    },
    opfs_read(handle: number, ptr: number, len: number, offset: number): number {
      try {
        return opfs.read(handle, getBytes(memory, ptr, len), offset);
      } catch {
        return -1;
      }
    },
    opfs_write(handle: number, ptr: number, len: number, offset: number): number {
      try {
        return opfs.write(handle, getBytes(memory, ptr, len), offset);
      } catch {
        return -1;
      }
    },
    opfs_sync(handle: number): number {
      try {
        return opfs.sync(handle);
      } catch {
        return -1;
      }
    },
    opfs_truncate(handle: number, len: number): number {
      try {
        return opfs.truncate(handle, len);
      } catch {
        return -1;
      }
    },
    opfs_remove_file(ptr: number, len: number): number {
      try {
        return opfs.removeFile(getString(memory, ptr, len));
      } catch {
        return -1;
      }
    },
    opfs_size(handle: number): number {
      try {
        return opfs.size(handle);
      } catch {
        return -1;
      }
    },
  };
}

/**
 * Creates failing OPFS wasm imports for instances that must not touch storage, such as the napi
 * async-work child threads. `opfs_is_dedicated_worker` reports false so the Rust bridge rejects
 * any I/O attempted outside the owner worker.
 *
 * @internal
 */
export function opfsStubImports(): Record<string, unknown> {
  return {
    opfs_is_dedicated_worker: () => false,
    opfs_get_file: () => -1,
    opfs_close_file: () => -1,
    opfs_read: () => -1,
    opfs_write: () => -1,
    opfs_sync: () => -1,
    opfs_truncate: () => -1,
    opfs_remove_file: () => -1,
    opfs_size: () => -1,
  };
}

function getBytes(memory: { buffer: ArrayBufferLike }, ptr: number, len: number): Uint8Array {
  const offset = ptr >>> 0;
  return new Uint8Array(memory.buffer).subarray(offset, offset + len);
}

function getString(memory: { buffer: ArrayBufferLike }, ptr: number, len: number): string {
  const shared = getBytes(memory, ptr, len);
  // TextDecoder may keep temporary state, so path strings copy out of WASM memory first.
  const copy = new Uint8Array(shared.length);
  copy.set(shared);
  return new TextDecoder("utf-8").decode(copy);
}

function isDedicatedWorker(): boolean {
  return (
    typeof DedicatedWorkerGlobalScope !== "undefined" && self instanceof DedicatedWorkerGlobalScope
  );
}
