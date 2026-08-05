import { EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY } from "../protocol";
import { normalizeStorageError } from "../error";
import { StoreAdapter, type StoreBinding } from "../storage/binding";
import type { RemoteStartOptions, RemoteTick } from "../storage/types";
import { decodeResponse, encodeRequest } from "./codec";
import type { NativeStoreObject } from "./module";
import { loadNativeModule } from "./native";

/** Open the package-owned Expo native store. @internal */
export async function openExpoStore(path: string): Promise<StoreAdapter> {
  const native = loadNativeModule();
  try {
    const store = await native.open(path, path, EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY);
    return new StoreAdapter(new ExpoStoreBinding(store));
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

/** Full StoreBinding facade over the native binary request channel. @internal */
export class ExpoStoreBinding implements StoreBinding {
  private closed = false;
  private remoteActive = false;
  private remoteGeneration = 0;
  private remotePoll: Promise<void> | undefined;
  private remotePollError: unknown;
  private remoteStop: (() => void) | undefined;

  constructor(private readonly native: NativeStoreObject) {}

  setup: StoreBinding["setup"] = (schema) => this.invoke("setup", [schema]);
  migrationBegin: StoreBinding["migrationBegin"] = (schema) =>
    this.invoke("migrationBegin", [schema]);
  migrationCopyStep: StoreBinding["migrationCopyStep"] = (generation) =>
    this.invoke("migrationCopyStep", [generation]);
  migrationBind: StoreBinding["migrationBind"] = (schema, generation) =>
    this.invoke("migrationBind", [schema, generation]);
  migrationMaterializeStep: StoreBinding["migrationMaterializeStep"] = (generation) =>
    this.invoke("migrationMaterializeStep", [generation]);
  migrationUnbind: StoreBinding["migrationUnbind"] = () => this.invoke("migrationUnbind", []);
  migrationSetupComplete: StoreBinding["migrationSetupComplete"] = (generation) =>
    this.invoke("migrationSetupComplete", [generation]);
  originPageRead: StoreBinding["originPageRead"] = (generation, cursorJson, pageSize, upperJson) =>
    this.invoke("originPageRead", [generation, cursorJson, pageSize, upperJson]);
  migrationRecordDispositionWrite: StoreBinding["migrationRecordDispositionWrite"] = (
    generation,
    identityKey,
    kind,
    recordKey,
    migrationId,
    reason,
    discard,
  ) =>
    this.invoke("migrationRecordDispositionWrite", [
      generation,
      identityKey,
      kind,
      recordKey,
      migrationId,
      reason,
      discard,
    ]);
  migrationQueuePolicyWrite: StoreBinding["migrationQueuePolicyWrite"] = (generation, policyJson) =>
    this.invoke("migrationQueuePolicyWrite", [generation, policyJson]);
  migrationQueuePolicyStateRead: StoreBinding["migrationQueuePolicyStateRead"] = (generation) =>
    this.invoke("migrationQueuePolicyStateRead", [generation]);
  migrationFinalizePrepare: StoreBinding["migrationFinalizePrepare"] = (schema, generation) =>
    this.invoke("migrationFinalizePrepare", [schema, generation]);
  migrationCommit: StoreBinding["migrationCommit"] = (schema, generation) =>
    this.invoke("migrationCommit", [schema, generation]);
  migrationRetire: StoreBinding["migrationRetire"] = (generation) =>
    this.invoke("migrationRetire", [generation]);
  migrationRetireStep: StoreBinding["migrationRetireStep"] = (generation) =>
    this.invoke("migrationRetireStep", [generation]);
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
  localFieldsRead: NonNullable<StoreBinding["localFieldsRead"]> = (table, id) =>
    this.invoke("localFieldsRead", [table, id]);
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
  remoteCursorDebugRead: NonNullable<StoreBinding["remoteCursorDebugRead"]> = (subscription) =>
    this.invoke("remoteCursorDebugRead", [subscription]);
  remoteMemberDebugRead: NonNullable<StoreBinding["remoteMemberDebugRead"]> = (subscription) =>
    this.invoke("remoteMemberDebugRead", [subscription]);
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
  remoteStart: NonNullable<StoreBinding["remoteStart"]> = async (options) => {
    this.ensureOpen();
    if (this.remoteActive) throw new Error("Convex Embedded Expo remote is already started.");
    const { auth: _auth, notify: _notify, transport: _transport, ...nativeOptions } = options;
    await this.invoke("remoteStart", [nativeOptions]);
    this.remotePollError = undefined;
    this.remoteActive = true;
    const generation = ++this.remoteGeneration;
    let stop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    this.remoteStop = stop;
    this.remotePoll = this.pollRemote(options, generation, stopped);
  };
  remoteClose: NonNullable<StoreBinding["remoteClose"]> = async () => {
    if (!this.remoteActive) return;
    // Stop the event loop before asking Rust to wake the outstanding blocking `remoteNext` call.
    // Otherwise an empty close wake can race into one more wait before the close promise resolves.
    this.remoteActive = false;
    this.remoteStop?.();
    this.remoteStop = undefined;
    try {
      await this.invoke("remoteClose", []);
    } finally {
      await this.remotePoll;
      this.remotePoll = undefined;
      this.remotePollError = undefined;
    }
  };
  remotePull: NonNullable<StoreBinding["remotePull"]> = (_localProgress) =>
    this.invokeRemote("remotePull", []);
  remoteIdentity: NonNullable<StoreBinding["remoteIdentity"]> = () =>
    this.invokeRemote("remoteIdentity", []);
  remoteDocPush: NonNullable<StoreBinding["remoteDocPush"]> = (
    table,
    id,
    firstCommitSeq,
    updatedCommitSeq,
  ) => this.invokeRemote("remoteDocPush", [table, id, firstCommitSeq, updatedCommitSeq]);
  remoteScopeWrite: NonNullable<StoreBinding["remoteScopeWrite"]> = (scopeJson) =>
    this.invokeRemote("remoteScopeWrite", [scopeJson]);
  clear: StoreBinding["clear"] = () => this.invoke("clear", []);

  async close(): Promise<void> {
    if (this.closed) return;
    await this.remoteClose();
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

  private async invokeRemote<T>(operation: string, args: unknown[]): Promise<T> {
    if (this.remotePollError) throw this.remotePollError;
    return await this.invoke<T>(operation, args);
  }

  private async pollRemote(
    options: RemoteStartOptions,
    generation: number,
    stopped: Promise<void>,
  ): Promise<void> {
    while (this.remoteActive && generation === this.remoteGeneration) {
      try {
        const events = await this.invoke<RemoteBridgeEvent[]>("remoteNext", []);
        for (const event of events) {
          if (!this.remoteActive || generation !== this.remoteGeneration) return;
          if (event.kind === "tick") {
            options.notify?.(event.tick);
            continue;
          }
          const auth = Promise.resolve()
            .then(() => options.auth?.({ forceRefreshToken: event.forceRefreshToken }))
            .then(
              (token) => ({ kind: "token" as const, token: token ?? null }),
              (error: unknown) => ({ error, kind: "error" as const }),
            );
          const result = await Promise.race([
            auth,
            stopped.then(() => ({ kind: "closed" as const })),
          ]);
          if (
            result.kind === "closed" ||
            !this.remoteActive ||
            generation !== this.remoteGeneration
          ) {
            return;
          }
          if (result.kind === "token") {
            await this.invoke("remoteAuthWrite", [event.id, result.token, null]);
          } else {
            await this.invoke("remoteAuthWrite", [event.id, null, errorMessage(result.error)]);
          }
        }
      } catch (error) {
        if (this.remoteActive) this.remotePollError = error;
        return;
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Convex Embedded Expo store is closed.");
  }
}

type RemoteBridgeEvent =
  | { kind: "auth"; id: number; forceRefreshToken: boolean }
  | { kind: "tick"; tick: RemoteTick };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
