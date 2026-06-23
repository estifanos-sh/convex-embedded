/** Function-scoped absolute time: storage HLC locally, platform time on Convex. */
export function read(): number {
  return Date.now();
}
