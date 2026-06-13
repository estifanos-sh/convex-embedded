import { randomId } from "../util";
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
import { RequestLedger } from "./coordinator/ledger";
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
  storageOwnerLockName,
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
  serializeErrorLike,
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

export const LifecyclePhase = {
  Starting: 1,
  Active: 2,
  Closing: 3,
  Closed: 4,
} as const;

type LifecyclePhaseCode = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];
type Timer = ReturnType<CoordinatorEnv["setTimer"]>;
type CoordinatorEnvOverrides = Partial<Omit<CoordinatorEnv, "timeouts">> & {
  timeouts?: Partial<CoordinatorTimeouts>;
};

type RuntimeTransport =
  | { epoch: string; kind: "leader"; leader: LeaderRuntime }
  | { epoch: string; kind: "follower"; leaderId: string; mailbox: Mailbox<PeerMessage> };

interface PendingAttach {
  leaderEpoch: string;
  leaderId: string;
  mailbox: Mailbox<PeerMessage>;
  timer: Timer;
}

interface RuntimeAddress {
  clientId: string;
  controlName: string;
  identity: NonNullable<InitRequest["identity"]>;
  scope: string;
  storagePath: string;
  workerChannelName: string;
  workerId: string;
}

interface Lifecycle {
  closePromise?: Promise<void>;
  initReady: Deferred;
  initResponded: boolean;
  phase: LifecyclePhaseCode;
}

interface LeaderDiscovery {
  /** Consecutive retryable attach rejections in the current discovery round. */
  attachRejections?: number;
  /** Backoff timer scheduled after a retryable attach rejection, tracked so it can be cancelled. */
  attachBackoff?: Timer;
  connecting?: Promise<void>;
  leaderBeacon?: Timer;
  pendingAttach?: PendingAttach;
  recoveryTimer?: Timer;
}

/** Consecutive retryable rejections tolerated before discovery fails loudly. */
const MAX_ATTACH_REJECTIONS = 8;

interface RuntimeResources {
  control?: Mailbox<ControlMessage>;
  localClient: LeaderClient;
  storageLease?: Deferred;
  transport?: RuntimeTransport;
  workerLease: Deferred;
  workerMailbox?: Mailbox<PeerMessage>;
}

interface CoordinatorState {
  address: RuntimeAddress;
  discovery: LeaderDiscovery;
  ledger: RequestLedger;
  lifecycle: Lifecycle;
  resources: RuntimeResources;
}

type RuntimeRequest = Exclude<
  WorkerRequest,
  Extract<
    WorkerRequest,
    {
      op: typeof WorkerCommand.Close | typeof WorkerCommand.Heartbeat | typeof WorkerCommand.Init;
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
  [WorkerCommand.Heartbeat, () => undefined],
  [
    WorkerCommand.Init,
    (runtime, request) =>
      runtime.postLocal({
        error: serializeError(new Error("Convex embedded worker is already initialized.")),
        id: request.id,
        op: WorkerEvent.Result,
      }),
  ],
  [WorkerCommand.Mutation, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
  [WorkerCommand.Query, (runtime, request) => runtime.handleRuntimeRequest(request as never)],
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
  let runtime: CoordinatorRuntime | undefined;
  workerGlobal().onmessage = (event) => {
    const request = event.data as WorkerRequest;
    if (request.op === WorkerCommand.Init) {
      if (runtime) {
        postDefault({
          error: serializeError(new Error("Convex embedded worker is already initialized.")),
          id: request.id,
          op: WorkerEvent.Result,
        });
        return;
      }
      try {
        runtime = createCoordinatorRuntime(request, toEnv(options));
        void runtime.start();
      } catch (error) {
        postDefault({ error: serializeError(error), id: request.id, op: WorkerEvent.Result });
      }
      return;
    }
    if (!runtime) {
      postDefault({
        error: serializeError(new Error("Convex embedded worker has not been initialized.")),
        id: request.id,
        op: WorkerEvent.Result,
      });
      return;
    }
    runtime.handle(request);
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
  private readonly state: CoordinatorState;

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
      controlName: controlChannelName(scope),
      identity: init.identity,
      scope,
      storagePath: init.storagePath,
      workerChannelName: workerChannelName(scope, workerId),
      workerId,
    };
    const ledger = new RequestLedger({
      clearTimer: (timer) => this.env.clearTimer(timer),
      post: (response) => this.postLocal(response),
      setTimer: (callback, ms) => this.env.setTimer(callback, ms),
    });
    const localClient: LeaderClient = {
      id: localClientKey(workerId, id),
      post: (response) => this.postRuntimeResponse(response),
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
      ledger,
      lifecycle: {
        initReady,
        initResponded: false,
        phase: LifecyclePhase.Starting,
      },
      resources: {
        localClient,
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
      this.requestStorageLease();
      this.ensureConnected();
      await this.state.lifecycle.initReady.promise;
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
      this.state.ledger.record(request);
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
    this.state.ledger.record(request);
    if (this.state.resources.transport) {
      this.sendThroughTransport(request);
      void this.state.ledger.onSettled(request.id).finally(() => {
        void this.shutdown();
      });
      return;
    }
    this.postRuntimeResponse({ id: request.id, op: WorkerEvent.Result });
    void this.shutdown();
  }

  handleSeekLeader(message: Extract<ControlMessage, { op: typeof ControlOp.SeekLeader }>): void {
    if (message.workerId === this.state.address.workerId) return;
    const transport = this.state.resources.transport;
    if (transport?.kind !== "leader") return;
    this.state.resources.control?.send({
      identity: transport.leader.identity,
      leaderEpoch: transport.epoch,
      leaderId: this.state.address.workerId,
      op: ControlOp.BroadcastLeader,
      protocol: CoordinatorProtocol,
    });
  }

  handleBroadcastLeader(
    message: Extract<ControlMessage, { op: typeof ControlOp.BroadcastLeader }>,
  ): void {
    if (message.leaderId === this.state.address.workerId) return;
    const { discovery, resources } = this.state;
    if (resources.transport?.kind === "leader") return;
    if (
      resources.transport?.kind === "follower" &&
      resources.transport.epoch === message.leaderEpoch
    ) {
      return;
    }
    if (discovery.pendingAttach?.leaderEpoch === message.leaderEpoch) return;
    this.attachToLeader(message.leaderId, message.leaderEpoch);
  }

  handleAttach(message: Extract<PeerMessage, { op: typeof PeerOp.Attach }>): void {
    const transport = this.state.resources.transport;
    if (message.workerId === this.state.address.workerId || transport?.kind !== "leader") return;
    transport.leader.attachFollower(
      message,
      (name) => this.env.channels.open(name),
      (follower) =>
        this.monitorFollower(
          this.state.resources.transport?.kind === "leader"
            ? this.state.resources.transport.leader
            : undefined,
          follower,
        ),
      this.state.address.workerId,
    );
  }

  handlePeerRequest(message: Extract<PeerMessage, { op: typeof PeerOp.Request }>): void {
    const transport = this.state.resources.transport;
    if (message.fromWorkerId === this.state.address.workerId || transport?.kind !== "leader") {
      return;
    }
    if (message.leaderEpoch !== transport.epoch) return;
    void transport.leader.handlePeerRequest(message);
  }

  handleRequestAck(message: Extract<PeerMessage, { op: typeof PeerOp.RequestAck }>): void {
    const transport = this.state.resources.transport;
    if (transport?.kind !== "follower" || transport.epoch !== message.leaderEpoch) return;
    this.state.ledger.acknowledge(message.requestId);
    this.postDebug("worker:coordination:request-ack", { requestId: message.requestId });
  }

  handleAttached(message: Extract<PeerMessage, { op: typeof PeerOp.Attached }>): void {
    const attach = this.state.discovery.pendingAttach;
    if (!attach || attach.leaderEpoch !== message.leaderEpoch) return;
    this.env.clearTimer(attach.timer);
    this.state.discovery.pendingAttach = undefined;
    this.state.discovery.attachRejections = undefined;
    this.clearAttachBackoff();
    this.stopLeaderBeacon();
    this.clearRecoveryTimer();
    this.state.resources.transport = {
      epoch: message.leaderEpoch,
      kind: "follower",
      leaderId: message.leaderId,
      mailbox: attach.mailbox,
    };
    this.resolveConnecting();
    this.postInitSuccess();
    this.postDebug("worker:coordination:reconnect-success", {
      leaderEpoch: message.leaderEpoch,
      leaderId: message.leaderId,
      role: "follower",
    });
    this.replayLedger();
  }

  handleRejected(message: Extract<PeerMessage, { op: typeof PeerOp.Rejected }>): void {
    const attach = this.state.discovery.pendingAttach;
    // Ignore a late rejection from a previous attach target — only the current attempt's leader
    // epoch may cancel the current pending attach (mirrors `handleAttached`).
    if (!attach || attach.leaderEpoch !== message.leaderEpoch) return;
    this.env.clearTimer(attach.timer);
    attach.mailbox.close();
    this.state.discovery.pendingAttach = undefined;
    const error = new Error(message.error.message);
    error.name = message.error.name ?? "Error";
    if (
      message.code === RejectCode.IdentityMismatch ||
      message.code === RejectCode.StoragePathMismatch
    ) {
      this.fail(error);
      return;
    }
    const rejections = (this.state.discovery.attachRejections ?? 0) + 1;
    this.state.discovery.attachRejections = rejections;
    if (rejections >= MAX_ATTACH_REJECTIONS) {
      this.fail(
        new Error(
          `ConvexEmbeddedClient failed to attach to the browser runtime leader after ${rejections} attempts: ${message.error.message}`,
        ),
      );
      return;
    }
    const backoff = Math.min(
      this.env.timeouts.helloIntervalMs * 2 ** rejections,
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
    const transport = this.state.resources.transport;
    if (transport?.kind !== "follower" || transport.epoch !== message.leaderEpoch) return;
    this.postRuntimeResponse(message.response);
  }

  private sendOrConnect(request: WorkerRequest): void {
    if (!this.state.resources.transport) {
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
    const transport = this.state.resources.transport;
    if (!transport) return;
    this.state.ledger.markSent(request.id);
    if (transport.kind === "leader") {
      void transport.leader.handle(this.state.resources.localClient, request);
      return;
    }
    transport.mailbox.send({
      fromWorkerId: this.state.address.workerId,
      leaderEpoch: transport.epoch,
      op: PeerOp.Request,
      protocol: CoordinatorProtocol,
      request,
    });
    const epoch = transport.epoch;
    this.state.ledger.armAckTimer(request.id, this.env.timeouts.forwardAckTimeoutMs, () => {
      const current = this.state.resources.transport;
      if (current?.kind !== "follower" || current.epoch !== epoch) return;
      this.postDebug("worker:coordination:request-ack-timeout", {
        leaderEpoch: epoch,
        requestId: request.id,
        requestOp: request.op,
      });
      this.invalidateFollowerTransport(epoch);
    });
    this.postDebug("worker:coordination:request-forward", {
      leaderEpoch: transport.epoch,
      requestId: request.id,
      requestOp: request.op,
    });
  }

  private replayLedger(): void {
    for (const request of this.state.ledger.replayableRequests()) {
      this.postDebug("worker:coordination:request-replay", {
        requestId: request.id,
        requestOp: request.op,
      });
      this.sendThroughTransport(request);
    }
  }

  private ensureConnected(): void {
    const { discovery, resources } = this.state;
    // Already connected (leader OR an established follower) — nothing to seek. The recovery path
    // clears the follower transport before re-seeking, so this does not block reconnection; it
    // only stops a stray attach-backoff timer from restarting the beacon on a healthy follower.
    if (this.isClosedOrClosing() || resources.transport !== undefined) return;
    if (!discovery.connecting) {
      const ready = deferred();
      discovery.connecting = ready.promise;
      ready.promise.catch(() => undefined);
      this.postDebug("worker:coordination:reconnect-start", {
        workerId: this.state.address.workerId,
      });
    }
    this.startLeaderBeacon();
  }

  private resolveConnecting(): void {
    this.state.discovery.connecting = undefined;
  }

  private attachToLeader(leaderId: string, leaderEpoch: string): void {
    const { discovery } = this.state;
    this.stopLeaderBeacon();
    discovery.pendingAttach?.mailbox.close();
    if (discovery.pendingAttach) this.env.clearTimer(discovery.pendingAttach.timer);
    this.clearFollowerTransport();
    const mailbox = this.openSendOnlyMailbox<PeerMessage>(
      workerChannelName(this.state.address.scope, leaderId),
    );
    const timer = this.env.setTimer(() => {
      if (this.state.discovery.pendingAttach?.leaderEpoch !== leaderEpoch) return;
      mailbox.close();
      this.state.discovery.pendingAttach = undefined;
      this.postDebug("worker:coordination:attach-timeout", { leaderEpoch, leaderId });
      this.ensureConnected();
    }, this.env.timeouts.attachTimeoutMs);
    discovery.pendingAttach = { leaderEpoch, leaderId, mailbox, timer };
    this.postDebug("worker:coordination:attaching", { leaderEpoch, leaderId });
    mailbox.send({
      clientId: this.state.address.clientId,
      identity: this.state.address.identity,
      op: PeerOp.Attach,
      protocol: CoordinatorProtocol,
      storagePath: this.state.address.storagePath,
      workerId: this.state.address.workerId,
    });
  }

  private invalidateFollowerTransport(previousEpoch: string): void {
    this.clearFollowerTransport();
    this.state.ledger.clearAllAckTimers();
    if (!this.state.discovery.recoveryTimer) {
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
    const transport = this.state.resources.transport;
    if (transport?.kind === "follower") {
      transport.mailbox.close();
      this.state.resources.transport = undefined;
    }
  }

  private async openLeaderRuntime(): Promise<LeaderRuntime> {
    this.stopLeaderBeacon();
    this.clearPendingAttach();
    this.clearAttachBackoff();
    this.clearFollowerTransport();
    this.state.ledger.clearAllAckTimers();
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
    this.state.discovery.attachRejections = undefined;
    this.state.resources.transport = { epoch: leader.epoch, kind: "leader", leader };
    this.state.resources.control?.send({
      identity: leader.identity,
      leaderEpoch: leader.epoch,
      leaderId: this.state.address.workerId,
      op: ControlOp.BroadcastLeader,
      protocol: CoordinatorProtocol,
    });
    this.clearRecoveryTimer();
    this.resolveConnecting();
    this.postInitSuccess();
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

  private requestStorageLease(): void {
    void this.env.locks
      .request(storageOwnerLockName(this.state.address.identity), async () => {
        if (this.isClosedOrClosing()) return;
        const release = deferred();
        this.state.resources.storageLease = release;
        let leader: LeaderRuntime | undefined;
        try {
          leader = await this.openLeaderRuntime();
          await release.promise;
        } finally {
          if (
            this.state.resources.transport?.kind === "leader" &&
            this.state.resources.transport.leader === leader
          ) {
            this.state.resources.transport = undefined;
          }
          await leader?.close().catch(() => undefined);
        }
      })
      .catch((error) => this.fail(error));
  }

  private monitorFollower(leader: LeaderRuntime | undefined, follower: RemoteFollower): void {
    if (!leader) return;
    void this.env.locks
      .request(workerLockName(this.state.address.scope, follower.workerId), async () => {
        const transport = this.state.resources.transport;
        if (transport?.kind !== "leader" || transport.leader !== leader) return;
        leader.cleanupFollower(follower.workerId);
      })
      .catch((error) => this.postDebug("worker:coordination:follower-monitor-error", error));
  }

  private startLeaderBeacon(): void {
    const { discovery, resources } = this.state;
    if (discovery.leaderBeacon || resources.transport?.kind === "leader") return;
    const send = () => {
      if (this.isClosedOrClosing() || this.state.resources.transport?.kind === "leader") {
        this.state.discovery.leaderBeacon = undefined;
        return;
      }
      this.state.resources.control?.send({
        clientId: this.state.address.clientId,
        identity: this.state.address.identity,
        op: ControlOp.SeekLeader,
        protocol: CoordinatorProtocol,
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
    if (!beacon) return;
    this.env.clearTimer(beacon);
    this.state.discovery.leaderBeacon = undefined;
  }

  private clearPendingAttach(): void {
    const attach = this.state.discovery.pendingAttach;
    if (!attach) return;
    this.env.clearTimer(attach.timer);
    attach.mailbox.close();
    this.state.discovery.pendingAttach = undefined;
  }

  private clearRecoveryTimer(): void {
    const timer = this.state.discovery.recoveryTimer;
    if (!timer) return;
    this.env.clearTimer(timer);
    this.state.discovery.recoveryTimer = undefined;
  }

  private postRuntimeResponse(response: WorkerResponse): void {
    this.state.ledger.settle(response);
    if (response.op === WorkerEvent.Result) {
      this.postDebug("worker:coordination:request-settled", { requestId: response.id });
    }
    this.postLocal(response);
  }

  private postDebug(phase: string, detail?: unknown): void {
    if (!this.init.debug) return;
    this.postLocal({ detail, op: WorkerEvent.Debug, phase });
  }

  private postInitSuccess(): void {
    if (this.state.lifecycle.initResponded) return;
    this.state.lifecycle.initResponded = true;
    this.state.lifecycle.phase = LifecyclePhase.Active;
    this.postLocal({ id: this.init.id, op: WorkerEvent.Result });
    this.state.lifecycle.initReady.resolve();
  }

  private postInitError(error: unknown): void {
    if (this.state.lifecycle.initResponded) return;
    this.state.lifecycle.initResponded = true;
    this.postLocal({
      error: serializeErrorLike(error),
      id: this.init.id,
      op: WorkerEvent.Result,
    });
    this.state.lifecycle.initReady.reject(error);
  }

  private fail(error: unknown): void {
    this.postInitError(error);
    this.state.ledger.rejectAll(error);
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.state.lifecycle.closePromise ??= this.doShutdown();
    return this.state.lifecycle.closePromise;
  }

  private async doShutdown(): Promise<void> {
    if (this.state.lifecycle.phase === LifecyclePhase.Closed) return;
    if (this.state.lifecycle.phase === LifecyclePhase.Closing) return;
    this.state.lifecycle.phase = LifecyclePhase.Closing;
    this.stopLeaderBeacon();
    this.clearRecoveryTimer();
    this.clearPendingAttach();
    this.clearAttachBackoff();
    const leader =
      this.state.resources.transport?.kind === "leader"
        ? this.state.resources.transport.leader
        : undefined;
    this.clearFollowerTransport();
    this.state.resources.transport = undefined;
    this.state.resources.storageLease?.resolve();
    await leader?.close().catch(() => undefined);
    this.state.ledger.rejectAll(new Error("ConvexEmbeddedClient has been closed."));
    this.state.resources.control?.close();
    this.state.resources.workerMailbox?.close();
    this.state.resources.workerLease.resolve();
    this.state.lifecycle.phase = LifecyclePhase.Closed;
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
      this.state.lifecycle.phase === LifecyclePhase.Closing ||
      this.state.lifecycle.phase === LifecyclePhase.Closed
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
        import("./runtime").then(({ initFromMessage }) => initFromMessage(request, post))),
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
