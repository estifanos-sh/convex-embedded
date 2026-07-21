import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { StoreAdapter, type StoreBinding } from "../storage/binding";
import { decodeResponse, encodeRequest } from "./codec";
import type { NativeStoreObject } from "./module";
import { loadNativeModule } from "./native";

/** Open the package-owned Expo native store. @internal */
export async function openExpoStore(path: string): Promise<StoreAdapter> {
  const native = loadNativeModule();
  const store = await native.open(path, path, EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY);
  return new StoreAdapter(new ExpoStoreBinding(store));
}

/** Full local StoreBinding facade over the native binary request channel. */
class ExpoStoreBinding implements StoreBinding {
  private closed = false;

  constructor(private readonly native: NativeStoreObject) {}

  setup: StoreBinding["setup"] = (schema) => this.invoke("setup", [schema]);
  identityRead: NonNullable<StoreBinding["identityRead"]> = () => this.invoke("identityRead", []);
  identityWrite: NonNullable<StoreBinding["identityWrite"]> = (identityKey, identityJson) =>
    this.invoke("identityWrite", [identityKey, identityJson]);
  mutationWrite: StoreBinding["mutationWrite"] = (call) => this.invoke("mutationWrite", [call]);
  mutationCacheRead: NonNullable<StoreBinding["mutationCacheRead"]> = (call) =>
    this.invoke("mutationCacheRead", [call]);
  mutationCacheWrite: NonNullable<StoreBinding["mutationCacheWrite"]> = (call) =>
    this.invoke("mutationCacheWrite", [call]);
  mutationFail: StoreBinding["mutationFail"] = (mutationId, error) =>
    this.invoke("mutationFail", [mutationId, error]);
  clockRead: StoreBinding["clockRead"] = () => {
    this.ensureOpen();
    return this.native.clockRead();
  };
  commit: StoreBinding["commit"] = (batch, options) => this.invoke("commit", [batch, options]);
  docRead: StoreBinding["docRead"] = (table, id) => this.invoke("docRead", [table, id]);
  docVersionRead: StoreBinding["docVersionRead"] = (table, id) =>
    this.invoke("docVersionRead", [table, id]);
  crdtHeadRead: StoreBinding["crdtHeadRead"] = (table, id, field) =>
    this.invoke("crdtHeadRead", [table, id, field]);
  crdtSnapshotRead: StoreBinding["crdtSnapshotRead"] = (table, id, ops) =>
    this.invoke("crdtSnapshotRead", [table, id, ops]);
  docPageRead: StoreBinding["docPageRead"] = (spec) => this.invoke("docPageRead", [spec]);
  keyPageRead: StoreBinding["keyPageRead"] = (spec) => this.invoke("keyPageRead", [spec]);
  docCountRead: StoreBinding["docCountRead"] = (spec) => this.invoke("docCountRead", [spec]);
  ledgerDelete: StoreBinding["ledgerDelete"] = (upToSeq) => this.invoke("ledgerDelete", [upToSeq]);
  walWrite: StoreBinding["walWrite"] = () => this.invoke("walWrite", []);
  blobRead: StoreBinding["blobRead"] = (key) => this.invoke("blobRead", [key]);
  blobWrite: StoreBinding["blobWrite"] = (key, bytes) => this.invoke("blobWrite", [key, bytes]);
  blobDelete: StoreBinding["blobDelete"] = (key) => this.invoke("blobDelete", [key]);
  resultRead: NonNullable<StoreBinding["resultRead"]> = (key) => this.invoke("resultRead", [key]);
  resultWrite: NonNullable<StoreBinding["resultWrite"]> = (entry) =>
    this.invoke("resultWrite", [entry]);
  resultDelete: NonNullable<StoreBinding["resultDelete"]> = (key) =>
    this.invoke("resultDelete", [key]);
  docBaseRead: NonNullable<StoreBinding["docBaseRead"]> = (table, id) =>
    this.invoke("docBaseRead", [table, id]);
  idWrite: StoreBinding["idWrite"] = (mapping) => this.invoke("idWrite", [mapping]);
  idRead: StoreBinding["idRead"] = (table, localId) => this.invoke("idRead", [table, localId]);
  idPageRead: StoreBinding["idPageRead"] = (table) => this.invoke("idPageRead", [table]);
  dirtyHeadsDebugRead: NonNullable<StoreBinding["dirtyHeadsDebugRead"]> = () =>
    this.invoke("dirtyHeadsDebugRead", []);
  remoteDocDebugRead: NonNullable<StoreBinding["remoteDocDebugRead"]> = (table, localId) =>
    this.invoke("remoteDocDebugRead", [table, localId]);
  idDelete: StoreBinding["idDelete"] = (table, localId) =>
    this.invoke("idDelete", [table, localId]);
  fileWrite: StoreBinding["fileWrite"] = (input) => this.invoke("fileWrite", [input]);
  fileMetaWrite: StoreBinding["fileMetaWrite"] = (metadata) =>
    this.invoke("fileMetaWrite", [metadata]);
  fileRead: StoreBinding["fileRead"] = (storageId) => this.invoke("fileRead", [storageId]);
  fileDelete: StoreBinding["fileDelete"] = (storageId) => this.invoke("fileDelete", [storageId]);
  uploadWrite: StoreBinding["uploadWrite"] = (upload) => this.invoke("uploadWrite", [upload]);
  uploadRead: StoreBinding["uploadRead"] = () => this.invoke("uploadRead", []);
  uploadLeaseWrite: StoreBinding["uploadLeaseWrite"] = (args) =>
    this.invoke("uploadLeaseWrite", [args]);
  uploadComplete: StoreBinding["uploadComplete"] = (localStorageId, owner, convexId, nowMs) =>
    this.invoke("uploadComplete", [localStorageId, owner, convexId, nowMs]);
  uploadDelete: StoreBinding["uploadDelete"] = (localStorageId) =>
    this.invoke("uploadDelete", [localStorageId]);
  scheduleWrite: StoreBinding["scheduleWrite"] = (job) => this.invoke("scheduleWrite", [job]);
  scheduleRead: StoreBinding["scheduleRead"] = () => this.invoke("scheduleRead", []);
  scheduleLeaseWrite: StoreBinding["scheduleLeaseWrite"] = (nowMs) =>
    this.invoke("scheduleLeaseWrite", [nowMs]);
  scheduleComplete: StoreBinding["scheduleComplete"] = (jobId, nowMs) =>
    this.invoke("scheduleComplete", [jobId, nowMs]);
  scheduleFail: StoreBinding["scheduleFail"] = (jobId, nowMs) =>
    this.invoke("scheduleFail", [jobId, nowMs]);
  scheduleCancel: StoreBinding["scheduleCancel"] = (jobId, nowMs) =>
    this.invoke("scheduleCancel", [jobId, nowMs]);
  clear: StoreBinding["clear"] = () => this.invoke("clear", []);

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.native.close();
    } finally {
      this.native.release();
    }
  }

  private async invoke<T>(operation: string, args: unknown[]): Promise<T> {
    this.ensureOpen();
    return decodeResponse<T>(await this.native.call(encodeRequest(operation, args)));
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Convex Embedded Expo store is closed.");
  }
}
