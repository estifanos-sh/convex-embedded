import { convexToJson, type Value } from "convex/values";
import type { EmbeddedEvent } from "../../events";
import { getTimerTime } from "../../time";
import { rejectMutationsForRebuild, StoreRecovery, type RecoveryHost } from "../recovery";
import { assertSameRuntimeIdentity, RuntimeIdentityMismatchError } from "../identity";
import {
  serializeError,
  WorkerCommand,
  WorkerEvent,
  type SerializedError,
  type WatchPatch,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol";
import { normalizeObject } from "../../runtime/codec";
import type { RunMutationTiming, StopOnUpdate, WatchUpdateInfo } from "../../runtime/runner";
import { remoteConfigKey } from "../remote";
import { emitWorkerRemoteError, type WorkerState } from "../runtime";
import type { BroadcastChannelLike, PeerMessage } from "./protocol";
import {
  AttachRejection,
  CoordinatorProtocol,
  PeerOp,
  RejectCode,
  requestAck,
  workerChannelName,
} from "./protocol";
import { clientId, localClientKey } from "./state";

export interface ClientState {
  activeMutations: number;
  id: string;
  /** Mutable so a follower re-attach can re-point an existing client at its new channel. */
  post: (response: WorkerResponse) => void;
  remoteConfigured: boolean;
  watches: Map<number, string>;
  workerId: string;
}

interface RunningMutation {
  promise: Promise<unknown>;
  reject(error: unknown): void;
  timing?: RunMutationTiming;
}

/** Hooks the coordinator wires so recovery can close the remote socket and release the lease. */
export interface LeaderRecoveryHooks {
  closeRemoteSocket(): void;
  onDeadInstance(error: Error): void;
}

export interface FollowerHandle {
  channel: BroadcastChannelLike;
  clients: Set<string>;
  monitorStarted: boolean;
  workerId: string;
}

export interface LeaderState {
  clients: Map<string, ClientState>;
  /** Sticky root error after a dead-instance trip; new local ops fast-fail with it. */
  deadError?: Error;
  eventStop?: () => void;
  followers: Map<string, FollowerHandle>;
  identity: import("../protocol").RuntimeIdentity;
  leaderEpoch: string;
  mutations: Map<string, RunningMutation>;
  /** Serializes a last-client remote stop with a concurrently attaching remote client. */
  remoteIdleStop?: Promise<void>;
  recoveryHooks?: LeaderRecoveryHooks;
  runtime: WorkerState;
  scope: string;
  storagePath: string;
  watches: Map<string, SharedWatch>;
}

export type LeaderClient = ClientState;
export type RemoteFollower = FollowerHandle;

export class LeaderRuntime {
  private closePromise: Promise<void> | undefined;
  private readonly state: LeaderState;

  constructor(options: {
    epoch: string;
    identity: LeaderState["identity"];
    runtime: WorkerState;
    scope: string;
    storagePath: string;
  }) {
    this.state = createLeaderState({
      identity: options.identity,
      leaderEpoch: options.epoch,
      runtime: options.runtime,
      scope: options.scope,
      storagePath: options.storagePath,
    });
  }

  get epoch(): string {
    return this.state.leaderEpoch;
  }

  get identity(): LeaderState["identity"] {
    return this.state.identity;
  }

  addLocalClient(client: LeaderClient): void {
    this.state.clients.set(client.id, client);
    postRemoteSnapshot(this.state, client);
  }

  attachFollower(
    message: Extract<PeerMessage, { op: typeof PeerOp.Attach }>,
    openChannel: (name: string) => BroadcastChannelLike,
    monitor: (follower: RemoteFollower) => void,
    leaderId: string,
  ): void {
    attachFollower(this.state, message, openChannel, monitor);
    const follower = this.state.followers.get(message.workerId);
    follower?.channel.postMessage({
      leaderEpoch: this.epoch,
      leaderId,
      op: PeerOp.Attached,
      protocol: CoordinatorProtocol,
    } satisfies PeerMessage);
    const client = this.state.clients.get(localClientKey(message.workerId, message.clientId));
    if (client) postRemoteSnapshot(this.state, client);
  }

  followerDelete(workerId: string): void {
    followerDelete(this.state, workerId);
  }

  handle(client: LeaderClient, request: WorkerRequest): Promise<void> {
    return handleLeaderRequest(this.state, client, request);
  }

  /**
   * Installs the store-instance recovery controller: a progress-based watchdog over the store's
   * lanes plus checkpoint pacing. The coordinator supplies the remote-loop and lease hooks it owns.
   */
  enableRecovery(hooks: LeaderRecoveryHooks): StoreRecovery {
    this.state.recoveryHooks = hooks;
    const host: RecoveryHost = {
      now: () => getTimerTime(),
      emitDegraded: (error) => postEvent(this.state, degradedEvent(error)),
      emitRemoteError: (error) => emitWorkerRemoteError(this.state.runtime, error),
      closeRemoteSocket: () => hooks.closeRemoteSocket(),
      deadInstance: (error) => this.deadInstance(error),
      walWrite: () => this.state.runtime.store.wal.write(),
    };
    const recovery = new StoreRecovery(host);
    this.state.runtime.recovery = recovery;
    this.state.eventStop?.();
    this.state.eventStop = this.state.runtime.runner.subscribeEvents?.((event) => {
      if (event.type === "data" && event.source === "local") recovery.onLocalCommit();
      postEvent(this.state, event);
    });
    return recovery;
  }

  private deadInstance(error: Error): void {
    this.state.runtime.abandoned = true;
    this.state.deadError = error;
    postEvent(this.state, degradedEvent(error.message));
    rejectMutationsForRebuild(this.state.mutations, error);
    this.state.recoveryHooks?.onDeadInstance(error);
  }

  handlePeerRequest(message: Extract<PeerMessage, { op: typeof PeerOp.Request }>): Promise<void> {
    return handlePeerRequest(this.state, message);
  }

  close(): Promise<void> {
    this.closePromise ??= closeLeader(this.state);
    return this.closePromise;
  }
}

interface SharedWatch {
  args: Record<string, unknown>;
  auth: unknown;
  error: SerializedError | undefined;
  hasValue: boolean;
  name: string;
  stop: StopOnUpdate;
  subscribers: Map<string, WatchSubscriber>;
  value: unknown;
}

interface WatchSubscriber {
  client: ClientState;
  deliveredValue?: unknown;
  hasDeliveredValue: boolean;
  pendingTimer?: ReturnType<typeof setTimeout>;
  pendingUpdate?: Extract<
    WorkerResponse,
    { op: typeof WorkerEvent.WatchPatched } | { op: typeof WorkerEvent.WatchUpdated }
  >;
  pendingValue?: unknown;
  post(message: WorkerResponse): void;
  remoteConfigured: boolean;
  watchId: number;
}

type LeaderRequestHandler<T extends WorkerRequest = WorkerRequest> = (
  leader: LeaderState,
  client: ClientState,
  request: T,
) => Promise<void> | void;

type LeaderRequestHandlers = {
  [Code in WorkerRequest["op"]]: LeaderRequestHandler<Extract<WorkerRequest, { op: Code }>>;
};

const leaderRequestHandlers = {
  [WorkerCommand.Close]: handleClose,
  [WorkerCommand.AuthTokenResult]: handleAuthTokenResult,
  [WorkerCommand.Init]: handleUnexpectedInit,
  [WorkerCommand.Upload]: handleUpload,
  [WorkerCommand.Devtools]: handleDevtools,
  [WorkerCommand.Mutation]: handleMutation,
  [WorkerCommand.Query]: handleQuery,
  [WorkerCommand.Route]: handleRoute,
  [WorkerCommand.IdentityRead]: handleIdentityRead,
  [WorkerCommand.IdentityWrite]: handleIdentityWrite,
  [WorkerCommand.RemoteIdentityRead]: handleRemoteIdentityRead,
  [WorkerCommand.RemoteNetworkWrite]: handleRemoteNetworkWrite,
  [WorkerCommand.StorageOwnerWrite]: handleUnexpectedStorageOwnerWrite,
  [WorkerCommand.WatchStart]: handleWatchStart,
  [WorkerCommand.WatchStop]: handleWatchStop,
} satisfies LeaderRequestHandlers;

export function createLeaderState(options: {
  identity: LeaderState["identity"];
  leaderEpoch: string;
  runtime: WorkerState;
  scope: string;
  storagePath: string;
}): LeaderState {
  const state: LeaderState = {
    clients: new Map(),
    followers: new Map(),
    identity: options.identity,
    leaderEpoch: options.leaderEpoch,
    mutations: new Map(),
    runtime: options.runtime,
    scope: options.scope,
    storagePath: options.storagePath,
    watches: new Map(),
  };
  state.eventStop = options.runtime.runner.subscribeEvents?.((event) => postEvent(state, event));
  options.runtime.emit = (event) => {
    postEvent(state, event);
  };
  return state;
}

export async function handleLeaderRequest(
  leader: LeaderState,
  client: ClientState,
  request: WorkerRequest,
): Promise<void> {
  try {
    await leaderRequestHandlers[request.op](leader, client, request as never);
  } catch (error) {
    client.post({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
  }
}

function abandonedInstanceError(leader: LeaderState): Error {
  return (
    leader.deadError ??
    new Error("embedded store instance failed repeatedly and cannot be recovered")
  );
}

function degradedEvent(error: string): EmbeddedEvent {
  return { at: getTimerTime(), degradation: "failed", error, type: "runtime" };
}

export function attachFollower(
  leader: LeaderState,
  message: Extract<PeerMessage, { op: typeof PeerOp.Attach }>,
  openChannel: (name: string) => BroadcastChannelLike,
  monitor: (follower: FollowerHandle) => void,
) {
  const channel = openChannel(workerChannelName(message.scope, message.workerId));
  try {
    try {
      assertSameRuntimeIdentity(message.identity, leader.identity);
    } catch (error) {
      if (error instanceof RuntimeIdentityMismatchError) {
        postEvent(leader, {
          at: getTimerTime(),
          degradation: "deployment-mismatch",
          error: error.message,
          type: "runtime",
        });
        throw new AttachRejection(RejectCode.DeploymentMismatch, error.message, error.name);
      }
      throw new AttachRejection(
        RejectCode.IdentityMismatch,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (message.storagePath !== leader.storagePath) {
      throw new AttachRejection(
        RejectCode.StoragePathMismatch,
        "ConvexEmbeddedClient cannot attach to a runtime with a different storage path.",
      );
    }
    if (message.remote !== undefined) {
      const key = remoteConfigKey(message.remote);
      if (leader.runtime.remoteKey !== undefined && leader.runtime.remoteKey !== key) {
        throw new AttachRejection(
          RejectCode.RemoteMismatch,
          "ConvexEmbeddedClient cannot attach to an existing browser runtime with a different remote configuration.",
        );
      }
      leader.runtime.remoteKey ??= key;
    }
    const key = localClientKey(message.workerId, message.clientId);
    const existingFollower = leader.followers.get(message.workerId);
    const follower =
      existingFollower ??
      ({
        channel,
        clients: new Set(),
        monitorStarted: false,
        workerId: message.workerId,
      } satisfies FollowerHandle);
    if (existingFollower) {
      channel.close();
    } else {
      leader.followers.set(message.workerId, follower);
    }
    const post = (response: WorkerResponse) =>
      follower.channel.postMessage({
        leaderEpoch: leader.leaderEpoch,
        op: PeerOp.Response,
        protocol: CoordinatorProtocol,
        response,
      } satisfies PeerMessage);
    follower.clients.add(key);
    const existing = leader.clients.get(key);
    if (existing) {
      existing.post = post;
      updateClientRemoteConfigured(leader, existing, message.remote !== undefined);
    } else {
      leader.clients.set(key, {
        activeMutations: 0,
        id: key,
        post,
        remoteConfigured: message.remote !== undefined,
        watches: new Map(),
        workerId: message.workerId,
      });
    }
    if (!follower.monitorStarted) {
      follower.monitorStarted = true;
      monitor(follower);
    }
    if (message.remote !== undefined) {
      void (leader.remoteIdleStop ?? Promise.resolve())
        .then(() => import("../runtime"))
        .then(({ ensureWorkerRemoteStarted }) =>
          ensureWorkerRemoteStarted(leader.runtime, message.remote!, false, post),
        )
        .catch(() => undefined);
    }
  } catch (error) {
    channel.postMessage({
      code: error instanceof AttachRejection ? error.code : RejectCode.Internal,
      error: serializeError(error),
      leaderEpoch: leader.leaderEpoch,
      op: PeerOp.Rejected,
      protocol: CoordinatorProtocol,
    } satisfies PeerMessage);
    channel.close();
  }
}

export async function handlePeerRequest(
  leader: LeaderState,
  message: Extract<PeerMessage, { op: typeof PeerOp.Request }>,
): Promise<void> {
  if (message.leaderEpoch !== leader.leaderEpoch) return;
  const key = localClientKey(message.fromWorkerId, clientId(message.request));
  const client = leader.clients.get(key);
  if (!client) {
    const follower = leader.followers.get(message.fromWorkerId);
    follower?.channel.postMessage({
      leaderEpoch: leader.leaderEpoch,
      op: PeerOp.Response,
      protocol: CoordinatorProtocol,
      response: {
        error: serializeError(
          new Error("ConvexEmbeddedClient is not connected to this browser runtime leader."),
        ),
        id: message.request.id,
        op: WorkerEvent.Result,
      },
    } satisfies PeerMessage);
    return;
  }
  leader.followers
    .get(message.fromWorkerId)
    ?.channel.postMessage(requestAck(leader.leaderEpoch, message.request.id));
  await handleLeaderRequest(leader, client, message.request);
}

export function followerDelete(leader: LeaderState, workerId: string): void {
  const follower = leader.followers.get(workerId);
  if (!follower) return;
  for (const id of Array.from(follower.clients)) {
    const client = leader.clients.get(id);
    if (client) disconnectClient(leader, client);
  }
  follower.channel.close();
  leader.followers.delete(workerId);
}

export async function closeLeader(leader: LeaderState): Promise<void> {
  leader.eventStop?.();
  leader.runtime.closed = true;
  leader.runtime.recovery?.dispose();
  if (leader.runtime.remoteStartTimer !== undefined) {
    clearTimeout(leader.runtime.remoteStartTimer);
    leader.runtime.remoteStartTimer = undefined;
  }
  leader.runtime.remoteStop?.();
  const { rejectPendingRemoteAuth } = await import("../runtime");
  rejectPendingRemoteAuth(leader.runtime, new Error("Browser remote replication closed."));
  for (const watch of leader.watches.values()) watch.stop();
  leader.watches.clear();
  for (const follower of leader.followers.values()) follower.channel.close();
  leader.followers.clear();
  for (const stop of leader.runtime.stops.values()) stop();
  leader.runtime.stops.clear();
  try {
    // A dead abandoned instance is wedged; its store/remote close would hang, so it is skipped and
    // only the pthread pool and OPFS handles are reclaimed.
    if (!leader.runtime.abandoned) {
      await leader.runtime.store.remote?.close().catch(() => undefined);
      await leader.runtime.store.close();
    }
  } finally {
    leader.runtime.pthreads?.terminateAll();
    leader.runtime.opfs.closeAll();
  }
}

function watchKey(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    args: convexToJson(normalizeObject(args) as Value),
    context: "auth:null",
    name,
  });
}

function handleUnexpectedInit(
  _leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>,
): void {
  client.post({
    error: serializeError(new Error("Convex embedded worker is already initialized.")),
    id: request.id,
    op: WorkerEvent.Result,
  });
}

async function handleQuery(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Query }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  const result = await leader.runtime.runner.runQuery(request.name, request.args, {
    auth: request.auth as never,
  });
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleRoute(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Route }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  const result = await leader.runtime.runner.route(request.name, request.args, request.kind);
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleIdentityRead(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.IdentityRead }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  const result = await leader.runtime.runner.identity.read();
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleIdentityWrite(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.IdentityWrite }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  await leader.runtime.runner.identity.write(request.identityKey);
  client.post({ id: request.id, result: null, op: WorkerEvent.Result });
}

async function handleRemoteIdentityRead(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.RemoteIdentityRead }>,
): Promise<void> {
  try {
    const result = await leader.runtime.runner.remote?.identity.read();
    client.post({ id: request.id, result, op: WorkerEvent.Result });
  } catch (error) {
    await leader.runtime.remoteReset?.();
    throw error;
  }
}

async function handleUpload(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Upload }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  const buffer = request.bytes.buffer.slice(
    request.bytes.byteOffset,
    request.bytes.byteOffset + request.bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: request.contentType });
  const result = await leader.runtime.runner.handleUpload(request.url, blob);
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleDevtools(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Devtools }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  const result = await leader.runtime.runner.devtools(request.request);
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleMutation(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Mutation }>,
): Promise<void> {
  if (leader.runtime.abandoned) throw abandonedInstanceError(leader);
  client.activeMutations += 1;
  const mutationId = request.mutationId;
  try {
    let running = leader.mutations.get(mutationId);
    if (running) {
      client.post({ id: request.id, mutationId, op: WorkerEvent.MutationAccepted });
    } else {
      // A rebuild rejects `running.promise` externally, so the wrapper carries `reject`; the raw
      // runMutation may later settle the abandoned instance harmlessly (the wrapper is already done).
      let rejectRunning!: (error: unknown) => void;
      const entry: RunningMutation = {
        promise: new Promise<unknown>((resolve, reject) => {
          rejectRunning = reject;
          void leader.runtime.runner
            .runMutation(request.name, request.args, {
              auth: request.auth as never,
              mutationIsFresh: request.mutationIsFresh,
              mutationId,
              pushCall: {
                fn: request.name,
                rngSeed: request.rngSeed,
              },
              onAccepted: (acceptedMutationId) =>
                client.post({
                  id: request.id,
                  mutationId: acceptedMutationId,
                  op: WorkerEvent.MutationAccepted,
                }),
              onTiming: (timing) => {
                entry.timing = timing;
              },
            })
            .then(resolve, reject);
        }),
        reject: (error) => rejectRunning(error),
      };
      entry.promise
        .catch(() => undefined)
        .finally(() => {
          if (leader.mutations.get(mutationId) === entry) leader.mutations.delete(mutationId);
        });
      running = entry;
      leader.mutations.set(mutationId, running);
    }
    const result = await running.promise;
    client.post({ id: request.id, result, timing: running.timing, op: WorkerEvent.Result });
  } finally {
    client.activeMutations -= 1;
    flushClientWatchUpdates(leader, client);
  }
}

function handleWatchStart(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStart }>,
): void {
  stopClientWatch(leader, client, request.watchId);
  const key = watchKey(request.name, { ...request.args, __auth: request.auth ?? null });
  let watch = leader.watches.get(key);
  if (!watch) {
    watch = {
      args: request.args,
      auth: request.auth,
      error: undefined,
      hasValue: false,
      name: request.name,
      stop: () => undefined,
      subscribers: new Map<string, WatchSubscriber>(),
      value: undefined,
    };
    watch.stop = startSharedWatch(leader, watch);
    leader.watches.set(key, watch);
  }
  const subscriberKey = `${client.id}:${request.watchId}`;
  const hadRemoteSubscriber = hasRemoteSubscriber(watch.subscribers);
  watch.subscribers.set(subscriberKey, {
    client,
    hasDeliveredValue: false,
    post: (response) => client.post(response),
    remoteConfigured: client.remoteConfigured,
    watchId: request.watchId,
  });
  if (hasRemoteSubscriber(watch.subscribers) !== hadRemoteSubscriber) writeRemoteScope(leader);
  client.watches.set(request.watchId, key);
  client.post({ id: request.id, op: WorkerEvent.Result });
  if (watch.hasValue) {
    queueWatchValue(watch.subscribers.get(subscriberKey)!, watch.value);
  } else if (watch.error) {
    client.post({ error: watch.error, op: WorkerEvent.WatchFailed, watchId: request.watchId });
  }
}

function handleWatchStop(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStop }>,
): void {
  stopClientWatch(leader, client, request.watchId);
  client.post({ id: request.id, op: WorkerEvent.Result });
}

function handleClose(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Close }>,
): void {
  disconnectClient(leader, client);
  client.post({ id: request.id, op: WorkerEvent.Result });
}

async function handleAuthTokenResult(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.AuthTokenResult }>,
): Promise<void> {
  const { handleWorkerRemoteAuthResult } = await import("../runtime");
  handleWorkerRemoteAuthResult(leader.runtime, request);
  client.post({ id: request.id, op: WorkerEvent.Result });
}

async function handleRemoteNetworkWrite(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.RemoteNetworkWrite }>,
): Promise<void> {
  const { writeWorkerRemoteNetwork } = await import("../runtime");
  writeWorkerRemoteNetwork(leader.runtime, request.online);
  client.post({ id: request.id, op: WorkerEvent.Result });
}

function handleUnexpectedStorageOwnerWrite(
  _leader: LeaderState,
  _client: ClientState,
  _request: Extract<WorkerRequest, { op: typeof WorkerCommand.StorageOwnerWrite }>,
): never {
  throw new Error("Storage ownership grants are local to the requesting page runtime.");
}

function stopClientWatch(leader: LeaderState, client: ClientState, watchId: number): void {
  const key = client.watches.get(watchId);
  if (!key) return;
  client.watches.delete(watchId);
  const subscriberKey = `${client.id}:${watchId}`;
  const watch = leader.watches.get(key);
  if (!watch) return;
  const hadRemoteSubscriber = hasRemoteSubscriber(watch.subscribers);
  const subscriber = watch.subscribers.get(subscriberKey);
  clearPendingWatchUpdate(subscriber);
  watch.subscribers.delete(subscriberKey);
  if (hasRemoteSubscriber(watch.subscribers) !== hadRemoteSubscriber) writeRemoteScope(leader);
  if (watch.subscribers.size) return;
  watch.stop();
  leader.watches.delete(key);
}

/**
 * Subscribes a shared watch against the current runner, wiring its value and error fan-out. Used on
 * first subscribe and re-used verbatim by the rebuild graft to re-establish the watch on the fresh
 * runner (spec §2 — every leader.watches entry's onUpdate re-established and re-fanned).
 */
function startSharedWatch(leader: LeaderState, watch: SharedWatch): StopOnUpdate {
  return leader.runtime.runner.onUpdate(
    watch.name,
    watch.args,
    (value, info) => {
      watch.error = undefined;
      watch.hasValue = true;
      watch.value = value;
      fanoutWatchValue(watch.subscribers, value, info);
    },
    (error) => {
      const serialized = serializeError(error);
      watch.error = serialized;
      watch.hasValue = false;
      watch.value = undefined;
      for (const subscriber of watch.subscribers.values()) {
        subscriber.post({
          error: serialized,
          op: WorkerEvent.WatchFailed,
          watchId: subscriber.watchId,
        });
      }
    },
    { auth: watch.auth as never, remoteScope: () => hasRemoteSubscriber(watch.subscribers) },
  );
}

/**
 * Fan a single watch value out to every subscriber, computing the array-rows patch once per
 * distinct delivered state instead of once per subscriber. Subscribers sitting in the same
 * delivered state share one patch (the result depends only on `deliveredValue`, `value`, and
 * `info.changedDocIds`); subscribers in a different state still get their own correct patch.
 */
function fanoutWatchValue(
  subscribers: ReadonlyMap<string, WatchSubscriber>,
  value: unknown,
  info?: WatchUpdateInfo,
): void {
  const patches = new Map<unknown, WatchPatch | undefined>();
  for (const subscriber of subscribers.values()) {
    let patch: WatchPatch | undefined;
    if (subscriber.pendingUpdate === undefined && subscriber.hasDeliveredValue) {
      if (patches.has(subscriber.deliveredValue)) {
        patch = patches.get(subscriber.deliveredValue);
      } else {
        patch = arrayRowsPatch(subscriber.deliveredValue, value, info?.changedDocIds);
        patches.set(subscriber.deliveredValue, patch);
      }
    }
    enqueueWatchUpdate(subscriber, value, patch);
  }
}

function queueWatchValue(
  subscriber: WatchSubscriber,
  value: unknown,
  info?: WatchUpdateInfo,
): void {
  const patch =
    subscriber.pendingUpdate === undefined && subscriber.hasDeliveredValue
      ? arrayRowsPatch(subscriber.deliveredValue, value, info?.changedDocIds)
      : undefined;
  enqueueWatchUpdate(subscriber, value, patch);
}

function enqueueWatchUpdate(
  subscriber: WatchSubscriber,
  value: unknown,
  patch: WatchPatch | undefined,
): void {
  subscriber.pendingValue = value;
  subscriber.pendingUpdate =
    patch === undefined
      ? {
          op: WorkerEvent.WatchUpdated,
          value,
          watchId: subscriber.watchId,
        }
      : {
          op: WorkerEvent.WatchPatched,
          patch,
          watchId: subscriber.watchId,
        };
  if (subscriber.pendingTimer !== undefined) return;
  subscriber.pendingTimer = setTimeout(() => {
    if (subscriber.client.activeMutations > 0) {
      subscriber.pendingTimer = undefined;
      return;
    }
    const update = subscriber.pendingUpdate;
    const deliveredValue = subscriber.pendingValue;
    subscriber.pendingTimer = undefined;
    subscriber.pendingUpdate = undefined;
    subscriber.pendingValue = undefined;
    if (update) {
      subscriber.post(update);
      subscriber.deliveredValue = deliveredValue;
      subscriber.hasDeliveredValue = true;
    }
  }, 0);
}

function arrayRowsPatch(
  previous: unknown,
  next: unknown,
  changedDocIds: Set<string> | undefined,
): WatchPatch | undefined {
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
    return undefined;
  }
  if (changedDocIds === undefined || changedDocIds.size === 0 || changedDocIds.size > 8) {
    return undefined;
  }
  const byId = new Map<string, { index: number; value: unknown }>();
  for (let index = 0; index < next.length; index += 1) {
    const previousId = rowId(previous[index]);
    const nextId = rowId(next[index]);
    if (previousId === undefined || previousId !== nextId) return undefined;
    if (changedDocIds.has(nextId)) byId.set(nextId, { index, value: next[index] });
  }
  if (byId.size !== changedDocIds.size) return undefined;
  return { changes: [...byId.values()], kind: "arrayRows", length: next.length };
}

function rowId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { _id?: unknown })._id;
  return typeof id === "string" ? id : undefined;
}

function clearPendingWatchUpdate(subscriber: WatchSubscriber | undefined): void {
  if (!subscriber) return;
  if (subscriber.pendingTimer !== undefined) clearTimeout(subscriber.pendingTimer);
  subscriber.pendingTimer = undefined;
  subscriber.pendingUpdate = undefined;
  subscriber.pendingValue = undefined;
}

function flushClientWatchUpdates(leader: LeaderState, client: ClientState): void {
  if (client.activeMutations > 0) return;
  for (const [watchId, key] of client.watches) {
    const subscriber = leader.watches.get(key)?.subscribers.get(`${client.id}:${watchId}`);
    if (!subscriber?.pendingUpdate || subscriber.pendingTimer !== undefined) continue;
    queueWatchValue(subscriber, subscriber.pendingValue);
  }
}

function postEvent(leader: LeaderState, event: EmbeddedEvent): void {
  const forwarded = event.type === "remote" ? { ...event, incarnation: leader.leaderEpoch } : event;
  const response: WorkerResponse = { event: forwarded, op: WorkerEvent.Event };
  for (const client of leader.clients.values()) {
    if (canReadEvent(client, forwarded)) client.post(response);
  }
}

function postRemoteSnapshot(leader: LeaderState, client: ClientState): void {
  if (!client.remoteConfigured || !leader.runtime.remoteEvent) return;
  client.post({
    event: { ...leader.runtime.remoteEvent, incarnation: leader.leaderEpoch },
    op: WorkerEvent.Event,
  });
}

function canReadEvent(client: ClientState, event: EmbeddedEvent): boolean {
  return client.remoteConfigured || !isRemoteScopedEvent(event);
}

function isRemoteScopedEvent(event: EmbeddedEvent): boolean {
  return (
    event.type === "remote" ||
    event.type === "conflict" ||
    (event.type === "data" && event.source === "remote")
  );
}

function hasRemoteSubscriber(subscribers: ReadonlyMap<string, WatchSubscriber>): boolean {
  for (const subscriber of subscribers.values()) {
    if (subscriber.remoteConfigured) return true;
  }
  return false;
}

function writeRemoteScope(leader: LeaderState): void {
  void leader.runtime.runner.remote?.scope.write();
}

function updateClientRemoteConfigured(
  leader: LeaderState,
  client: ClientState,
  remoteConfigured: boolean,
): void {
  if (client.remoteConfigured === remoteConfigured) return;
  client.remoteConfigured = remoteConfigured;
  let changed = false;
  for (const [watchId, key] of client.watches) {
    const subscriber = leader.watches.get(key)?.subscribers.get(`${client.id}:${watchId}`);
    if (subscriber === undefined || subscriber.remoteConfigured === remoteConfigured) continue;
    subscriber.remoteConfigured = remoteConfigured;
    changed = true;
  }
  if (changed) writeRemoteScope(leader);
  stopRemoteIfIdle(leader);
}

function disconnectClient(leader: LeaderState, client: ClientState): void {
  for (const watchId of Array.from(client.watches.keys())) stopClientWatch(leader, client, watchId);
  leader.clients.delete(client.id);
  const follower = leader.followers.get(client.workerId);
  follower?.clients.delete(client.id);
  stopRemoteIfIdle(leader);
}

function hasRemoteClient(leader: LeaderState): boolean {
  for (const client of leader.clients.values()) {
    if (client.remoteConfigured) return true;
  }
  return false;
}

function stopRemoteIfIdle(leader: LeaderState): void {
  if (hasRemoteClient(leader)) return;
  if (leader.remoteIdleStop !== undefined) return;
  if (
    leader.runtime.remoteKey === undefined &&
    leader.runtime.remoteReady === undefined &&
    leader.runtime.remoteStartTimer === undefined &&
    leader.runtime.remoteStop === undefined
  ) {
    return;
  }
  const stopping = import("../runtime")
    .then(({ stopWorkerRemote }) => {
      // A client may attach while the runtime chunk is loading. Re-check at the destructive edge;
      // otherwise that late attachment inherits a runtime whose remote actor was just stopped.
      if (hasRemoteClient(leader)) return;
      return stopWorkerRemote(leader.runtime);
    })
    .catch(() => undefined);
  leader.remoteIdleStop = stopping;
  void stopping.finally(() => {
    if (leader.remoteIdleStop === stopping) leader.remoteIdleStop = undefined;
  });
}
