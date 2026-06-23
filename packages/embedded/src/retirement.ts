/**
 * Shared client-retirement detection and rotation-churn bounding for both the node client remote
 * loop and the browser worker runtime. One definition of the terminal-retirement signal and the
 * rotation breaker so the two remotes cannot drift.
 *
 * @internal
 */

/** Prefix of the native remote's terminal client-retirement error message (Rust `RemoteError::Retired`). */
export const REMOTE_CLIENT_RETIRED_PREFIX = "remote client retired:";

/** Client rotations tolerated inside {@link ROTATION_WINDOW_MS} before rotation gives up. */
export const ROTATION_MAX = 3;

/** Sliding window over which {@link RotationBreaker} counts rotations. */
export const ROTATION_WINDOW_MS = 300_000;

/**
 * Trips once the rotations attempted inside {@link ROTATION_WINDOW_MS} exceed {@link ROTATION_MAX}, so
 * a client the server keeps retiring surfaces the terminal signal instead of rotating forever.
 */
export class RotationBreaker {
  private readonly events: number[] = [];

  constructor(
    private readonly max: number = ROTATION_MAX,
    private readonly windowMs: number = ROTATION_WINDOW_MS,
  ) {}

  record(now: number): boolean {
    this.prune(now);
    this.events.push(now);
    return this.events.length > this.max;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]! <= cutoff) this.events.shift();
  }
}
