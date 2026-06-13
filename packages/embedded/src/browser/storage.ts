/**
 * Origin-scoped browser storage identity.
 *
 * @internal
 */
const STORAGE_ID_KEY = "convex-embedded.storageId";
const STORAGE_ID_PATTERN = /^[0-9a-zA-Z_.-]+$/;
const DEFAULT_STORAGE_ID = "origin";

/**
 * Returns the private OPFS database path for this origin.
 *
 * @internal
 */
export function browserStoragePath(): string {
  return `convex-embedded-${browserStorageId()}.db`;
}

/**
 * Returns the private storage identity for this origin.
 *
 * @internal
 */
export function browserStorageId(): string {
  const storage = localStorageLike();
  const stored = readStorageId(storage);
  if (stored) return stored;

  writeStorageId(storage, DEFAULT_STORAGE_ID);
  return DEFAULT_STORAGE_ID;
}

function readStorageId(storage: StorageLike | undefined): string | undefined {
  try {
    const value = storage?.getItem(STORAGE_ID_KEY);
    return value && STORAGE_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStorageId(storage: StorageLike | undefined, value: string): void {
  try {
    storage?.setItem(STORAGE_ID_KEY, value);
  } catch {
    // OPFS is origin-scoped; a deterministic fallback prevents multi-window split-brain even when
    // localStorage is unavailable.
  }
}

function localStorageLike(): StorageLike | undefined {
  return (globalThis as { localStorage?: StorageLike }).localStorage;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
