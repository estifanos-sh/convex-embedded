import { cloneTree, encode, freezeNormalizedTreeWithEstimate, reviveDoc } from "../runtime/codec";
import { remoteTickTables } from "../rev";
import type {
  BlobSurface,
  Bound,
  ClockSurface,
  ColValues,
  ColValue,
  CountSpec,
  CommitCrdtWireOp,
  CommitOptions,
  CommitResult,
  DirtyHeadDebug,
  DocPage,
  DocSurface,
  FileMetadata,
  FileStore,
  FileSurface,
  IdMapping,
  IdSurface,
  KeyPage,
  KeySurface,
  LedgerSurface,
  MutationCall,
  MutationRecord,
  MutationSurface,
  OneDocWriteCommit,
  PendingUpload,
  RemoteDocDebug,
  RemoteStartOptions,
  RemoteSurface,
  RemoteTick,
  ReadSpec,
  ResultEntry,
  ResultSurface,
  ScheduleSurface,
  ScheduledJob,
  ScheduledFunctionKind,
  ScheduledState,
  StorageBackend,
  StorageRowChange,
  StoreSchema,
  StoredDoc,
  UploadSurface,
  WriteBatch,
} from "./types";

export interface BindingTaggedValue {
  text?: string;
  real?: number;
  int?: string;
  bool?: boolean;
  /** Convex `undefined` (a missing field). All-absent means `null`. */
  undef?: boolean;
}

export interface BindingColValue extends BindingTaggedValue {
  name: string;
}

export interface BindingBound {
  kind: "eq" | "range";
  value?: BindingTaggedValue;
  lower?: BindingTaggedValue;
  lowerInclusive?: boolean;
  upper?: BindingTaggedValue;
  upperInclusive?: boolean;
}

export interface BindingReadSpec {
  table: string;
  index?: string;
  bounds?: BindingBound[];
  order: "asc" | "desc";
  pageSize?: number;
  cursor?: string;
  resumeAfterKey?: BindingTaggedValue[];
}

export interface BindingCountSpec {
  table: string;
  index?: string;
  bounds?: BindingBound[];
}

export interface BindingDocWrite {
  table: string;
  id: string;
  data: string;
  cols: BindingColValue[];
  creationTime: number;
}

export interface BindingWriteBatch {
  docWrites: BindingDocWrite[];
  deletes: { table: string; id: string }[];
  localFieldWrites?: { table: string; id: string; field: string; valueJson: string }[];
  localFieldDeletes?: { table: string; id: string; field: string }[];
  crdtOps?: BindingCrdtOp[];
  crdtRestores?: BindingCrdtRestore[];
  freshIds: { table: string; id: string }[];
  dataOnlyIds?: { table: string; id: string }[];
  idMappings: BindingIdMapping[];
  schedules?: BindingScheduledJob[];
}

export interface BindingCrdtRestore extends BindingCrdtSnapshot {
  table: string;
  id: string;
}

export interface BindingCrdtSnapshot {
  field: string;
  kind: "text" | "count" | "set";
  headSeq: number | bigint;
  projectionHash: string;
  bytes: Uint8Array;
  hash: string;
}

export type BindingCrdtOp =
  | { table: string; id: string; field: string; kind: "count.add"; delta: number }
  | { table: string; id: string; field: string; kind: "set.add"; valueJson: string }
  | { table: string; id: string; field: string; kind: "set.delete"; valueJson: string }
  | {
      table: string;
      id: string;
      field: string;
      kind: "text.splice";
      index: number;
      delete: number;
      insert: string;
    };

export interface BindingCommitOptions {
  includeChanges?: boolean;
  mutationArgs?: string;
  mutationIsFresh?: boolean;
  mutationId?: string;
  mutationName?: string;
  mutationResult?: string;
  pushEnvelopeJson?: string;
  pushEnvelopeNowMs?: number;
  source?: "local" | "remote" | "device";
}

function bindingCommitMutation(options?: CommitOptions): {
  mutationArgs?: string;
  mutationIsFresh?: boolean;
  mutationId?: string;
  mutationName?: string;
  mutationResult?: string;
} {
  if (!options || options.source !== "local" || options.mutation === "none") return {};
  if (options.mutation === "push") return { mutationId: options.mutationId };
  if (options.mutation === "existing") {
    return { mutationId: options.mutationId, mutationResult: options.mutationResult };
  }
  return {
    mutationArgs: options.mutationArgs,
    mutationIsFresh: options.mutationIsFresh,
    mutationId: options.mutationId,
    mutationName: options.mutationName,
    mutationResult: options.mutationResult,
  };
}

function toBindingCommitOptions(options?: CommitOptions): BindingCommitOptions | undefined {
  if (!options) return undefined;
  const mutation = bindingCommitMutation(options);
  const push =
    options.source === "local" && (options.mutation === "terminal" || options.mutation === "push")
      ? options.push
      : undefined;
  return {
    includeChanges: options.changes === "include",
    ...mutation,
    pushEnvelopeJson: push?.json,
    pushEnvelopeNowMs: push?.nowMs,
    source: options.source,
  };
}

export interface BindingCommitResult {
  changedTables: string[];
  changes?: BindingRowChange[];
  commitSeq: bigint | number;
  crdtOps?: BindingCrdtWireOp[];
}

export interface BindingCrdtWireOp {
  table: string;
  id: string;
  field: string;
  kind: string;
  update: string;
}

export interface BindingRowChange {
  id: string;
  op: string;
  row?: string | Record<string, unknown> | null;
  table: string;
}

/**
 * One scan page as a single JSON text: one string crossing and one `JSON.parse` per page.
 * Document pages parse to `StoredDoc[]`; key pages parse to `{ ids, cts }`.
 */
export interface BindingPage {
  text: string;
  cursor?: string | null;
  /** Per-row adoption-version sidecar `{ localId: seq }` (contract §11 D1); absent → version 0. */
  versions?: Record<string, number>;
  localFieldsJson?: string;
}

export interface BindingDeleteResult {
  commitsDeleted: bigint | number;
  mutationsDeleted: bigint | number;
}

export interface BindingMutationCall {
  args: string;
  mutationId: string;
  name: string;
}

export interface BindingMutationRecord {
  commitSeq?: bigint | number | null;
  error?: string | null;
  mutationId: string;
  result?: string | null;
  status: "accepted" | "committed" | "failed";
}

export interface BindingIdMapping {
  table: string;
  localId?: string;
  convexId?: string | null;
  state: "local" | "mapped" | "deleted";
  createdTime?: bigint | number;
  updatedTime?: bigint | number;
}

export interface BindingDirtyHeadDebug {
  table: string;
  id: string;
  op: "write" | "delete";
  firstCommitSeq: bigint | number;
  updatedCommitSeq: bigint | number;
  createdTime: bigint | number;
  updatedTime: bigint | number;
  serverDocumentId?: string | null;
  baseProjectionHash?: string | null;
  baseRootId?: string | null;
  baseNodeId?: string | null;
  logicalClock: number;
}

export interface BindingResultEntry {
  key: string;
  function: string;
  args: string;
  schemaHash: string;
  moduleHash: string;
  skeleton: Uint8Array;
  paths: Uint8Array;
  skeletonHash: string;
  clock: number;
}

export interface BindingRemoteDocDebug {
  table: string;
  localDocumentId: string;
  currentRevId: string;
  serverDocumentId: string;
  projectionHash: string;
  currentRootId?: string | null;
  currentNodeId?: string | null;
  serverBase?: string | null;
  logicalClock: number;
  updatedTime: bigint | number;
}

export interface BindingFileMetadata {
  storageId?: string;
  sha256: string;
  size: bigint | number;
  contentType?: string | null;
  source?: string | null;
  createdTime?: bigint | number;
  updatedTime?: bigint | number;
}

export interface BindingFileStore {
  bytes: Uint8Array;
  metadata: BindingFileMetadata;
}

export interface BindingPendingUpload {
  localStorageId?: string;
  sha256: string;
  size: bigint | number;
  contentType?: string | null;
  state: "pending" | "claimed";
  owner?: string | null;
  leaseUntil?: bigint | number | null;
  createdTime?: bigint | number;
  updatedTime?: bigint | number;
}

export type BindingUploadLeaseWrite =
  | {
      lease: "claimed";
      localStorageId?: string;
      owner: string;
      nowMs: number;
      leaseUntil: number;
    }
  | {
      lease: "pending";
      localStorageId: string;
      owner: string;
      nowMs: number;
    };

export interface BindingScheduledJob {
  jobId?: string;
  kind: ScheduledFunctionKind;
  name: string;
  args: string;
  dueTime?: bigint | number;
  state: ScheduledState;
  leaseUntil?: bigint | number | null;
  createdTime?: bigint | number;
  updatedTime?: bigint | number;
}

/**
 * Raw storage binding shape shared by the NAPI and wasm adapters. Mirrors the napi `Store`
 * surface exactly: the flattened `nounVerb` form of each `noun.verb` operation, every database
 * call asynchronous, and `clockRead` synchronous (clock-only).
 *
 * @internal
 */
export interface StoreBinding {
  setup(schema: StoreSchema): Promise<void>;
  identityRead?(): Promise<string>;
  identityWrite?(identityKey: string, identityJson?: string): Promise<void>;
  mutationWrite(call: BindingMutationCall): Promise<BindingMutationRecord>;
  mutationCacheRead?(call: BindingMutationCall): Promise<BindingMutationRecord>;
  mutationCacheWrite?(call: BindingMutationCall): Promise<BindingMutationRecord>;
  mutationFail(mutationId: string, error: string): Promise<void>;
  clockRead(): number;
  commit(batch: BindingWriteBatch, options?: BindingCommitOptions): Promise<BindingCommitResult>;
  commitOneDocWrite?(
    table: string,
    id: string,
    data: string,
    cols: BindingColValue[],
    creationTime: number,
    source?: "local" | "remote" | "device",
    mutationId?: string,
    mutationName?: string,
    mutationArgs?: string,
    mutationResult?: string,
    includeChanges?: boolean,
    fresh?: boolean,
    dataOnly?: boolean,
    mutationIsFresh?: boolean,
  ): Promise<BindingCommitResult>;
  commitOneDocWriteEncoded?(
    table: string,
    id: string,
    data: string,
    encodedCols: Uint8Array,
    creationTime: number,
    source?: "local" | "remote" | "device",
    mutationId?: string,
    mutationName?: string,
    mutationArgs?: string,
    mutationResult?: string,
    fresh?: boolean,
    dataOnly?: boolean,
    mutationIsFresh?: boolean,
  ): Promise<bigint | number>;
  commitOneDocWriteEncodedDeferred?(
    table: string,
    id: string,
    data: string,
    encodedCols: Uint8Array,
    creationTime: number,
    source?: "local" | "remote" | "device",
    mutationId?: string,
    mutationName?: string,
    mutationArgs?: string,
    mutationResult?: string,
    fresh?: boolean,
    dataOnly?: boolean,
    mutationIsFresh?: boolean,
  ): Promise<bigint | number>;
  docRead(table: string, id: string): Promise<string | undefined | null>;
  localFieldsRead?(table: string, id: string): Promise<string>;
  docVersionRead(table: string, id: string): Promise<number | bigint | undefined | null>;
  crdtHeadRead(
    table: string,
    id: string,
    field: string,
  ): Promise<number | bigint | undefined | null>;
  crdtSnapshotRead(
    table: string,
    id: string,
    ops?: BindingCrdtOp[],
  ): Promise<BindingCrdtSnapshot[]>;
  docPageRead(spec: BindingReadSpec): Promise<BindingPage>;
  keyPageRead(spec: BindingReadSpec): Promise<BindingPage>;
  docCountRead(spec: BindingCountSpec): Promise<number | bigint | null>;
  ledgerDelete(upToSeq: number): Promise<BindingDeleteResult>;
  walWrite(): Promise<void> | void;
  blobRead(key: string): Promise<Uint8Array | null>;
  blobWrite(key: string, bytes: Uint8Array): Promise<void>;
  blobDelete(key: string): Promise<void>;
  resultRead?(key: string): Promise<BindingResultEntry | null | undefined>;
  resultWrite?(entry: BindingResultEntry): Promise<boolean>;
  resultDelete?(key: string): Promise<void>;
  docBaseRead?(table: string, id: string): Promise<string | undefined | null>;
  idWrite(mapping: BindingIdMapping): Promise<void>;
  idRead(table: string, localId: string): Promise<BindingIdMapping | null | undefined>;
  idPageRead(table: string): Promise<BindingIdMapping[]>;
  dirtyHeadsDebugRead?(): Promise<BindingDirtyHeadDebug[]>;
  remoteDocDebugRead?(
    table: string,
    localId: string,
  ): Promise<BindingRemoteDocDebug | null | undefined>;
  idDelete(table: string, localId: string): Promise<void>;
  fileWrite(input: BindingFileStore): Promise<void>;
  fileMetaWrite(metadata: BindingFileMetadata): Promise<void>;
  fileRead(storageId: string): Promise<BindingFileMetadata | null | undefined>;
  fileDelete(storageId: string): Promise<void>;
  uploadWrite(upload: BindingPendingUpload): Promise<void>;
  uploadRead(): Promise<BindingPendingUpload[]>;
  uploadLeaseWrite(args: BindingUploadLeaseWrite): Promise<BindingPendingUpload | null | undefined>;
  uploadComplete(
    localStorageId: string,
    owner: string,
    convexId: string,
    nowMs: number,
  ): Promise<boolean>;
  uploadDelete(localStorageId: string): Promise<void>;
  scheduleWrite(job: BindingScheduledJob): Promise<void>;
  scheduleRead(): Promise<BindingScheduledJob[]>;
  scheduleLeaseWrite(nowMs: number): Promise<BindingScheduledJob | null | undefined>;
  scheduleComplete(
    jobId: string,
    nowMs: number,
  ): Promise<BindingScheduledJob | boolean | null | undefined>;
  scheduleFail(
    jobId: string,
    nowMs: number,
  ): Promise<BindingScheduledJob | boolean | null | undefined>;
  scheduleCancel(
    jobId: string,
    nowMs: number,
  ): Promise<BindingScheduledJob | boolean | null | undefined>;
  remoteStart?(options: RemoteStartOptions): Promise<void>;
  remoteClose?(): Promise<void>;
  remotePull?(localProgress: boolean): Promise<RemoteTick>;
  remoteIdentity?(): Promise<string>;
  remoteDocPush?(
    table: string,
    id: string,
    firstCommitSeq: number,
    updatedCommitSeq: number,
  ): Promise<BindingRemoteDocPush>;
  remoteScopeWrite?(scopeJson: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void> | void;
}

interface BindingRemoteDocPush {
  actorQueueDepth?: number;
  actorQueueMs?: number;
  state: "blocked" | "settled" | "stale";
  tick: RemoteTick;
}

/** Internal read-cache diagnostics consumed by benchmarks. */
export interface ReadCacheStats {
  bytes: number;
  countEntries: number;
  docTableEpochs: Record<string, number>;
  docEntries: number;
  evictions: number;
  globalEpoch: number;
  hits: Record<ReadCacheKind, number>;
  keyEntries: number;
  misses: Record<ReadCacheKind, number>;
  pageEntries: number;
  queryTableEpochs: Record<string, number>;
  unshareableReturns: number;
}

type ReadCacheKind = "count" | "doc" | "key" | "page";

/**
 * Contract adapter that hides raw Rust binding values from the runtime.
 *
 * @internal
 */
function hasMethod(value: object, key: PropertyKey): boolean {
  return typeof Reflect.get(value, key) === "function";
}

export class StoreAdapter implements StorageBackend {
  private readonly inner: StoreBinding;
  private readonly readCache = new ReadCache();
  readonly capabilities = { hasExactBounds: true };
  readonly remote: RemoteSurface | undefined;
  readonly identity: StorageBackend["identity"];

  constructor(inner: StoreBinding) {
    this.inner = inner;
    this.identity = {
      read: async () => {
        if (!inner.identityRead) {
          throw new Error("This storage runtime does not support identity partitions.");
        }
        return JSON.parse(await inner.identityRead()) as {
          identity: import("convex/server").UserIdentity | null;
          identityKey: string;
        };
      },
      write: async (identityKey) => {
        if (!inner.identityWrite) {
          throw new Error("This storage runtime does not support identity partitions.");
        }
        await inner.identityWrite(identityKey);
        this.readCache.clear();
      },
    };
    this.remote =
      inner.remoteStart && inner.remoteClose
        ? {
            start: (options) => this.startRemote(options),
            close: async () => {
              await inner.remoteClose!();
            },
            pull: inner.remotePull
              ? async (localProgress) => {
                  const tick = await inner.remotePull!(localProgress);
                  this.readCache.invalidateTables(remoteTickTables(tick));
                  return tick;
                }
              : undefined,
            identity: inner.remoteIdentity
              ? async () => {
                  const accepted = JSON.parse(
                    await inner.remoteIdentity!(),
                  ) as import("./types").RemoteIdentity;
                  this.readCache.clear();
                  return accepted;
                }
              : undefined,
            doc: inner.remoteDocPush
              ? {
                  push: async (table, id, token) => {
                    const pushed = await inner.remoteDocPush!(
                      table,
                      id,
                      token.firstCommitSeq,
                      token.updatedCommitSeq,
                    );
                    this.readCache.invalidateTables(remoteTickTables(pushed.tick));
                    return pushed;
                  },
                }
              : undefined,
            scope: inner.remoteScopeWrite
              ? { write: async (scope) => await inner.remoteScopeWrite!(JSON.stringify(scope)) }
              : undefined,
          }
        : undefined;
  }

  private async startRemote(options: RemoteStartOptions): Promise<void> {
    const notify = options.notify;
    await this.inner.remoteStart!({
      ...options,
      auth: options.auth ? (args) => Promise.resolve(options.auth?.(args) ?? null) : undefined,
      notify: (tick) => {
        this.readCache.invalidateTables(remoteTickTables(tick));
        notify?.(tick);
      },
    });
  }

  readonly doc: DocSurface = {
    read: async (table, id) => {
      const key = this.readCache.docKey(table, id);
      const cached = this.readCache.readDoc(key);
      if (cached.found) return cached.value;
      const text = await this.inner.docRead(table, id);
      const doc = text ? parseDoc(text) : undefined;
      return this.readCache.writeDoc(key, doc);
    },
    device: {
      read: async (table, id) => {
        if (!this.inner.localFieldsRead) return {};
        const fields = JSON.parse(await this.inner.localFieldsRead(table, id)) as Record<
          string,
          unknown
        >;
        reviveDoc(fields);
        return fields;
      },
    },
    version: {
      read: async (table, id) => {
        const seq = await this.inner.docVersionRead(table, id);
        return seq === null || seq === undefined ? undefined : Number(seq);
      },
    },
    crdt: {
      read: async (table, id, field) => {
        const seq = await this.inner.crdtHeadRead(table, id, field);
        return seq === null || seq === undefined ? undefined : Number(seq);
      },
      snapshot: {
        read: async (table, id, ops) => {
          const snapshots = await this.inner.crdtSnapshotRead(table, id, ops?.map(toBindingCrdtOp));
          return snapshots.map((snapshot) => ({
            field: snapshot.field,
            kind: snapshot.kind,
            headSeq: Number(snapshot.headSeq),
            projectionHash: snapshot.projectionHash,
            bytes: snapshot.bytes.buffer.slice(
              snapshot.bytes.byteOffset,
              snapshot.bytes.byteOffset + snapshot.bytes.byteLength,
            ) as ArrayBuffer,
            hash: snapshot.hash,
          }));
        },
      },
    },
    page: {
      read: async (spec) => {
        const key = this.readCache.pageKey(spec);
        const cached = this.readCache.readPage(key);
        if (cached) return cached;
        const bindingSpec = this.toBindingReadSpec(spec);
        const page = await this.inner.docPageRead(bindingSpec);
        const docs = parseDocs(page.text);
        return this.readCache.writePage(key, {
          docs,
          cursor: page.cursor ?? null,
          ...(page.versions === undefined ? {} : { versions: page.versions }),
          ...(page.localFieldsJson === undefined
            ? {}
            : {
                deviceFields: parseDeviceFields(page.localFieldsJson),
              }),
        });
      },
    },
    count: {
      read: async (spec) => {
        const key = this.readCache.countKey(spec);
        const cached = this.readCache.readCount(key);
        if (cached.found) return cached.value;
        const bindingSpec = this.toBindingCountSpec(spec);
        const n = await this.inner.docCountRead(bindingSpec);
        const count = n === null ? null : Number(n);
        return this.readCache.writeCount(key, count);
      },
    },
    base: {
      read: async (table, id) => {
        const text = await this.inner.docBaseRead?.(table, id);
        return text ? parseDoc(text) : undefined;
      },
    },
  };

  readonly result: ResultSurface = {
    read: async (key) => {
      const entry = await this.inner.resultRead?.(key);
      return entry ? fromBindingResultEntry(entry) : undefined;
    },
    write: async (entry) => (await this.inner.resultWrite?.(toBindingResultEntry(entry))) ?? false,
    delete: async (key) => {
      await this.inner.resultDelete?.(key);
    },
  };

  readonly key: KeySurface = {
    page: {
      read: async (spec) => {
        const key = this.readCache.keyKey(spec);
        const cached = this.readCache.readKey(key);
        if (cached) return cached;
        const bindingSpec = this.toBindingReadSpec(spec);
        const page = await this.inner.keyPageRead(bindingSpec);
        const keys = JSON.parse(page.text) as { ids: string[]; cts: number[] };
        return this.readCache.writeKey(key, {
          ids: keys.ids,
          creationTimes: keys.cts,
          cursor: page.cursor ?? null,
        });
      },
    },
  };

  readonly clock: ClockSurface = {
    read: () => this.inner.clockRead(),
  };

  readonly mutation: MutationSurface = {
    write: async (call: MutationCall, options?: { fresh?: boolean }) => {
      const bindingCall = {
        args: call.args,
        mutationId: call.mutationId,
        name: call.name,
      };
      if (options?.fresh && this.inner.mutationCacheWrite) {
        return fromBindingMutationRecord(await this.inner.mutationCacheWrite(bindingCall));
      }
      const record = this.inner.mutationCacheRead
        ? await this.inner.mutationCacheRead(bindingCall)
        : await this.inner.mutationWrite(bindingCall);
      return fromBindingMutationRecord(record);
    },
    fail: async (mutationId, error) => {
      await this.inner.mutationFail(mutationId, error);
    },
  };

  readonly ledger: LedgerSurface = {
    delete: async (upToSeq) => {
      const result = await this.inner.ledgerDelete(upToSeq);
      return {
        commitsDeleted: Number(result.commitsDeleted),
        mutationsDeleted: Number(result.mutationsDeleted),
      };
    },
  };

  readonly blob: BlobSurface = {
    read: async (key) => {
      const bytes = await this.inner.blobRead(key);
      if (bytes === null) return null;
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    write: (key, bytes) => this.inner.blobWrite(key, bytes),
    delete: (key) => this.inner.blobDelete(key),
  };

  readonly id: IdSurface = {
    write: (mapping) => this.inner.idWrite(toBindingIdMapping(mapping)),
    read: async (table, localId) => {
      const row = await this.inner.idRead(table, localId);
      return row ? fromBindingIdMapping(row) : undefined;
    },
    page: {
      read: async (table) => (await this.inner.idPageRead(table)).map(fromBindingIdMapping),
    },
    delete: (table, localId) => this.inner.idDelete(table, localId),
  };

  readonly file: FileSurface = {
    write: (input) => this.inner.fileWrite(toBindingFileStore(input)),
    meta: {
      write: (metadata) => this.inner.fileMetaWrite(toBindingFileMetadata(metadata)),
    },
    read: async (storageId) => {
      const row = await this.inner.fileRead(storageId);
      return row ? fromBindingFileMetadata(row) : undefined;
    },
    delete: (storageId) => this.inner.fileDelete(storageId),
  };

  readonly upload: UploadSurface = {
    write: (upload) => this.inner.uploadWrite(toBindingPendingUpload(upload)),
    read: async () => (await this.inner.uploadRead()).map(fromBindingPendingUpload),
    lease: {
      write: async (args) => {
        const row = await this.inner.uploadLeaseWrite(args);
        return row ? fromBindingPendingUpload(row) : undefined;
      },
    },
    complete: (localStorageId, owner, convexId, nowMs) =>
      this.inner.uploadComplete(localStorageId, owner, convexId, nowMs),
    delete: (localStorageId) => this.inner.uploadDelete(localStorageId),
  };

  readonly schedule: ScheduleSurface = {
    write: (job) => this.inner.scheduleWrite(toBindingScheduledJob(job)),
    read: async () => (await this.inner.scheduleRead()).map(fromBindingScheduledJob),
    lease: {
      write: async (nowMs) => {
        const row = await this.inner.scheduleLeaseWrite(nowMs);
        return row ? fromBindingScheduledJob(row) : undefined;
      },
    },
    complete: async (jobId, nowMs) => {
      const row = await this.inner.scheduleComplete(jobId, nowMs);
      return this.fromScheduleTransition(jobId, row);
    },
    fail: async (jobId, nowMs) => {
      const row = await this.inner.scheduleFail(jobId, nowMs);
      return this.fromScheduleTransition(jobId, row);
    },
    cancel: async (jobId, nowMs) => {
      const row = await this.inner.scheduleCancel(jobId, nowMs);
      return this.fromScheduleTransition(jobId, row);
    },
  };

  async setup(schema: StoreSchema): Promise<void> {
    await this.inner.setup(schema);
    this.readCache.clear();
  }

  async commit(batch: WriteBatch, options?: CommitOptions): Promise<CommitResult> {
    const bindingBatch = {
      docWrites: batch.docWrites.map((docWrite) => ({
        table: docWrite.table,
        id: docWrite.id,
        data: encodeDocData(docWrite.data),
        cols: toBindingColValues(docWrite.cols),
        creationTime: docWrite.creationTime,
      })),
      crdtOps: (batch.crdtOps ?? []).map(toBindingCrdtOp),
      crdtRestores: (batch.crdtRestores ?? []).map((restore) => ({
        ...restore,
        bytes: new Uint8Array(restore.bytes),
      })),
      deletes: batch.deletes,
      localFieldWrites: (batch.localFieldWrites ?? []).map((write) => ({
        table: write.table,
        id: write.id,
        field: write.field,
        valueJson: encode(write.value),
      })),
      localFieldDeletes: batch.localFieldDeletes ?? [],
      freshIds: batch.freshIds ?? [],
      dataOnlyIds: batch.dataOnlyIds ?? [],
      idMappings: (batch.idMappings ?? []).map(toBindingIdMapping),
      schedules: (batch.schedules ?? []).map(toBindingScheduledJob),
    };
    const bindingOptions = toBindingCommitOptions(options);
    const result = await this.inner.commit(bindingBatch, bindingOptions);
    const commit = fromBindingCommitResult(result);
    this.applyCommitCaches(commit, batch);
    return commit;
  }

  async commitOneDocWrite(
    commit: OneDocWriteCommit,
    options?: CommitOptions,
  ): Promise<CommitResult> {
    const docWrite = commit.docWrite;
    const hasFastPath =
      options?.changes === "omit"
        ? hasMethod(this.inner, "commitOneDocWriteEncodedDeferred") ||
          hasMethod(this.inner, "commitOneDocWriteEncoded")
        : hasMethod(this.inner, "commitOneDocWrite");
    if (!hasFastPath) {
      const row = { table: docWrite.table, id: docWrite.id };
      return await this.commit(
        {
          docWrites: [docWrite],
          deletes: [],
          freshIds: commit.fresh ? [row] : [],
          dataOnlyIds: commit.dataOnly ? [row] : [],
        },
        options,
      );
    }
    const data = encodeDocData(docWrite.data);
    const mutation = bindingCommitMutation(options);
    if (options?.changes === "omit") {
      const encodedCols = commit.dataOnly ? EMPTY_ENCODED_COL_KEYS : encodeColKeys(docWrite.cols);
      const commitSeq = this.inner.commitOneDocWriteEncodedDeferred
        ? await this.inner.commitOneDocWriteEncodedDeferred(
            docWrite.table,
            docWrite.id,
            data,
            encodedCols,
            docWrite.creationTime,
            options.source,
            mutation.mutationId,
            mutation.mutationName,
            mutation.mutationArgs,
            mutation.mutationResult,
            commit.fresh,
            commit.dataOnly,
            mutation.mutationIsFresh,
          )
        : await this.inner.commitOneDocWriteEncoded?.(
            docWrite.table,
            docWrite.id,
            data,
            encodedCols,
            docWrite.creationTime,
            options.source,
            mutation.mutationId,
            mutation.mutationName,
            mutation.mutationArgs,
            mutation.mutationResult,
            commit.fresh,
            commit.dataOnly,
            mutation.mutationIsFresh,
          );
      if (commitSeq === undefined) throw new Error("storage fast path returned no commit sequence");
      const resultCommit = {
        changedTables: [docWrite.table],
        changes: [],
        commitSeq: safeCommitSeq(commitSeq),
      };
      this.applyOneDocWriteCommitCaches(resultCommit, commit);
      return resultCommit;
    }
    if (!this.inner.commitOneDocWrite) throw new Error("storage fast path is unavailable");
    const cols = toBindingColValues(docWrite.cols);
    const result = await this.inner.commitOneDocWrite(
      docWrite.table,
      docWrite.id,
      data,
      cols,
      docWrite.creationTime,
      options?.source,
      mutation.mutationId,
      mutation.mutationName,
      mutation.mutationArgs,
      mutation.mutationResult,
      true,
      commit.fresh,
      commit.dataOnly,
      mutation.mutationIsFresh,
    );
    const resultCommit = fromBindingCommitResult(result);
    this.applyOneDocWriteCommitCaches(resultCommit, commit);
    return resultCommit;
  }

  async clear(): Promise<void> {
    await this.inner.clear();
    this.readCache.clear();
  }

  close(): Promise<void> {
    return Promise.resolve(this.inner.close());
  }

  readonly wal = { write: (): Promise<void> => Promise.resolve(this.inner.walWrite()) };

  readCacheStats(): ReadCacheStats {
    return this.readCache.stats();
  }

  async dirtyHeadsDebugRead(): Promise<DirtyHeadDebug[]> {
    const heads = await (this.inner.dirtyHeadsDebugRead?.() ?? Promise.resolve([]));
    return heads.map(fromBindingDirtyHeadDebug);
  }

  async remoteDocDebugRead(table: string, localId: string): Promise<RemoteDocDebug | undefined> {
    const state = await (this.inner.remoteDocDebugRead?.(table, localId) ??
      Promise.resolve(undefined));
    return state ? fromBindingProjectionDebug(state) : undefined;
  }

  clearReadCacheForBench(): void {
    this.readCache.clear();
  }

  private toBindingReadSpec(spec: ReadSpec): BindingReadSpec {
    return {
      table: spec.table,
      index: spec.index,
      bounds: this.toBindingBounds(spec.table, spec.index, spec.bounds),
      order: spec.order,
      pageSize: spec.pageSize,
      cursor: spec.cursor,
      resumeAfterKey: spec.resumeAfterKey && spec.resumeAfterKey.map(toBindingValue),
    };
  }

  private toBindingCountSpec(spec: CountSpec): BindingCountSpec {
    return {
      table: spec.table,
      index: spec.index,
      bounds: this.toBindingBounds(spec.table, spec.index, spec.bounds),
    };
  }

  private applyCommitCaches(commit: CommitResult, batch: WriteBatch): void {
    if (this.readCache.hasQueryEntries()) {
      if (isDataOnlyQueryCacheSafe(batch)) {
        this.readCache.writePageDocs(batch.docWrites.map(docWriteToStoredDoc));
      } else {
        this.readCache.invalidateTableQueries(commit.changedTables);
      }
    }
    const freshIds =
      batch.freshIds && batch.freshIds.length > 0
        ? new Set(batch.freshIds.map((row) => `${row.table}\0${row.id}`))
        : undefined;
    for (const deleteRow of batch.deletes) {
      this.readCache.deleteDoc(this.readCache.docKey(deleteRow.table, deleteRow.id));
    }
    for (const docWrite of batch.docWrites) {
      if (freshIds?.has(`${docWrite.table}\0${docWrite.id}`)) continue;
      this.readCache.writeDoc(
        this.readCache.docKey(docWrite.table, docWrite.id),
        docWriteToStoredDoc(docWrite),
      );
    }
  }

  private applyOneDocWriteCommitCaches(commit: CommitResult, one: OneDocWriteCommit): void {
    if (this.readCache.hasQueryEntries()) {
      if (one.dataOnly === true) {
        this.readCache.writePageDocs([docWriteToStoredDoc(one.docWrite)]);
      } else {
        this.readCache.invalidateTableQueries(commit.changedTables);
      }
    }
    if (one.fresh !== true) {
      this.readCache.writeDoc(
        this.readCache.docKey(one.docWrite.table, one.docWrite.id),
        docWriteToStoredDoc(one.docWrite),
      );
    }
  }

  private async fromScheduleTransition(
    jobId: string,
    row: BindingScheduledJob | boolean | null | undefined,
  ): Promise<ScheduledJob | undefined> {
    if (!row) return undefined;
    if (row === true) {
      const rows = await this.inner.scheduleRead();
      const found = rows.find((job) => job.jobId === jobId);
      return found ? fromBindingScheduledJob(found) : undefined;
    }
    return fromBindingScheduledJob(row);
  }

  private toBindingBounds(
    tableName: string,
    indexName: string | undefined,
    bounds: Bound[] | undefined,
  ): BindingBound[] | undefined {
    if (!bounds) return undefined;
    if (!indexName) {
      throw new Error(`missing index for bounds on ${tableName}`);
    }
    return bounds.map((bound) =>
      bound.kind === "eq"
        ? { kind: "eq", value: toBindingValue(bound.value) }
        : {
            kind: "range",
            lower: bound.lower === undefined ? undefined : toBindingValue(bound.lower),
            lowerInclusive: bound.lowerInclusive,
            upper: bound.upper === undefined ? undefined : toBindingValue(bound.upper),
            upperInclusive: bound.upperInclusive,
          },
    );
  }
}

function isDataOnlyQueryCacheSafe(batch: WriteBatch): boolean {
  if ((batch.localFieldWrites?.length ?? 0) > 0) return false;
  if ((batch.localFieldDeletes?.length ?? 0) > 0) return false;
  if (batch.docWrites.length === 0 || batch.deletes.length > 0) return false;
  if ((batch.crdtOps?.length ?? 0) > 0) return false;
  if ((batch.freshIds?.length ?? 0) > 0) return false;
  const dataOnlyIds = batch.dataOnlyIds ?? [];
  if (dataOnlyIds.length !== batch.docWrites.length) return false;
  const dataOnly = new Set(dataOnlyIds.map((row) => `${row.table}\0${row.id}`));
  return batch.docWrites.every((docWrite) => dataOnly.has(`${docWrite.table}\0${docWrite.id}`));
}

function docWriteToStoredDoc(docWrite: WriteBatch["docWrites"][number]): StoredDoc {
  return {
    _creationTime: docWrite.creationTime,
    _id: docWrite.id,
    ...docWrite.data,
  };
}

function fromBindingMutationRecord(record: BindingMutationRecord): MutationRecord {
  if (!record.mutationId) throw new Error("storage mutation record is missing mutationId");
  const commitSeq = record.commitSeq ?? undefined;
  return {
    commitSeq: commitSeq === undefined ? undefined : safeCommitSeq(commitSeq),
    error: record.error ?? undefined,
    mutationId: record.mutationId,
    result: record.result ?? undefined,
    status: record.status,
  };
}

function fromBindingCommitResult(result: BindingCommitResult): CommitResult {
  const crdtOps = (result.crdtOps ?? []).map(fromBindingCrdtWireOp);
  return {
    changedTables: result.changedTables,
    changes: (result.changes ?? []).map(fromBindingRowChange),
    commitSeq: safeCommitSeq(result.commitSeq),
    ...(crdtOps.length > 0 ? { crdtOps } : {}),
  };
}

function fromBindingCrdtWireOp(op: BindingCrdtWireOp): CommitCrdtWireOp {
  if (op.kind !== "text" && op.kind !== "count" && op.kind !== "set") {
    throw new Error(`unknown crdt wire op kind: ${op.kind}`);
  }
  return { table: op.table, id: op.id, field: op.field, kind: op.kind, update: op.update };
}

function fromBindingRowChange(change: BindingRowChange): StorageRowChange {
  if (change.op === "delete") return { id: change.id, op: "delete", table: change.table };
  if (change.op !== "write") throw new Error(`unknown storage row change op: ${change.op}`);
  const row =
    typeof change.row === "string"
      ? (JSON.parse(change.row) as Record<string, unknown>)
      : change.row;
  if (!row || typeof row !== "object") {
    throw new Error(`storage row change for ${change.table}:${change.id} is missing row`);
  }
  reviveDoc(row);
  return { id: change.id, op: "write", row, table: change.table };
}

function toBindingIdMapping(mapping: IdMapping): BindingIdMapping {
  return {
    table: mapping.table,
    localId: mapping.localId,
    convexId: "convexId" in mapping ? mapping.convexId : undefined,
    state: mapping.mapping,
    createdTime: mapping.createdTime,
    updatedTime: mapping.updatedTime,
  };
}

function toBindingCrdtOp(op: NonNullable<WriteBatch["crdtOps"]>[number]): BindingCrdtOp {
  switch (op.kind) {
    case "count.add":
      return op;
    case "set.add":
    case "set.delete":
      return {
        field: op.field,
        id: op.id,
        kind: op.kind,
        table: op.table,
        valueJson: encode(op.value),
      };
    case "text.splice":
      return op;
  }
}

function fromBindingIdMapping(mapping: BindingIdMapping): IdMapping {
  const base = {
    table: mapping.table,
    localId: requiredString(mapping.localId, "id mapping localId"),
    createdTime: safeInteger(mapping.createdTime, "id mapping createdTime"),
    updatedTime: safeInteger(mapping.updatedTime, "id mapping updatedTime"),
  };
  if (mapping.state === "local") {
    if (mapping.convexId != null) throw new Error("local ID mapping cannot contain convexId");
    return { ...base, mapping: "local" };
  }
  if (mapping.state === "mapped") {
    if (mapping.convexId == null) throw new Error("mapped ID mapping requires convexId");
    return { ...base, mapping: "mapped", convexId: mapping.convexId };
  }
  return {
    ...base,
    mapping: "deleted",
    ...(mapping.convexId == null ? {} : { convexId: mapping.convexId }),
  };
}

function fromBindingResultEntry(entry: BindingResultEntry): ResultEntry {
  return {
    key: entry.key,
    function: entry.function,
    args: entry.args,
    schemaHash: entry.schemaHash,
    moduleHash: entry.moduleHash,
    skeleton: new Uint8Array(
      entry.skeleton.buffer,
      entry.skeleton.byteOffset,
      entry.skeleton.byteLength,
    ),
    paths: new Uint8Array(entry.paths.buffer, entry.paths.byteOffset, entry.paths.byteLength),
    skeletonHash: entry.skeletonHash,
    clock: entry.clock,
  };
}

function toBindingResultEntry(entry: ResultEntry): BindingResultEntry {
  return {
    key: entry.key,
    function: entry.function,
    args: entry.args,
    schemaHash: entry.schemaHash,
    moduleHash: entry.moduleHash,
    skeleton: entry.skeleton,
    paths: entry.paths,
    skeletonHash: entry.skeletonHash,
    clock: entry.clock,
  };
}

function fromBindingDirtyHeadDebug(head: BindingDirtyHeadDebug): DirtyHeadDebug {
  return {
    table: head.table,
    id: head.id,
    op: head.op,
    firstCommitSeq: safeInteger(head.firstCommitSeq, "dirty head firstCommitSeq"),
    updatedCommitSeq: safeInteger(head.updatedCommitSeq, "dirty head updatedCommitSeq"),
    createdTime: safeInteger(head.createdTime, "dirty head createdTime"),
    updatedTime: safeInteger(head.updatedTime, "dirty head updatedTime"),
    serverDocumentId: head.serverDocumentId ?? undefined,
    baseProjectionHash: head.baseProjectionHash ?? undefined,
    baseRootId: head.baseRootId ?? undefined,
    baseNodeId: head.baseNodeId ?? undefined,
    logicalClock: head.logicalClock,
  };
}

function fromBindingProjectionDebug(state: BindingRemoteDocDebug): RemoteDocDebug {
  return {
    table: state.table,
    localDocumentId: state.localDocumentId,
    currentRevId: state.currentRevId,
    serverDocumentId: state.serverDocumentId,
    projectionHash: state.projectionHash,
    currentRootId: state.currentRootId ?? undefined,
    currentNodeId: state.currentNodeId ?? undefined,
    serverBase: state.serverBase ?? undefined,
    logicalClock: state.logicalClock,
    updatedTime: safeInteger(state.updatedTime, "projection updatedTime"),
  };
}

function toBindingFileMetadata(metadata: FileMetadata): BindingFileMetadata {
  return {
    storageId: metadata.storageId,
    sha256: metadata.sha256,
    size: metadata.size,
    contentType: metadata.contentType,
    source: metadata.source,
    createdTime: metadata.createdTime,
    updatedTime: metadata.updatedTime,
  };
}

function toBindingFileStore(input: FileStore): BindingFileStore {
  return {
    bytes: input.bytes,
    metadata: toBindingFileMetadata(input.metadata),
  };
}

function fromBindingFileMetadata(metadata: BindingFileMetadata): FileMetadata {
  return {
    storageId: requiredString(metadata.storageId, "file storageId"),
    sha256: metadata.sha256,
    size: safeInteger(metadata.size, "file size"),
    contentType: metadata.contentType ?? undefined,
    source: metadata.source ?? undefined,
    createdTime: safeInteger(metadata.createdTime, "file createdTime"),
    updatedTime: safeInteger(metadata.updatedTime, "file updatedTime"),
  };
}

function toBindingPendingUpload(upload: PendingUpload): BindingPendingUpload {
  const claimed = upload.lease === "claimed" ? upload : undefined;
  return {
    localStorageId: upload.localStorageId,
    sha256: upload.sha256,
    size: upload.size,
    contentType: upload.contentType,
    state: upload.lease,
    owner: claimed?.owner,
    leaseUntil: claimed?.leaseUntil,
    createdTime: upload.createdTime,
    updatedTime: upload.updatedTime,
  };
}

function fromBindingPendingUpload(upload: BindingPendingUpload): PendingUpload {
  const base = {
    localStorageId: requiredString(upload.localStorageId, "upload localStorageId"),
    sha256: upload.sha256,
    size: safeInteger(upload.size, "upload size"),
    contentType: upload.contentType ?? undefined,
    createdTime: safeInteger(upload.createdTime, "upload createdTime"),
    updatedTime: safeInteger(upload.updatedTime, "upload updatedTime"),
  };
  const owner = upload.owner ?? undefined;
  const leaseUntil = optionalSafeInteger(upload.leaseUntil, "upload leaseUntil");
  if (upload.state === "pending" && owner === undefined && leaseUntil === undefined) {
    return { ...base, lease: "pending" };
  }
  if (upload.state === "claimed" && owner !== undefined && leaseUntil !== undefined) {
    return { ...base, lease: "claimed", owner, leaseUntil };
  }
  throw new Error(`Invalid upload lease for state ${upload.state}.`);
}

function toBindingScheduledJob(job: ScheduledJob): BindingScheduledJob {
  const leaseUntil = job.state === "running" ? job.leaseUntil : undefined;
  return {
    jobId: job.jobId,
    kind: job.kind,
    name: job.name,
    args: job.args,
    dueTime: job.dueTime,
    state: job.state,
    leaseUntil,
    createdTime: job.createdTime,
    updatedTime: job.updatedTime,
  };
}

function fromBindingScheduledJob(job: BindingScheduledJob): ScheduledJob {
  const base = {
    jobId: requiredString(job.jobId, "scheduled jobId"),
    kind: job.kind,
    name: job.name,
    args: job.args,
    dueTime: safeInteger(job.dueTime, "scheduled dueTime"),
    createdTime: safeInteger(job.createdTime, "scheduled createdTime"),
    updatedTime: safeInteger(job.updatedTime, "scheduled updatedTime"),
  };
  const leaseUntil = optionalSafeInteger(job.leaseUntil, "scheduled leaseUntil");
  if (job.state === "running" && leaseUntil !== undefined) {
    return { ...base, state: "running", leaseUntil };
  }
  if (job.state !== "running" && leaseUntil === undefined) {
    return { ...base, state: job.state };
  }
  throw new Error(`Invalid scheduled lease for state ${job.state}.`);
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`storage ${name} is missing`);
  return value;
}

function optionalSafeInteger(
  value: bigint | number | null | undefined,
  name: string,
): number | undefined {
  return value === null || value === undefined ? undefined : safeInteger(value, name);
}

function safeInteger(value: bigint | number | undefined, name: string): number {
  if (value === undefined) throw new Error(`storage ${name} is missing`);
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`storage ${name} exceeds safe integer range: ${value}`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`storage ${name} is not a safe integer: ${String(value)}`);
  }
  return value;
}

function safeCommitSeq(commitSeq: bigint | number): number {
  if (typeof commitSeq === "bigint") {
    if (commitSeq > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`storage commitSeq exceeds Number.MAX_SAFE_INTEGER: ${commitSeq}`);
    }
    return Number(commitSeq);
  }
  if (!Number.isSafeInteger(commitSeq)) {
    throw new Error(`storage commitSeq is not a safe integer: ${String(commitSeq)}`);
  }
  return commitSeq;
}

/** One parse and one in-place revive per page — never one per document. */
/**
 * Encodes a document body to its JSON string for storage, asserting the splice invariant the page
 * protocol relies on: every stored doc is a JSON object (`{…}`), so the backend can concatenate
 * rows into one `[{…},{…}]` page string. Checking at commit turns a would-be scan-time page
 * corruption into an immediate, localized error.
 */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

function encodeDocData(data: Parameters<typeof encode>[0]): string {
  const encoded = encode(data);
  if (encoded.charCodeAt(0) !== 0x7b) {
    throw new Error(`stored document data must be a JSON object, got: ${encoded.slice(0, 32)}`);
  }
  if (encoded.length > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `document exceeds the maximum size of ${MAX_DOCUMENT_BYTES} bytes (got ${encoded.length}).`,
    );
  }
  return encoded;
}

function parseDocs(text: string): StoredDoc[] {
  const docs = JSON.parse(text) as StoredDoc[];
  for (const doc of docs) reviveDoc(doc);
  return docs;
}

function parseDeviceFields(text: string): Record<string, Record<string, unknown>> {
  const rows = JSON.parse(text) as Record<string, Record<string, unknown>>;
  for (const fields of Object.values(rows)) reviveDoc(fields);
  return rows;
}

function parseDoc(text: string): StoredDoc {
  const doc = JSON.parse(text) as StoredDoc;
  reviveDoc(doc);
  return doc;
}

function cacheKey(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? { $integer: child.toString() } : child,
  );
}

function toBindingColValue(name: string, value: ColValue): BindingColValue {
  const tagged = toBindingValue(value) as BindingColValue;
  tagged.name = name;
  return tagged;
}

function toBindingColValues(cols: ColValues): BindingColValue[] {
  const entries = Array.isArray(cols) ? cols : Object.entries(cols);
  return entries.map(([name, value]) => toBindingColValue(name, value));
}

const EMPTY_ENCODED_COL_KEYS = new Uint8Array([0, 0, 0, 0]);
const KEY_ENCODER = new TextEncoder();
const SIGN_BIT = 1n << 63n;
const U64_MASK = (1n << 64n) - 1n;
const FLOAT_SCRATCH = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_SCRATCH);

function encodeColKeys(cols: ColValues): Uint8Array {
  const entries = Array.isArray(cols) ? cols : Object.entries(cols);
  const keys = entries.map(([, value]) => encodeColKey(value));
  let total = 4;
  for (const key of keys) total += 4 + key.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, keys.length, true);
  offset += 4;
  for (const key of keys) {
    view.setUint32(offset, key.length, true);
    offset += 4;
    out.set(key, offset);
    offset += key.length;
  }
  return out;
}

function encodeColKey(value: ColValue): Uint8Array {
  if (value === undefined) return new Uint8Array([0x00]);
  if (value === null) return new Uint8Array([0x01]);
  if (typeof value === "bigint") {
    const out = new Uint8Array(9);
    out[0] = 0x02;
    writeU64BE(out, 1, BigInt.asUintN(64, value) ^ SIGN_BIT);
    return out;
  }
  if (typeof value === "number") {
    FLOAT_VIEW.setFloat64(0, value, false);
    const bits = FLOAT_VIEW.getBigUint64(0, false);
    const key = (bits & SIGN_BIT) !== 0n ? ~bits & U64_MASK : bits ^ SIGN_BIT;
    const out = new Uint8Array(9);
    out[0] = 0x03;
    writeU64BE(out, 1, key);
    return out;
  }
  if (typeof value === "boolean") return new Uint8Array([0x04, value ? 1 : 0]);
  const text = KEY_ENCODER.encode(value);
  const out = new Uint8Array(1 + text.length);
  out[0] = 0x05;
  out.set(text, 1);
  return out;
}

function writeU64BE(out: Uint8Array, offset: number, value: bigint): void {
  for (let index = 7; index >= 0; index -= 1) {
    out[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

/**
 * Tag a value for the order-key encoder, dispatched purely on JS type (index columns carry no
 * affinity): a `number` is a Convex float64, a `bigint` is int64, etc. `undefined` (a missing
 * field) and `null` are distinct. NaN/±Infinity/-0 are valid floats.
 */
function toBindingValue(value: ColValue): BindingTaggedValue {
  if (value === undefined) return { undef: true };
  if (value === null) return {};
  if (typeof value === "string") return { text: value };
  if (typeof value === "boolean") return { bool: value };
  if (typeof value === "bigint") return { int: checkedI64(value).toString() };
  if (typeof value === "number") return { real: value };
  throw new Error(`unsupported index value: ${String(value)}`);
}

function checkedI64(value: bigint): bigint {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (value < min || value > max) throw new Error(`bigint out of i64 range: ${value}`);
  return value;
}

const READ_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

interface CachedValue<T> {
  bytes: number;
  shareable: boolean;
  value: T;
}

interface CacheLookup<T> {
  found: boolean;
  value: T;
}

class ReadCache {
  private bytes = 0;
  private evictions = 0;
  private globalEpoch = 0;
  private readonly count = new Map<string, CachedValue<number | null>>();
  private readonly doc = new Map<string, CachedValue<StoredDoc | undefined>>();
  private readonly hits: Record<ReadCacheKind, number> = { count: 0, doc: 0, key: 0, page: 0 };
  private readonly key = new Map<string, CachedValue<KeyPage>>();
  private readonly misses: Record<ReadCacheKind, number> = { count: 0, doc: 0, key: 0, page: 0 };
  private readonly page = new Map<string, CachedValue<DocPage>>();
  private readonly docTableEpochs = new Map<string, number>();
  private readonly queryTableEpochs = new Map<string, number>();
  private unshareableReturns = 0;

  docKey(table: string, id: string): string {
    return `doc\0${this.globalEpoch}\0${this.docTableEpoch(table)}\0${table}\0${id}`;
  }

  pageKey(spec: ReadSpec): string {
    return this.tableKey("page", spec.table, cacheKey(spec));
  }

  keyKey(spec: ReadSpec): string {
    return this.tableKey("key", spec.table, cacheKey(spec));
  }

  countKey(spec: CountSpec): string {
    return this.tableKey("count", spec.table, cacheKey(spec));
  }

  readDoc(key: string): CacheLookup<StoredDoc | undefined> {
    return this.get(this.doc, key, "doc");
  }

  writeDoc(key: string, value: StoredDoc | undefined): StoredDoc | undefined {
    return this.write(this.doc, key, value);
  }

  deleteDoc(key: string): void {
    this.delete(this.doc, key);
  }

  readPage(key: string): DocPage | undefined {
    const lookup = this.get(this.page, key, "page");
    return lookup.found ? lookup.value : undefined;
  }

  writePage(key: string, value: DocPage): DocPage {
    return this.write(this.page, key, value);
  }

  writePageDocs(rows: StoredDoc[]): void {
    if (!rows.length || this.page.size === 0) return;
    const byId = new Map(rows.map((row) => [row._id, row]));
    const updates: [string, DocPage][] = [];
    for (const [key, entry] of this.page) {
      let changed = false;
      const docs = entry.value.docs.map((doc) => {
        const row = byId.get(doc._id);
        if (!row) return doc;
        changed = true;
        return row;
      });
      if (changed) updates.push([key, { cursor: entry.value.cursor, docs }]);
    }
    for (const [key, page] of updates) this.write(this.page, key, page);
  }

  readKey(key: string): KeyPage | undefined {
    const lookup = this.get(this.key, key, "key");
    return lookup.found ? lookup.value : undefined;
  }

  writeKey(key: string, value: KeyPage): KeyPage {
    return this.write(this.key, key, value);
  }

  readCount(key: string): CacheLookup<number | null> {
    return this.get(this.count, key, "count");
  }

  writeCount(key: string, value: number | null): number | null {
    return this.write(this.count, key, value);
  }

  hasQueryEntries(): boolean {
    return this.count.size > 0 || this.key.size > 0 || this.page.size > 0;
  }

  invalidateTables(tables: Iterable<string>): void {
    for (const table of new Set(tables)) {
      this.docTableEpochs.set(table, this.docTableEpoch(table) + 1);
      if (this.hasQueryEntries()) {
        this.queryTableEpochs.set(table, this.queryTableEpoch(table) + 1);
      }
    }
  }

  invalidateTableQueries(tables: Iterable<string>): void {
    if (!this.hasQueryEntries()) return;
    for (const table of new Set(tables)) {
      this.queryTableEpochs.set(table, this.queryTableEpoch(table) + 1);
    }
  }

  clear(): void {
    this.bytes = 0;
    this.globalEpoch += 1;
    this.count.clear();
    this.doc.clear();
    this.key.clear();
    this.page.clear();
    this.docTableEpochs.clear();
    this.queryTableEpochs.clear();
  }

  stats(): ReadCacheStats {
    return {
      bytes: this.bytes,
      countEntries: this.count.size,
      docTableEpochs: Object.fromEntries(this.docTableEpochs),
      docEntries: this.doc.size,
      evictions: this.evictions,
      globalEpoch: this.globalEpoch,
      hits: { ...this.hits },
      keyEntries: this.key.size,
      misses: { ...this.misses },
      pageEntries: this.page.size,
      queryTableEpochs: Object.fromEntries(this.queryTableEpochs),
      unshareableReturns: this.unshareableReturns,
    };
  }

  private get<T>(
    map: Map<string, CachedValue<T>>,
    key: string,
    kind: ReadCacheKind,
  ): CacheLookup<T> {
    const entry = map.get(key);
    if (!entry) {
      this.misses[kind] += 1;
      return { found: false, value: undefined as T };
    }
    this.hits[kind] += 1;
    map.delete(key);
    map.set(key, entry);
    if (entry.shareable) return { found: true, value: entry.value };
    this.unshareableReturns += 1;
    return { found: true, value: cloneTree(entry.value) };
  }

  private write<T>(map: Map<string, CachedValue<T>>, key: string, value: T): T {
    this.delete(map, key);
    const entry = freezeCached(value);
    map.set(key, entry);
    this.bytes += entry.bytes;
    this.evict();
    if (entry.shareable) return entry.value;
    this.unshareableReturns += 1;
    return cloneTree(entry.value);
  }

  private delete<T>(map: Map<string, CachedValue<T>>, key: string): void {
    const existing = map.get(key);
    if (!existing) return;
    this.bytes -= existing.bytes;
    map.delete(key);
  }

  private evict(): void {
    while (this.bytes > READ_CACHE_LIMIT_BYTES) {
      if (
        this.evictOne(this.page) ||
        this.evictOne(this.key) ||
        this.evictOne(this.count) ||
        this.evictOne(this.doc)
      ) {
        this.evictions += 1;
      } else {
        return;
      }
    }
  }

  private evictOne<T>(map: Map<string, CachedValue<T>>): boolean {
    const first = map.keys().next();
    if (first.done) return false;
    this.delete(map, first.value);
    return true;
  }

  private tableKey(kind: ReadCacheKind, table: string, key: string): string {
    return `${kind}\0${this.globalEpoch}\0${this.queryTableEpoch(table)}\0${key}`;
  }

  private docTableEpoch(table: string): number {
    return this.docTableEpochs.get(table) ?? 0;
  }

  private queryTableEpoch(table: string): number {
    return this.queryTableEpochs.get(table) ?? 0;
  }
}

function freezeCached<T>(value: T): CachedValue<T> {
  const frozen = freezeNormalizedTreeWithEstimate(value);
  return {
    bytes: frozen.bytes,
    shareable: frozen.shareable,
    value,
  };
}
