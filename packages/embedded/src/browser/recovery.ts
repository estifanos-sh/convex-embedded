/**
 * Store-instance recovery primitives for the browser runtime leader.
 *
 * @remarks
 * The unit of failure is the WASM store instance (shared linear memory plus the emnapi pthread
 * pool) owned by the coordinator-leader under its Web Locks storage lease. These primitives detect
 * a wedged instance (progress-based watchdog), fail that instance closed, and pace WAL writes.
 * A hung WASM promise can retain its linear memory indefinitely, so recovery never opens another
 * store inside the same worker.
 *
 * @internal
 */

/** A lane op is suspect after this long with no progress signal — under the proxy's 30s window. */
export const WATCHDOG_IDLE_MS = 20_000;
/** How often the watchdog re-evaluates armed lanes. */
export const WATCHDOG_POLL_MS = 1_000;
/** Rebuilds tolerated inside {@link REBUILD_WINDOW_MS} before the breaker trips. */
export const REBUILD_MAX = 3;
/** Sliding window the breaker counts rebuilds over. */
export const REBUILD_WINDOW_MS = 300_000;
/** Idle time after the last drain before a WAL write is paced. */
export const WAL_WRITE_IDLE_MS = 30_000;

/** Progress-guarded lanes the watchdog covers. `wal-write` is an instance-lane fault. */
export type WatchdogLane = "push" | "pull" | "remote-start" | "wal-write";

/** A rebuild triggered by a remote-only lane may keep the last good instance; anything else is fatal. */
export type RebuildLaneClass = "remote" | "instance";

/** Clock and timer seam so the watchdog and WAL-write pacing are deterministic under test. */
export interface RecoveryTimer {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimer: RecoveryTimer = {
  now: () => performance.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Progress-based watchdog over the store instance's lanes. A lane armed with {@link arm} becomes
 * SUSPECT once {@link WATCHDOG_IDLE_MS} elapses with no {@link progress} signal; the first suspect
 * latches until {@link reset} so terminal handling is entered exactly once.
 */
export class Watchdog {
  private nextToken = 1;
  private ticker: unknown;
  private suspected = false;
  private readonly active = new Map<
    number,
    { armedAt: number; lane: WatchdogLane; lastProgressAt: number }
  >();

  constructor(
    private readonly onSuspect: (lane: WatchdogLane) => void,
    private readonly idleMs: number = WATCHDOG_IDLE_MS,
    private readonly timer: RecoveryTimer = defaultTimer,
    private readonly pollMs: number = WATCHDOG_POLL_MS,
  ) {}

  /** Records liveness for one lane, or all lanes when called without a lane by direct users. */
  progress(lane?: WatchdogLane): void {
    const at = this.timer.now();
    for (const entry of this.active.values()) {
      if (lane === undefined || entry.lane === lane) entry.lastProgressAt = at;
    }
  }

  /** Arms a lane; the returned disarm is idempotent and safe to call after a {@link reset}. */
  arm(lane: WatchdogLane): () => void {
    const token = this.nextToken++;
    const armedAt = this.timer.now();
    this.active.set(token, { armedAt, lane, lastProgressAt: armedAt });
    if (this.ticker === undefined) {
      this.ticker = this.timer.setInterval(() => this.check(), this.pollMs);
    }
    return () => {
      this.active.delete(token);
      this.stopTickingIfIdle();
    };
  }

  /** True once a lane has been abandoned and before the next {@link reset}. */
  get isSuspect(): boolean {
    return this.suspected;
  }

  /** Clears the suspect latch and all armed lanes so the reused watchdog covers the fresh instance. */
  reset(): void {
    this.suspected = false;
    this.active.clear();
    this.stopTickingIfIdle();
  }

  /** Re-arms a suspected lane without forgetting that its operation is still running. */
  retry(lane: WatchdogLane): void {
    const at = this.timer.now();
    for (const entry of this.active.values()) {
      if (entry.lane !== lane) continue;
      entry.armedAt = at;
      entry.lastProgressAt = at;
    }
    this.suspected = false;
  }

  dispose(): void {
    this.active.clear();
    this.stopTickingIfIdle();
  }

  private stopTickingIfIdle(): void {
    if (this.active.size > 0 || this.ticker === undefined) return;
    this.timer.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private check(): void {
    if (this.suspected) return;
    const cutoff = this.timer.now() - this.idleMs;
    for (const entry of this.active.values()) {
      if (Math.max(entry.armedAt, entry.lastProgressAt) <= cutoff) {
        this.suspected = true;
        this.onSuspect(entry.lane);
        return;
      }
    }
  }
}

/**
 * Sliding-window crash-loop breaker. {@link record} returns whether the rebuild about to run would
 * exceed {@link REBUILD_MAX} within {@link REBUILD_WINDOW_MS}; the caller then reads
 * {@link windowLaneClasses} through {@link classifyTrip} to choose the terminal state.
 */
export class CrashBreaker {
  private readonly events: Array<{ at: number; laneClass: RebuildLaneClass }> = [];

  constructor(
    private readonly max: number = REBUILD_MAX,
    private readonly windowMs: number = REBUILD_WINDOW_MS,
  ) {}

  record(now: number, laneClass: RebuildLaneClass): boolean {
    this.expiredDelete(now);
    this.events.push({ at: now, laneClass });
    return this.events.length > this.max;
  }

  windowLaneClasses(): RebuildLaneClass[] {
    return this.events.map((event) => event.laneClass);
  }

  private expiredDelete(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]!.at <= cutoff) this.events.shift();
  }
}

/**
 * Chooses the breaker's terminal state: keep-last-good (`lane-only`) only when the last rebuild
 * succeeded and every fault in the window came from a remote lane; otherwise the instance is DEAD.
 */
export function classifyTrip(
  laneClasses: readonly RebuildLaneClass[],
  lastRebuildSucceeded: boolean,
): "lane-only" | "dead" {
  return lastRebuildSucceeded && laneClasses.every((laneClass) => laneClass === "remote")
    ? "lane-only"
    : "dead";
}

/** Maps a suspect lane to its breaker class: only the two push/pull lanes are remote-recoverable. */
export function laneClassOf(lane: WatchdogLane): RebuildLaneClass {
  return lane === "push" || lane === "pull" ? "remote" : "instance";
}

/** Inputs to the WAL-write pacing decision. */
export interface WalWriteDecision {
  now: number;
  lastActivityAt: number;
  lastWalWriteAt: number;
  remoteBusy: boolean;
  idleMs?: number;
}

/**
 * True when the push queue has drained (no remote work in flight) and the store has been idle for
 * {@link WAL_WRITE_IDLE_MS} since both the last activity and the last WAL write.
 */
export function walWriteDue(decision: WalWriteDecision): boolean {
  if (decision.remoteBusy) return false;
  const idleMs = decision.idleMs ?? WAL_WRITE_IDLE_MS;
  if (decision.now - decision.lastActivityAt < idleMs) return false;
  if (decision.now - decision.lastWalWriteAt < idleMs) return false;
  return true;
}

/**
 * Builds the indeterminate-mutation error a rebuild hands back to in-flight `leader.mutations`
 * waiters. `name` matches the outbox/proxy crash semantics so a client dedupes it identically.
 */
export function rebuildIndeterminateMutationError(): Error {
  const error = new Error(
    "The mutation was accepted but its result is indeterminate after a store-instance rebuild.",
  );
  error.name = "ConvexEmbeddedMutationIndeterminateError";
  return error;
}

/** An in-flight mutation whose waiter a rebuild can settle. */
export interface RebuildableMutation {
  reject(error: unknown): void;
}

/**
 * Rejects and clears every in-flight mutation so a client retry of the same mutationId is not
 * handed a promise bound to the abandoned instance.
 */
export function rejectMutationsForRebuild(
  mutations: Map<string, RebuildableMutation>,
  error: Error = rebuildIndeterminateMutationError(),
): void {
  for (const mutation of mutations.values()) mutation.reject(error);
  mutations.clear();
}

/**
 * Actions the recovery controller drives on the leader-owned store instance. Lease release
 * (`deadInstance`) and event emission are leader/coordinator concerns; this module owns only when
 * they fire.
 */
export interface RecoveryHost {
  now(): number;
  emitDegraded(error: string): void;
  emitReady(): void;
  emitRemoteError(error: string): void;
  rebuild(): Promise<void>;
  stopRemote(): void;
  closeRemoteSocket?(): void;
  deadInstance(error: Error): void;
  walWrite(): Promise<void>;
}

export interface StoreRecoveryOptions {
  idleMs?: number;
  pollMs?: number;
  rebuildMax?: number;
  rebuildWindowMs?: number;
  walWriteIdleMs?: number;
  walWritePollMs?: number;
  timer?: RecoveryTimer;
}

/**
 * Drives detection, containment, and WAL-write pacing for one store instance.
 */
export class StoreRecovery {
  readonly watchdog: Watchdog;
  private readonly timer: RecoveryTimer;
  private readonly walWriteIdleMs: number;
  private readonly idleMs: number;
  private readonly walWriteTicker: unknown;
  private rebuilding = false;
  private remoteBusy = false;
  private disposed = false;
  private generation = 0;
  private lastActivityAt: number;
  private lastWalWriteAt: number;
  private lastTransportActivityAt: number;
  private readonly silentRetries = new Map<WatchdogLane, number>();

  constructor(
    private readonly host: RecoveryHost,
    options: StoreRecoveryOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.walWriteIdleMs = options.walWriteIdleMs ?? WAL_WRITE_IDLE_MS;
    this.idleMs = options.idleMs ?? WATCHDOG_IDLE_MS;
    this.lastTransportActivityAt = this.timer.now();
    this.watchdog = new Watchdog(
      (lane) => this.onSuspect(lane),
      options.idleMs ?? WATCHDOG_IDLE_MS,
      this.timer,
      options.pollMs ?? WATCHDOG_POLL_MS,
    );
    this.lastActivityAt = this.timer.now();
    this.lastWalWriteAt = this.timer.now();
    this.walWriteTicker = this.timer.setInterval(
      () => void this.walWrite(),
      options.walWritePollMs ?? this.walWriteIdleMs,
    );
  }

  /** Arms a lane for the duration of a store op; returns the disarm to call in `finally`. */
  arm(lane: WatchdogLane): () => void {
    const disarm = this.watchdog.arm(lane);
    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      disarm();
      this.silentRetries.delete(lane);
    };
  }

  /** The token a transport/loop captures at creation so a restart ages out its stale signals. */
  get remoteGeneration(): number {
    return this.generation;
  }

  /** Records lane progress that resets the idle deadline; a stale-generation signal is ignored. */
  progress(generation?: number, lane?: WatchdogLane): void {
    if (generation !== undefined && generation !== this.generation) return;
    if (lane !== undefined) this.watchdog.progress(lane);
    this.lastTransportActivityAt = this.timer.now();
  }

  /** Records raw socket liveness for the network/store discriminator without resetting the deadline. */
  transportActive(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.lastTransportActivityAt = this.timer.now();
  }

  /** A surfaced pthread error while lanes are idle marks the pool dead and rebuilds early. */
  reportThreadError(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.onSuspect("wal-write");
  }

  onRemoteActive(): void {
    this.remoteBusy = true;
    this.lastActivityAt = this.timer.now();
  }

  /** Clears the in-flight turn fence even when the turn failed or scheduled more work. */
  onRemoteSettled(): void {
    this.remoteBusy = false;
  }

  onRemoteIdle(): void {
    this.remoteBusy = false;
    this.lastActivityAt = this.timer.now();
  }

  onLocalCommit(): void {
    this.lastActivityAt = this.timer.now();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watchdog.dispose();
    this.timer.clearInterval(this.walWriteTicker);
  }

  private onSuspect(lane: WatchdogLane): void {
    if (this.rebuilding || this.disposed) return;
    if ((lane === "push" || lane === "pull" || lane === "remote-start") && this.transportSilent()) {
      const retries = (this.silentRetries.get(lane) ?? 0) + 1;
      this.silentRetries.set(lane, retries);
      if (retries === 1) {
        this.host.emitRemoteError("embedded remote replication offline; reconnecting");
        this.host.closeRemoteSocket?.();
        // Keep supervising the same promise. If closing the socket fails to settle it before the
        // next deadline, the second suspect is a terminal instance wedge.
        this.watchdog.retry(lane);
        return;
      }
    }
    this.rebuilding = true;
    this.host.emitDegraded(`embedded store instance wedged on ${lane} lane`);
    this.generation += 1;
    this.silentRetries.clear();
    this.host.deadInstance(new Error(`embedded store instance wedged on ${lane} lane`));
    this.dispose();
  }

  private transportSilent(): boolean {
    return this.timer.now() - this.lastTransportActivityAt >= this.idleMs;
  }

  private async walWrite(): Promise<void> {
    if (this.rebuilding || this.disposed) return;
    if (
      !walWriteDue({
        idleMs: this.walWriteIdleMs,
        lastActivityAt: this.lastActivityAt,
        lastWalWriteAt: this.lastWalWriteAt,
        now: this.timer.now(),
        remoteBusy: this.remoteBusy,
      })
    ) {
      return;
    }
    this.lastWalWriteAt = this.timer.now();
    const disarm = this.watchdog.arm("wal-write");
    try {
      await this.host.walWrite();
    } catch {
      // Best-effort like the boot WAL write; a hang is covered by the armed watchdog.
    } finally {
      disarm();
    }
  }
}
