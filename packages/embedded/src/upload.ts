/**
 * Shared local upload URL helpers.
 *
 * @packageDocumentation
 */

/** Local browser upload route prefix used by embedded upload fetch helpers. */
export const EMBEDDED_UPLOAD_PATH = "/__convex_embedded/upload/";

/**
 * Builds a local upload URL for an embedded upload token.
 *
 * @internal
 */
export function createUploadUrl(token: string): string {
  const origin =
    (globalThis as { location?: { origin?: string } }).location?.origin ??
    "http://convex-embedded.local";
  return `${origin}${EMBEDDED_UPLOAD_PATH}${encodeURIComponent(token)}`;
}

/**
 * Reads an embedded upload token from the public local route.
 *
 * @internal
 */
export function readUploadToken(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(
      url,
      (globalThis as { location?: { origin?: string } }).location?.origin ??
        "http://convex-embedded.local",
    );
  } catch {
    return undefined;
  }
  if (!parsed.pathname.startsWith(EMBEDDED_UPLOAD_PATH)) return undefined;
  return decodeURIComponent(parsed.pathname.slice(EMBEDDED_UPLOAD_PATH.length));
}
