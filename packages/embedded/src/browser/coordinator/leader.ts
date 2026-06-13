import { convexToJson, type Value } from "convex/values";
import { assertSameRuntimeIdentity } from "../identity";
import {
  serializeError,
  WorkerCommand,
  WorkerEvent,
  type SerializedError,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol";
import { normalizeObject } from "../../runtime/codec";
import type { StopOnUpdate } from "../../runtime/runner";
import type { WorkerState } from "../runtime";
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
  id: string;
  /** Mutable so a follower re-attach can re-point an existing client at its new channel. */
  post: (response: WorkerResponse) => void;
  watches: Map<number, string>;
  workerId: string;
}

export interface FollowerHandle {
  channel: BroadcastChannelLike;
  clients: Set<string>;
  monitorStarted: boolean;
  workerId: string;
}

export interface LeaderState {
  clients: Map<string, ClientState>;
  followers: Map<string, FollowerHandle>;
  identity: import("../protocol").RuntimeIdentity;
  leaderEpoch: string;
  mutations: Map<string, Promise<unknown>>;
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
  }

  cleanupFollower(workerId: string): void {
    cleanupFollower(this.state, workerId);
  }

  handle(client: LeaderClient, request: WorkerRequest): Promise<void> {
    return handleLeaderRequest(this.state, client, request);
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
  error: SerializedError | undefined;
  hasValue: boolean;
  stop: StopOnUpdate;
  subscribers: Map<string, WatchSubscriber>;
  value: unknown;
}

interface WatchSubscriber {
  post(message: WorkerResponse): void;
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
  [WorkerCommand.Heartbeat]: () => undefined,
  [WorkerCommand.Init]: handleUnexpectedInit,
  [WorkerCommand.Mutation]: handleMutation,
  [WorkerCommand.Query]: handleQuery,
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
  return {
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

export function attachFollower(
  leader: LeaderState,
  message: Extract<PeerMessage, { op: typeof PeerOp.Attach }>,
  openChannel: (name: string) => BroadcastChannelLike,
  monitor: (follower: FollowerHandle) => void,
): void {
  const channel = openChannel(workerChannelName(leader.scope, message.workerId));
  try {
    try {
      assertSameRuntimeIdentity(message.identity, leader.identity);
    } catch (error) {
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
    const key = localClientKey(message.workerId, message.clientId);
    let follower = leader.followers.get(message.workerId);
    if (!follower) {
      follower = {
        channel,
        clients: new Set(),
        monitorStarted: false,
        workerId: message.workerId,
      };
      leader.followers.set(message.workerId, follower);
    } else {
      channel.close();
    }
    follower.clients.add(key);
    const post = (response: WorkerResponse) =>
      follower.channel.postMessage({
        leaderEpoch: leader.leaderEpoch,
        op: PeerOp.Response,
        protocol: CoordinatorProtocol,
        response,
      } satisfies PeerMessage);
    const existing = leader.clients.get(key);
    if (existing) {
      // Re-attach (e.g. after an ack-timeout recovery without a leader change): re-point the
      // SAME client object at the new channel so its existing `leader.watches` subscriptions —
      // which call `client.post` — keep delivering, instead of orphaning them under a fresh
      // empty `watches` map.
      existing.post = post;
    } else {
      leader.clients.set(key, {
        id: key,
        post,
        watches: new Map(),
        workerId: message.workerId,
      });
    }
    if (!follower.monitorStarted) {
      follower.monitorStarted = true;
      monitor(follower);
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

export function cleanupFollower(leader: LeaderState, workerId: string): void {
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
  for (const watch of leader.watches.values()) watch.stop();
  leader.watches.clear();
  for (const follower of leader.followers.values()) follower.channel.close();
  leader.followers.clear();
  for (const stop of leader.runtime.stops.values()) stop();
  leader.runtime.stops.clear();
  try {
    await leader.runtime.store.close();
  } finally {
    leader.runtime.opfs.closeAll();
  }
}

export function watchKey(name: string, args: Record<string, unknown>): string {
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
  const result = await leader.runtime.runner.runQuery(request.name, request.args);
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

async function handleMutation(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.Mutation }>,
): Promise<void> {
  const mutationId = request.mutationId;
  let running = leader.mutations.get(mutationId);
  if (running) {
    client.post({ id: request.id, mutationId, op: WorkerEvent.MutationAccepted });
  } else {
    running = leader.runtime.runner
      .runMutation(request.name, request.args, {
        mutationId,
        onAccepted: (acceptedMutationId) =>
          client.post({
            id: request.id,
            mutationId: acceptedMutationId,
            op: WorkerEvent.MutationAccepted,
          }),
      })
      .finally(() => {
        leader.mutations.delete(mutationId);
      });
    leader.mutations.set(mutationId, running);
  }
  const result = await running;
  client.post({ id: request.id, result, op: WorkerEvent.Result });
}

function handleWatchStart(
  leader: LeaderState,
  client: ClientState,
  request: Extract<WorkerRequest, { op: typeof WorkerCommand.WatchStart }>,
): void {
  const key = watchKey(request.name, request.args);
  let watch = leader.watches.get(key);
  if (!watch) {
    const subscribers = new Map<string, WatchSubscriber>();
    watch = {
      error: undefined,
      hasValue: false,
      stop: leader.runtime.runner.onUpdate(
        request.name,
        request.args,
        (value) => {
          watch!.error = undefined;
          watch!.hasValue = true;
          watch!.value = value;
          for (const subscriber of subscribers.values()) {
            subscriber.post({ op: WorkerEvent.WatchUpdated, value, watchId: subscriber.watchId });
          }
        },
        (error) => {
          const serialized = serializeError(error);
          watch!.error = serialized;
          // Clear the cached value so a late subscriber replays the error, not the stale
          // pre-error value (the success path symmetrically clears `error`).
          watch!.hasValue = false;
          watch!.value = undefined;
          for (const subscriber of subscribers.values()) {
            subscriber.post({
              error: serialized,
              op: WorkerEvent.WatchFailed,
              watchId: subscriber.watchId,
            });
          }
        },
      ),
      subscribers,
      value: undefined,
    };
    leader.watches.set(key, watch);
  }
  const subscriberKey = `${client.id}:${request.watchId}`;
  watch.subscribers.set(subscriberKey, {
    post: (response) => client.post(response),
    watchId: request.watchId,
  });
  client.watches.set(request.watchId, key);
  client.post({ id: request.id, op: WorkerEvent.Result });
  if (watch.hasValue) {
    client.post({ op: WorkerEvent.WatchUpdated, value: watch.value, watchId: request.watchId });
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

function stopClientWatch(leader: LeaderState, client: ClientState, watchId: number): void {
  const key = client.watches.get(watchId);
  if (!key) return;
  client.watches.delete(watchId);
  const subscriberKey = `${client.id}:${watchId}`;
  const watch = leader.watches.get(key);
  if (!watch) return;
  watch.subscribers.delete(subscriberKey);
  if (watch.subscribers.size) return;
  watch.stop();
  leader.watches.delete(key);
}

function disconnectClient(leader: LeaderState, client: ClientState): void {
  for (const watchId of Array.from(client.watches.keys())) stopClientWatch(leader, client, watchId);
  leader.clients.delete(client.id);
  const follower = leader.followers.get(client.workerId);
  follower?.clients.delete(client.id);
}
