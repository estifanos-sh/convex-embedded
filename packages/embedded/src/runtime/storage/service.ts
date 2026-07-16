import type { EmbeddedInternalEventListener } from "../../events";
import type { FileMetadata, FileStore, RuntimeStorageWriter } from "../../storage/types";
import { getTimerTime } from "../../time";
import { createUploadUrl, readUploadToken } from "../../upload";
import { randomId } from "../../id/random";
import { copyArrayBuffer, localStorageId, sha256Hex } from "../../storage/file";
import { normalizeCopy } from "../codec";
import { emitFileStore } from "../emit";
import { fullStore } from "../service";

export interface UploadUrl {
  expiresAt: number;
  source: string;
  used: boolean;
}

export interface StorageReaderService {
  getMetadata(storageId: string): Promise<FileMetadata | null>;
  getUrl(storageId: string): Promise<string | null>;
}

export interface StorageWriterService extends StorageReaderService {
  _handleUpload(url: string, blob: Blob): Promise<{ storageId: string }>;
  delete(storageId: string): Promise<void>;
  generateUploadUrl(): Promise<string>;
}

export interface StorageActionService extends StorageWriterService {
  get(storageId: string): Promise<Blob | null>;
  store(blob: Blob): Promise<string>;
}

export function createStorageService(
  store: RuntimeStorageWriter,
  uploadUrls: Map<string, UploadUrl>,
  objectUrls: Map<string, string>,
  mode: "reader",
  emit: EmbeddedInternalEventListener,
): StorageReaderService;
export function createStorageService(
  store: RuntimeStorageWriter,
  uploadUrls: Map<string, UploadUrl>,
  objectUrls: Map<string, string>,
  mode: "writer",
  emit: EmbeddedInternalEventListener,
  generatedUploadUrls?: string[],
): StorageWriterService;
export function createStorageService(
  store: RuntimeStorageWriter,
  uploadUrls: Map<string, UploadUrl>,
  objectUrls: Map<string, string>,
  mode: "action",
  emit: EmbeddedInternalEventListener,
): StorageActionService;
export function createStorageService(
  store: RuntimeStorageWriter,
  uploadUrls: Map<string, UploadUrl>,
  objectUrls: Map<string, string>,
  mode: "reader" | "writer" | "action",
  emit: EmbeddedInternalEventListener,
  generatedUploadUrls?: string[],
): StorageReaderService | StorageWriterService | StorageActionService {
  const service = fullStore(store);
  const storeBlob = async (blob: Blob): Promise<string> => {
    if (!service.file) {
      throw new Error("Convex embedded runtime storage backend does not support local files.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const storageId = localStorageId();
    const now = getTimerTime();
    const sha256 = await sha256Hex(bytes);
    const metadata: FileMetadata = {
      storageId,
      sha256,
      size: bytes.byteLength,
      contentType: blob.type || undefined,
      createdTime: now,
      updatedTime: now,
    };
    const input: FileStore = { bytes, metadata };
    await service.file.write(input);
    emitFileStore(emit, metadata);
    return storageId;
  };
  const getBlob = async (storageId: string): Promise<Blob | null> => {
    if (!service.blob) {
      throw new Error("Convex embedded runtime storage backend does not support local files.");
    }
    const bytes = await service.blob.read(storageId);
    if (!bytes) return null;
    const metadata = service.file ? await service.file.read(storageId) : undefined;
    // Blob copies the view synchronously, which lets the storage backend reuse/release its buffer.
    return new Blob([copyArrayBuffer(bytes)], { type: metadata?.contentType });
  };
  const read = {
    async getMetadata(storageId: string) {
      if (!service.file) {
        throw new Error("Convex embedded runtime storage backend does not support file metadata.");
      }
      return (await service.file.read(storageId)) ?? null;
    },
    async getUrl(storageId: string) {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
      const cached = objectUrls.get(storageId);
      if (cached) return cached;
      const blob = await getBlob(storageId);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      objectUrls.set(storageId, url);
      return url;
    },
  };
  if (mode === "reader") return read;
  const writer = {
    ...read,
    async delete(storageId: string) {
      if (!service.file) {
        throw new Error("Convex embedded runtime storage backend does not support local files.");
      }
      const url = objectUrls.get(storageId);
      if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      objectUrls.delete(storageId);
      await service.file.delete(storageId);
      const at = getTimerTime();
      const deletes = [
        { id: storageId, table: "_storage" },
        { id: storageId, table: "_pending_uploads" },
      ];
      const mapping = service.id ? await service.id.read("_storage", storageId) : undefined;
      const docWrites = mapping
        ? [
            {
              id: `_storage|${storageId}`,
              row: {
                ...(normalizeCopy(mapping) as Record<string, unknown>),
                id: `_storage|${storageId}`,
              },
              table: "_id_mappings",
            },
          ]
        : [];
      emit({
        at,
        changedTables: ["_storage", "_pending_uploads", "_id_mappings"],
        deletes,
        type: "data",
        docWrites,
      });
      emit({ at, deletes, type: "storage", docWrites });
    },
    async generateUploadUrl() {
      const token = randomId("upload");
      uploadUrls.set(token, {
        expiresAt: getTimerTime() + 5 * 60_000,
        source: "generateUploadUrl",
        used: false,
      });
      const url = createUploadUrl(token);
      generatedUploadUrls?.push(url);
      return url;
    },
    async _handleUpload(url: string, blob: Blob) {
      const token = readUploadToken(url);
      if (!token) throw new Error("Embedded upload URL is not local to this runtime.");
      const entry = uploadUrls.get(token);
      if (!entry || entry.used || entry.expiresAt < getTimerTime()) {
        throw new Error("Embedded upload URL is expired or already used.");
      }
      entry.used = true;
      const storageId = await storeBlobWithSource(blob, entry.source);
      return { storageId };
    },
  };
  if (mode === "writer") return writer;
  return {
    ...writer,
    store: storeBlob,
    get: getBlob,
  };

  async function storeBlobWithSource(blob: Blob, source: string): Promise<string> {
    if (!service.file) {
      throw new Error("Convex embedded runtime storage backend does not support local files.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const storageId = localStorageId();
    const now = getTimerTime();
    const sha256 = await sha256Hex(bytes);
    await service.file.write({
      bytes,
      metadata: {
        storageId,
        sha256,
        size: bytes.byteLength,
        contentType: blob.type || undefined,
        source,
        createdTime: now,
        updatedTime: now,
      },
    });
    emitFileStore(emit, {
      storageId,
      sha256,
      size: bytes.byteLength,
      contentType: blob.type || undefined,
      source,
      createdTime: now,
      updatedTime: now,
    });
    return storageId;
  }
}
