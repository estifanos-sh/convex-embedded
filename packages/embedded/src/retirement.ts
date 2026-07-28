/**
 * Shared client-retirement detection and rotation-churn bounding for both the node client remote
 * loop and the browser worker runtime. One definition of the terminal-retirement signal and the
 * rotation breaker so the two remotes cannot drift.
 *
 * @internal
 */

/** Prefix of the native remote's terminal client-retirement error message (Rust `RemoteError::Retired`). */
export const REMOTE_CLIENT_RETIRED_PREFIX = "remote client retired:";

/**
 * Trips once more than three rotations are attempted inside a five-minute window, so a client the
 * server keeps retiring surfaces the terminal signal instead of rotating forever.
 */
export class RotationBreaker {
  private readonly events: number[] = [];
  private readonly max = 3;
  private readonly windowMs = 300_000;

  record(now: number): boolean {
    this.expiredDelete(now);
    this.events.push(now);
    return this.events.length > this.max;
  }

  private expiredDelete(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]! <= cutoff) this.events.shift();
  }
}
