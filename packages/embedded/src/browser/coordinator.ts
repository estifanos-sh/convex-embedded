import { randomId } from "../id/random";
import { getTimerTime } from "../time";
import { assertSameRuntimeIdentity, createRuntimeIdentity, runtimeScope } from "./identity";
import {
  serializeError,
  WorkerCommand,
  WorkerEvent,
  type WorkerCommandCode,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import {
  assertRuntimeCapabilities,
  requiredLockManager,
  type CoordinatorEnv,
  workerGlobal,
} from "./coordinator/env";
import { RequestOutbox } from "./coordinator/outbox";
import { LeaderRuntime, type LeaderClient, type RemoteFollower } from "./coordinator/leader";
import { Mailbox } from "./coordinator/mailbox";
import {
  controlChannelName,
  ControlOp,
  CoordinatorProtocol,
  isControlMessage,
  isPeerMessage,
  PeerOp,
  RejectCode,
  workerChannelName,
  workerLockName,
  type ControlMessage,
  type InitRequest,
  type PeerMessage,
} from "./coordinator/protocol";
import {
  DEFAULT_COORDINATOR_TIMEOUTS,
  clientId,
  deferred,
  localClientKey,
  type CoordinatorTimeouts,
  type Deferred,
} from "./coordinator/state";

export interface CoordinatorRuntime {
  start(): Promise<void>;
  handle(request: WorkerRequest): void;
  close(): Promise<void>;
}

export interface CoordinatorOptions {
  assertCapabilities?: CoordinatorEnv["assertCapabilities"];
  channelFactory?: (name: string) => ReturnType<CoordinatorEnv["channels"]["open"]>;
  close?: CoordinatorEnv["closeSelf"];
  initRuntime?: CoordinatorEnv["openRuntime"];
  locks?: CoordinatorEnv["locks"];
  post?: CoordinatorEnv["postLocal"];
  timeouts?: Partial<CoordinatorTimeouts>;
  workerId?: string;
}

type Timer = ReturnType<CoordinatorEnv["setTimer"]>;
type CoordinatorEnvOverrides = Partial<Omit<CoordinatorEnv, "timeouts">> & {
  timeouts?: Partial<CoordinatorTimeouts>;
};

type RuntimeOwnership =
  | { ownership: "seeking" }
  | {
      epoch: string;
      leaderId: string;
      mailbox: Mailbox<PeerMessage>;
      ownership: "attaching";
      timer: Timer;
    }
  | {
      epoch: string;
      leaderId: string;
      mailbox: Mailbox<PeerMessage>;
      ownership: "follower";
    }
  | { ownership: "promoting" }
  | { epoch: string; leader: LeaderRuntime; ownership: "leader" }
  | { ownership: "closed" };

interface RuntimeAddress {
  clientId: string;
  controlName: string;
  identity: NonNullable<InitRequest["identity"]>;
  scope: string;
  storagePath: string;
  workerChannelName: string;
  workerId: string;
}

type Lifecycle =
  | { initReady: Deferred; lifecycle: "starting" }
  | { lifecycle: "active" }
  | { closePromise: Promise<void>; lifecycle: "closing" }
  | { lifecycle: "closed" };

interface LeaderDiscovery {
  /** Consecutive retryable attach rejections in the current discovery round. */
  attachRejections?: number;
  /** Backoff timer scheduled after a retryable attach rejection, tracked so it can be cancelled. */
  attachBackoff?: Timer;
  leaderBeacon?: Timer;
  recoveryTimer?: Timer;
}

const MAX_ATTACH_BACKOFF_EXPONENT = 16;
interface RuntimeResources {
  control?: Mailbox<ControlMessage>;
  localClient: LeaderClient;
  ownership: RuntimeOwnership;
  storageLease?: { release: Deferred; released: Deferred };
  workerLease: Deferred;
  workerMailbox?: Mailbox<PeerMessage>;
}

interface CoordinatorState {
  address: RuntimeAddress;
  discovery: LeaderDiscovery;
  outbox: RequestOutbox;
  lifecycle: Lifecycle;
  resources: RuntimeResources;
}

type RuntimeRequest = Exclude<
  WorkerRequest,
  Extract<
    WorkerRequest,
    {
      op:
        | typeof WorkerCommand.Close
        | typeof WorkerCommand.Init
        | typeof WorkerCommand.StorageOwnerWrite;
    }
  >
>;

type LocalRequestHandler<T extends WorkerRequest = WorkerRequest> = (
  runtime: FunctionalCoordinatorRuntime,
  request: T,
) => void;

type ControlHandler<T extends ControlMessage = ControlMessage> = (
  runtime: FunctionalCoordinatorRuntime,
  message: T,
) => void;

type PeerHandler<T extends PeerMessage = PeerMessage> = (
  runtime: FunctionalCoordinatorRuntime,
  message: T,
) => void;

const localRequestHandlers = new Map<WorkerCommandCode, LocalRequestHandler>([
  [WorkerCommand.Close, (runtime, request) => runtime.handleClose(request as never)],
  [
    WorkerCommand.StorageOwnerWrite,
    (runtime, request) => runtime.handleStorageOwnerWrite(request as never),
  ],
  [
    WorkerCommand.Init,
    (runtime, request) =>
      runtime.postLocal({
        error: serializeError(new Error("Convex embedded worker is already initialized.")),
        id: request.id,
        op: WorkerEvent.Result,
      }),
  ],
  [
    WorkerCommand.AuthTokenResult,
    (runtime, request) => runtime.handleRuntimeRequest(request as never),
  ],
  [WorkerCommand.Mutation, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.Action, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.Query, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.Route, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [
    WorkerCommand.IdentityRead,
    (runtime, request) => runtime.handleRuntimeRequest(request as never),
  ],
  [
    WorkerCommand.IdentityWrite,
    (runtime, request) => runtime.handleRuntimeRequest(request as never),
  ],
  [
    WorkerCommand.RemoteIdentityRead,
    (runtime, request) => runtime.handleRuntimeRequest(request as never),
  ],
  [
    WorkerCommand.RemoteNetworkWrite,
    (runtime, request) => runtime.handleRuntimeRequest(request as never),
  ],
  [WorkerCommand.Upload, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.Devtools, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.WatchStart, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.WatchStop, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
]);

const controlHandlers = new Map<number, ControlHandler>([
  [ControlOp.SeekLeader, (runtime, message) => runtime.handleSeekLeader(message as never)],
  [
    ControlOp.BroadcastLeader,
    (runtime, message) => runtime.handleBroadcastLeader(message as never),
  ],
]);

const peerHandlers = new Map<number, PeerHandler>([
  [PeerOp.Attach, (runtime, message) => runtime.handleAttach(message as never)],
  [PeerOp.Attached, (runtime, message) => runtime.handleAttached(message as never)],
  [PeerOp.Rejected, (runtime, message) => runtime.handleRejected(message as never)],
  [PeerOp.Request, (runtime, message) => runtime.handlePeerRequest(message as never)],
  [PeerOp.RequestAck, (runtime, message) => runtime.handleRequestAck(message as never)],
  [PeerOp.Response, (runtime, message) => runtime.handlePeerResponse(message as never)],
]);

/**
 * Starts the package-owned browser runtime worker.
 *
 * One dedicated worker is created per `ConvexEmbeddedClient`. Web Locks elect one storage leader;
 * followers proxy over direct BroadcastChannel peer channels and never open OPFS/Turso.
 *
 * @internal
 */
export function createConvexEmbeddedCoordinatedWorkerFromMessage(
  options: CoordinatorOptions = {},
): void {
  const state = workerCoordinatorState();
  workerGlobal().onmessage = (event) => {
    const request = event.data as WorkerRequest;
    if (request.op === WorkerCommand.Init) {
      if (state.runtime) {
        postDefault({
          error: serializeError(new Error("Convex embedded worker is already initialized.")),
          id: request.id,
          op: WorkerEvent.Result,
        });
        return;
      }
      try {
        state.runtime = createCoordinatorRuntime(request, toEnv(options));
        void state.runtime.start();
      } catch (error) {
        postDefault({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
      }
      return;
    }
    if (!state.runtime) {
      postDefault({
        error: serializeError(
          new Error(
            `Convex embedded worker has not been initialized for op ${String(request.op)}.`,
          ),
        ),
        id: request.id,
        op: WorkerEvent.Result,
      });
      return;
    }
    state.runtime.handle(request);
  };
}

/**
 * Creates the browser runtime coordinator used by the package-owned dedicated worker.
 *
 * @internal
 */
export function createCoordinatorRuntime(
  init: InitRequest,
  envOverrides: CoordinatorEnvOverrides = {},
): CoordinatorRuntime {
  return new FunctionalCoordinatorRuntime(init, mergeEnv(envOverrides));
}

class FunctionalCoordinatorRuntime implements CoordinatorRuntime {
  private closeRequestId?: number;
  private readonly state: CoordinatorState;
  private storagePromotion?: Promise<void>;

  constructor(
    private readonly init: InitRequest,
    private readonly env: CoordinatorEnv,
  ) {
    if (!init.identity) {
      throw new Error("ConvexEmbeddedClient did not send runtime identity.");
    }
    const expected = createRuntimeIdentity(init.identity.storageId);
    assertSameRuntimeIdentity(init.identity, expected);

    const workerId = env.randomId("worker");
    const scope = runtimeScope(init.identity);
    const id = clientId(init);
    const address: RuntimeAddress = {
      clientId: id,
      controlName: controlChannelName(init.identity.storageId),
      identity: init.identity,
      scope,
      storagePath: init.storagePath,
      workerChannelName: workerChannelName(scope, workerId),
      workerId,
    };
    const outbox = new RequestOutbox({
      clearTimer: (timer) => this.env.clearTimer(timer),
      post: (response) => this.postLocal(response),
      setTimer: (callback, ms) => this.env.setTimer(callback, ms),
    });
    const localClient: LeaderClient = {
      activeMutations: 0,
      id: localClientKey(workerId, id),
      post: (response) => this.postRuntimeResponse(response),
      remoteConfigured: init.remote !== undefined,
      watches: new Map(),
      workerId,
    };
    const initReady = deferred();
    const workerLease = deferred();
    initReady.promise.catch(() => undefined);
    workerLease.promise.catch(() => undefined);

    this.state = {
      address,
      discovery: {},
      outbox,
      lifecycle: {
        initReady,
        lifecycle: "starting",
      },
      resources: {
        localClient,
        ownership: { ownership: "seeking" },
        workerLease,
      },
    };
  }

  async start(): Promise<void> {
    try {
      await this.env.assertCapabilities();
      this.state.resources.control = this.openMailbox(
        this.state.address.controlName,
        this.onControlMessage,
      );
      this.state.resources.workerMailbox = this.openMailbox(
        this.state.address.workerChannelName,
        this.onPeerMessage,
      );
      await this.holdWorkerLock();
      if (this.init.storageOwner !== false) void this.acceptStorageOwnership();
      this.ensureConnected();
      const lifecycle = this.state.lifecycle;
      if (lifecycle.lifecycle === "starting") {
        await lifecycle.initReady.promise;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  handle(request: WorkerRequest): void {
    localRequestHandlers.get(request.op)?.(this, request as never);
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  postLocal(response: WorkerResponse): void {
    this.env.postLocal(response);
  }

  handleRuntimeRequest(request: RuntimeRequest): void {
    if (this.isClosedOrClosing()) {
      this.postLocal({
        error: serializeError(new Error("ConvexEmbeddedClient has already been closed.")),
        id: request.id,
        op: WorkerEvent.Result,
      });
      return;
    }
    try {
      const ownership = this.state.resources.ownership;
      if (ownership.ownership === "leader") {
        void ownership.leader.handle(this.state.resources.localClient, request);
        return;
      }
      this.state.outbox.record(request);
      this.sendOrConnect(request);
    } catch (error) {
      this.postLocal({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
    }
  }

  handleClose(request: Extract<WorkerRequest, { op: typeof WorkerCommand.Close }>): void {
    if (this.isClosedOrClosing()) {
      this.postLocal({ id: request.id, op: WorkerEvent.Result });
      return;
    }
    this.closeRequestId = request.id;
    void this.shutdown();
  }

  handleStorageOwnerWrite(
    request: Extract<WorkerRequest, { op: typeof WorkerCommand.StorageOwnerWrite }>,
  ): void {
    void this.acceptStorageOwnership().then(
      () => this.postLocal({ id: request.id, op: WorkerEvent.Result }),
      (error) => {
        this.postLocal({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
        this.fail(error);
      },
    );
  }

  handleSeekLeader(message: Extract<ControlMessage, { op: typeof ControlOp.SeekLeader }>): void {
    if (message.workerId === this.state.address.workerId) return;
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "leader") return;
    this.state.resources.control?.send({
      identity: ownership.leader.identity,
      leaderEpoch: ownership.epoch,
      leaderId: this.state.address.workerId,
      op: ControlOp.BroadcastLeader,
      protocol: CoordinatorProtocol,
      scope: this.state.address.scope,
    });
  }

  handleBroadcastLeader(
    message: Extract<ControlMessage, { op: typeof ControlOp.BroadcastLeader }>,
  ): void {
    if (message.leaderId === this.state.address.workerId) return;
    const ownership = this.state.resources.ownership;
    if (ownership.ownership === "leader" || ownership.ownership === "promoting") return;
    if (ownership.ownership === "follower" && ownership.epoch === message.leaderEpoch) {
      return;
    }
    if (ownership.ownership === "attaching" && ownership.epoch === message.leaderEpoch) return;
    this.attachToLeader(message.leaderId, message.leaderEpoch, message.scope);
  }

  handleAttach(message: Extract<PeerMessage, { op: typeof PeerOp.Attach }>): void {
    const ownership = this.state.resources.ownership;
    if (message.workerId === this.state.address.workerId || ownership.ownership !== "leader")
      return;
    ownership.leader.attachFollower(
      message,
      (name) => this.env.channels.open(name),
      (follower) =>
        this.monitorFollower(
          this.state.resources.ownership.ownership === "leader"
            ? this.state.resources.ownership.leader
            : undefined,
          follower,
        ),
      this.state.address.workerId,
    );
  }

  handlePeerRequest(message: Extract<PeerMessage, { op: typeof PeerOp.Request }>): void {
    const ownership = this.state.resources.ownership;
    if (message.fromWorkerId === this.state.address.workerId || ownership.ownership !== "leader") {
      return;
    }
    if (message.leaderEpoch !== ownership.epoch) return;
    void ownership.leader.handlePeerRequest(message);
  }

  handleRequestAck(message: Extract<PeerMessage, { op: typeof PeerOp.RequestAck }>): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "follower" || ownership.epoch !== message.leaderEpoch) return;
    this.state.outbox.confirm(message.requestId);
    this.postDebug("worker:coordination:request-ack", { requestId: message.requestId });
  }

  handleAttached(message: Extract<PeerMessage, { op: typeof PeerOp.Attached }>): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "attaching" || ownership.epoch !== message.leaderEpoch) return;
    this.env.clearTimer(ownership.timer);
    this.state.discovery.attachRejections = undefined;
    this.clearAttachBackoff();
    this.stopLeaderBeacon();
    this.clearRecoveryTimer();
    this.state.resources.ownership = {
      epoch: message.leaderEpoch,
      leaderId: message.leaderId,
      mailbox: ownership.mailbox,
      ownership: "follower",
    };
    this.postDebug("worker:coordination:reconnect-success", {
      leaderEpoch: message.leaderEpoch,
      leaderId: message.leaderId,
      role: "follower",
    });
    this.replayLedger();
    this.postInitSuccess(message.localConfigured);
  }

  handleRejected(message: Extract<PeerMessage, { op: typeof PeerOp.Rejected }>): void {
    const attach = this.state.resources.ownership;
    // Ignore a late rejection from a previous attach target — only the current attempt's leader
    // epoch may cancel the current pending attach (mirrors `handleAttached`).
    if (attach.ownership !== "attaching" || attach.epoch !== message.leaderEpoch) return;
    this.env.clearTimer(attach.timer);
    attach.mailbox.close();
    this.state.resources.ownership = { ownership: "seeking" };
    const error = new Error(message.error.message);
    error.name = message.error.name ?? "Error";
    if (message.code === RejectCode.DeploymentMismatch) {
      this.postLocal({
        event: {
          at: getTimerTime(),
          degradation: "deployment-mismatch",
          error: error.message,
          type: "runtime",
        },
        op: WorkerEvent.Event,
      });
      this.postDebug("worker:coordination:deployment-mismatch", {
        leaderEpoch: message.leaderEpoch,
      });
    }
    if (
      message.code === RejectCode.IdentityMismatch ||
      message.code === RejectCode.DeploymentMismatch ||
      message.code === RejectCode.StoragePathMismatch ||
      message.code === RejectCode.RemoteMismatch
    ) {
      this.fail(error);
      return;
    }
    const rejections = (this.state.discovery.attachRejections ?? 0) + 1;
    this.state.discovery.attachRejections = rejections;
    const backoff = Math.min(
      this.env.timeouts.helloIntervalMs * 2 ** Math.min(rejections, MAX_ATTACH_BACKOFF_EXPONENT),
      this.env.timeouts.leaderRecoveryTimeoutMs,
    );
    this.postDebug("worker:coordination:attach-rejected", { backoff, rejections });
    this.clearAttachBackoff();
    this.state.discovery.attachBackoff = this.env.setTimer(() => {
      this.state.discovery.attachBackoff = undefined;
      this.ensureConnected();
    }, backoff);
  }

  private clearAttachBackoff(): void {
    const timer = this.state.discovery.attachBackoff;
    if (timer === undefined) return;
    this.env.clearTimer(timer);
    this.state.discovery.attachBackoff = undefined;
  }

  handlePeerResponse(message: Extract<PeerMessage, { op: typeof PeerOp.Response }>): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "follower" || ownership.epoch !== message.leaderEpoch) return;
    this.postRuntimeResponse(message.response);
  }

  private sendOrConnect(request: WorkerRequest): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "leader" && ownership.ownership !== "follower") {
      this.postDebug("worker:coordination:request-deferred", {
        requestId: request.id,
        requestOp: request.op,
      });
      this.ensureConnected();
      return;
    }
    this.sendThroughTransport(request);
  }

  private sendThroughTransport(request: WorkerRequest): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership !== "leader" && ownership.ownership !== "follower") return;
    this.state.outbox.markSent(request.id);
    if (ownership.ownership === "leader") {
      void ownership.leader.handle(this.state.resources.localClient, request);
      return;
    }
    ownership.mailbox.send({
      fromWorkerId: this.state.address.workerId,
      leaderEpoch: ownership.epoch,
      op: PeerOp.Request,
      protocol: CoordinatorProtocol,
      request,
    });
    const epoch = ownership.epoch;
    this.state.outbox.armAckTimer(request.id, this.env.timeouts.forwardAckTimeoutMs, () => {
      const current = this.state.resources.ownership;
      if (current.ownership !== "follower" || current.epoch !== epoch) return;
      this.postDebug("worker:coordination:request-ack-timeout", {
        leaderEpoch: epoch,
        requestId: request.id,
        requestOp: request.op,
      });
      this.invalidateFollowerTransport(epoch);
    });
    this.postDebug("worker:coordination:request-forward", {
      leaderEpoch: ownership.epoch,
      requestId: request.id,
      requestOp: request.op,
    });
  }

  private replayLedger(): void {
    for (const request of this.state.outbox.ownershipRequests()) {
      this.postDebug("worker:coordination:request-replay", {
        requestId: request.id,
        requestOp: request.op,
      });
      this.sendThroughTransport(request);
    }
  }

  private ensureConnected(): void {
    if (this.isClosedOrClosing() || this.state.resources.ownership.ownership !== "seeking") return;
    this.postDebug("worker:coordination:reconnect-start", {
      workerId: this.state.address.workerId,
    });
    this.startLeaderBeacon();
  }

  private attachToLeader(leaderId: string, leaderEpoch: string, leaderScope: string): void {
    this.stopLeaderBeacon();
    this.clearPendingAttach();
    this.clearFollowerTransport();
    const mailbox = this.openSendOnlyMailbox<PeerMessage>(workerChannelName(leaderScope, leaderId));
    const timer = this.env.setTimer(() => {
      const current = this.state.resources.ownership;
      if (current.ownership !== "attaching" || current.epoch !== leaderEpoch) return;
      mailbox.close();
      this.state.resources.ownership = { ownership: "seeking" };
      this.postDebug("worker:coordination:attach-timeout", { leaderEpoch, leaderId });
      this.ensureConnected();
    }, this.env.timeouts.attachTimeoutMs);
    this.state.resources.ownership = {
      epoch: leaderEpoch,
      leaderId,
      mailbox,
      ownership: "attaching",
      timer,
    };
    this.postDebug("worker:coordination:attaching", { leaderEpoch, leaderId });
    mailbox.send({
      clientId: this.state.address.clientId,
      identity: this.state.address.identity,
      op: PeerOp.Attach,
      protocol: CoordinatorProtocol,
      remote: this.init.remote,
      scope: this.state.address.scope,
      storagePath: this.state.address.storagePath,
      workerId: this.state.address.workerId,
    });
  }

  private invalidateFollowerTransport(previousEpoch: string): void {
    this.clearFollowerTransport();
    this.state.outbox.clearAllAckTimers();
    if (this.state.discovery.recoveryTimer === undefined) {
      this.state.discovery.recoveryTimer = this.env.setTimer(() => {
        this.state.discovery.recoveryTimer = undefined;
        this.postDebug("worker:coordination:recovery-timeout", { previousEpoch });
        this.ensureConnected();
      }, this.env.timeouts.leaderRecoveryTimeoutMs);
    }
    this.postDebug("worker:coordination:reattaching", { previousEpoch });
    this.ensureConnected();
  }

  private clearFollowerTransport(): void {
    const ownership = this.state.resources.ownership;
    if (ownership.ownership === "follower") {
      ownership.mailbox.close();
      this.state.resources.ownership = { ownership: "seeking" };
    }
  }

  private async openLeaderRuntime(): Promise<LeaderRuntime> {
    this.stopLeaderBeacon();
    this.clearPendingAttach();
    this.clearAttachBackoff();
    this.clearFollowerTransport();
    this.state.outbox.clearAllAckTimers();
    this.state.resources.ownership = { ownership: "promoting" };
    this.postDebug("worker:coordination:promoting", { workerId: this.state.address.workerId });
    const runtime = await this.env.openRuntime(this.init, (response) => this.postLocal(response));
    const leader = new LeaderRuntime({
      epoch: this.env.randomId("leader"),
      identity: this.state.address.identity,
      runtime,
      scope: this.state.address.scope,
      storagePath: this.state.address.storagePath,
    });
    if (this.isClosedOrClosing()) return leader;
    leader.addLocalClient(this.state.resources.localClient);
    const { closeWorkerRemoteSocket, ensureWorkerRemoteStarted } = await import("./runtime");
    const startRemote = () => {
      if (this.init.remote === undefined) return;
      runtime.remoteReady = ensureWorkerRemoteStarted(
        runtime,
        this.init.remote,
        this.init.debug,
        (response) => this.postLocal(response),
      );
    };
    if (this.init.remote !== undefined) startRemote();
    leader.enableRecovery({
      closeRemoteSocket: () => {
        if (this.init.remote !== undefined) closeWorkerRemoteSocket(runtime);
      },
      onDeadInstance: (error) => this.releaseDeadInstance(error),
    });
    this.state.discovery.attachRejections = undefined;
    this.state.resources.ownership = { epoch: leader.epoch, leader, ownership: "leader" };
    this.state.resources.control?.send({
      identity: leader.identity,
      leaderEpoch: leader.epoch,
      leaderId: this.state.address.workerId,
      op: ControlOp.BroadcastLeader,
      protocol: CoordinatorProtocol,
      scope: this.state.address.scope,
    });
    this.clearRecoveryTimer();
    this.postDebug("worker:coordination:leader", {
      leaderEpoch: leader.epoch,
      workerId: this.state.address.workerId,
    });
    this.postDebug("worker:coordination:reconnect-success", {
      leaderEpoch: leader.epoch,
      leaderId: this.state.address.workerId,
      role: "leader",
    });
    this.replayLedger();
    this.postInitSuccess(runtime.runner.localConfigured);
    return leader;
  }

  private async holdWorkerLock(): Promise<void> {
    const acquired = deferred();
    this.state.resources.workerLease = deferred();
    void this.env.locks
      .request(workerLockName(this.state.address.scope, this.state.address.workerId), async () => {
        acquired.resolve();
        await this.state.resources.workerLease.promise;
      })
      .catch((error) => {
        acquired.reject(error);
        this.fail(error);
      });
    await acquired.promise;
  }

  /** Opens OPFS only after the page context grants this worker origin-wide ownership. */
  private acceptStorageOwnership(): Promise<void> {
    if (this.storagePromotion) return this.storagePromotion;
    if (this.isClosedOrClosing()) {
      return Promise.reject(new Error("ConvexEmbeddedClient has already been closed."));
    }
    this.postDebug("worker:coordination:storage-acquired", {
      storageId: this.state.address.identity.storageId,
    });
    const opened = deferred();
    const release = deferred();
    const released = deferred();
    const storageLease = { release, released };
    released.promise.catch(() => undefined);
    this.state.resources.storageLease = storageLease;
    this.storagePromotion = opened.promise;
    let leader: LeaderRuntime | undefined;
    void (async () => {
      try {
        leader = await this.openLeaderRuntime();
        opened.resolve();
        await release.promise;
      } catch (error) {
        opened.reject(error);
        throw error;
      } finally {
        if (
          this.state.resources.ownership.ownership === "leader" &&
          this.state.resources.ownership.leader === leader
        ) {
          this.state.resources.ownership = { ownership: "seeking" };
        }
        await leader?.close().catch(() => undefined);
        if (this.state.resources.storageLease === storageLease) {
          this.state.resources.storageLease = undefined;
        }
        this.storagePromotion = undefined;
        released.resolve();
      }
    })().catch((error) => this.fail(error));
    return opened.promise;
  }

  /** A dead store instance closes its page-granted OPFS ownership without changing durable data. */
  private releaseDeadInstance(error: unknown): void {
    const terminal = error instanceof Error ? error : new Error(String(error));
    this.postDebug("worker:coordination:store-instance-dead", {
      error: terminal.message,
    });
    // The OPFS Web Lock is held by the page, not this worker. Tell the proxy to dispose the runner
    // (whose onDispose releases that lock) before beginning the worker-side shutdown. Either side
    // completing is sufficient to prevent a dead store from continuing to accept requests.
    this.postLocal({ error: serializeError(terminal), op: WorkerEvent.Terminal });
    void this.shutdown();
  }

  private monitorFollower(leader: LeaderRuntime | undefined, follower: RemoteFollower): void {
    if (!leader) return;
    void this.env.locks
      .request(workerLockName(this.state.address.scope, follower.workerId), async () => {
        const ownership = this.state.resources.ownership;
        if (ownership.ownership !== "leader" || ownership.leader !== leader) return;
        leader.followerDelete(follower.workerId);
      })
      .catch((error) => this.postDebug("worker:coordination:follower-monitor-error", error));
  }

  private startLeaderBeacon(): void {
    const { discovery } = this.state;
    if (
      discovery.leaderBeacon !== undefined ||
      this.state.resources.ownership.ownership !== "seeking"
    ) {
      return;
    }
    const send = () => {
      if (this.isClosedOrClosing() || this.state.resources.ownership.ownership !== "seeking") {
        this.state.discovery.leaderBeacon = undefined;
        return;
      }
      this.state.resources.control?.send({
        clientId: this.state.address.clientId,
        identity: this.state.address.identity,
        op: ControlOp.SeekLeader,
        protocol: CoordinatorProtocol,
        scope: this.state.address.scope,
        storagePath: this.state.address.storagePath,
        workerId: this.state.address.workerId,
      });
      this.state.discovery.leaderBeacon = this.env.setTimer(
        send,
        this.env.timeouts.helloIntervalMs,
      );
    };
    this.postDebug("worker:coordination:candidate", { workerId: this.state.address.workerId });
    send();
  }

  private stopLeaderBeacon(): void {
    const beacon = this.state.discovery.leaderBeacon;
    if (beacon === undefined) return;
    this.env.clearTimer(beacon);
    this.state.discovery.leaderBeacon = undefined;
  }

  private clearPendingAttach(): void {
    const attach = this.state.resources.ownership;
    if (attach.ownership !== "attaching") return;
    this.env.clearTimer(attach.timer);
    attach.mailbox.close();
    this.state.resources.ownership = { ownership: "seeking" };
  }

  private clearRecoveryTimer(): void {
    const timer = this.state.discovery.recoveryTimer;
    if (timer === undefined) return;
    this.env.clearTimer(timer);
    this.state.discovery.recoveryTimer = undefined;
  }

  private postRuntimeResponse(response: WorkerResponse): void {
    this.state.outbox.complete(response);
    if (response.op === WorkerEvent.Result) {
      this.postDebug("worker:coordination:request-settled", { requestId: response.id });
    }
    this.postLocal(response);
  }

  private postDebug(phase: string, detail?: unknown): void {
    if (!this.init.debug) return;
    this.postLocal({ detail, op: WorkerEvent.Debug, phase });
  }

  /** The init result is the runtime's device-only module configuration, for the client's errors. */
  private postInitSuccess(localConfigured: boolean | undefined): void {
    const lifecycle = this.state.lifecycle;
    if (lifecycle.lifecycle !== "starting") return;
    lifecycle.initReady.resolve();
    this.state.lifecycle = { lifecycle: "active" };
    this.postLocal({ id: this.init.id, op: WorkerEvent.Result, result: localConfigured });
  }

  private postInitError(error: unknown): void {
    const lifecycle = this.state.lifecycle;
    if (lifecycle.lifecycle !== "starting") return;
    this.postLocal({
      error: serializeError(error),
      id: this.init.id,
      op: WorkerEvent.Result,
    });
    lifecycle.initReady.reject(error);
  }

  private fail(error: unknown): void {
    this.postInitError(error);
    this.state.outbox.rejectAll(error);
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    const lifecycle = this.state.lifecycle;
    if (lifecycle.lifecycle === "closed") return;
    if (lifecycle.lifecycle === "closing") return lifecycle.closePromise;
    const closePromise = this.doShutdown();
    this.state.lifecycle = { closePromise, lifecycle: "closing" };
    return closePromise;
  }

  private async doShutdown(): Promise<void> {
    this.stopLeaderBeacon();
    this.clearRecoveryTimer();
    this.clearPendingAttach();
    this.clearAttachBackoff();
    const ownership = this.state.resources.ownership;
    const leader = ownership.ownership === "leader" ? ownership.leader : undefined;
    this.clearFollowerTransport();
    this.clearPendingAttach();
    this.state.resources.ownership = { ownership: "closed" };
    const storageLease = this.state.resources.storageLease;
    storageLease?.release.resolve();
    if (storageLease) await storageLease.released.promise;
    else await leader?.close().catch(() => undefined);
    this.state.outbox.rejectAll(new Error("ConvexEmbeddedClient has been closed."));
    this.state.resources.control?.close();
    this.state.resources.workerMailbox?.close();
    this.state.resources.workerLease.resolve();
    this.state.lifecycle = { lifecycle: "closed" };
    if (this.closeRequestId !== undefined) {
      this.postLocal({ id: this.closeRequestId, op: WorkerEvent.Result });
    }
    this.env.closeSelf();
  }

  private openMailbox<T>(name: string, handler: (message: T) => void): Mailbox<T> {
    const mailbox = new Mailbox<T>(name, this.env.channels.open(name));
    mailbox.on(handler);
    return mailbox;
  }

  /** The leader replies on this worker's own channel, so these mailboxes never listen. */
  private openSendOnlyMailbox<T>(name: string): Mailbox<T> {
    return new Mailbox<T>(name, this.env.channels.open(name), { listen: false });
  }

  private isClosedOrClosing(): boolean {
    return (
      this.state.lifecycle.lifecycle === "closing" || this.state.lifecycle.lifecycle === "closed"
    );
  }

  private readonly onControlMessage = (message: ControlMessage): void => {
    if (!isControlMessage(message) || this.isClosedOrClosing()) return;
    controlHandlers.get(message.op)?.(this, message as never);
  };

  private readonly onPeerMessage = (message: PeerMessage): void => {
    if (!isPeerMessage(message) || this.isClosedOrClosing()) return;
    peerHandlers.get(message.op)?.(this, message as never);
  };
}

function mergeEnv(overrides: CoordinatorEnvOverrides): CoordinatorEnv {
  return {
    assertCapabilities: overrides.assertCapabilities ?? assertRuntimeCapabilities,
    channels: overrides.channels ?? {
      open: (name) => {
        const BroadcastChannel = (
          globalThis as {
            BroadcastChannel?: new (name: string) => ReturnType<CoordinatorEnv["channels"]["open"]>;
          }
        ).BroadcastChannel;
        if (typeof BroadcastChannel !== "function") {
          throw new Error(
            "ConvexEmbeddedClient browser runtime requires BroadcastChannel support.",
          );
        }
        return new BroadcastChannel(name);
      },
    },
    clearTimer: overrides.clearTimer ?? ((timer) => clearTimeout(timer)),
    closeSelf: overrides.closeSelf ?? (() => workerGlobal().close?.()),
    locks: overrides.locks ?? requiredLockManager(),
    openRuntime:
      overrides.openRuntime ??
      ((request, post) =>
        import("./runtime").then(({ initFromMessage }) =>
          initFromMessage(request, post, { events: false }),
        )),
    postLocal: overrides.postLocal ?? ((response) => workerGlobal().postMessage?.(response)),
    randomId: overrides.randomId ?? randomId,
    setTimer: overrides.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
    timeouts: { ...DEFAULT_COORDINATOR_TIMEOUTS, ...overrides.timeouts },
  };
}

function toEnv(options: CoordinatorOptions): CoordinatorEnvOverrides {
  return {
    assertCapabilities: options.assertCapabilities,
    channels: options.channelFactory ? { open: options.channelFactory } : undefined,
    closeSelf: options.close,
    locks: options.locks,
    openRuntime: options.initRuntime,
    postLocal: options.post,
    randomId: options.workerId
      ? (prefix) => (prefix === "worker" ? options.workerId! : randomId(prefix))
      : undefined,
    timeouts: options.timeouts,
  };
}

function postDefault(message: WorkerResponse): void {
  // Responses may contain user ArrayBuffers; structured clone preserves sender ownership.
  workerGlobal().postMessage?.(message);
}

function workerCoordinatorState(): { runtime?: CoordinatorRuntime } {
  const key = "__CONVEX_EMBEDDED_COORDINATOR__";
  const global = workerGlobal() as ReturnType<typeof workerGlobal> & {
    [key]?: { runtime?: CoordinatorRuntime };
  };
  global[key] ??= {};
  return global[key];
}
