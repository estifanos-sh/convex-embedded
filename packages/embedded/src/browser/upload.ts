/// <reference lib="dom" />

/**
 * Browser upload helpers for local embedded storage.
 *
 * @packageDocumentation
 */
import { EmbeddedClient } from "../client";
import { EMBEDDED_UPLOAD_PATH } from "../upload";
import { errorMessage } from "../error";

export { EMBEDDED_UPLOAD_PATH };

/**
 * Fetch implementation used for explicit local embedded upload flows.
 *
 * @public
 */
export type ConvexEmbeddedUploadFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Options for {@link createConvexEmbeddedUploadFetch}.
 *
 * @public
 */
export interface ConvexEmbeddedUploadFetchOptions {
  /** Native fetch implementation used for every non-embedded upload request. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Creates a fetch-compatible function that intercepts embedded local upload URLs.
 *
 * @remarks
 * This helper intentionally does not monkey-patch `globalThis.fetch`. Applications pass the
 * returned fetch function to code that uploads files to URLs returned by
 * `ctx.storage.generateUploadUrl()`. All other URLs delegate to native fetch.
 *
 * @param client - Browser embedded client that owns the local runtime.
 * @param options - Optional native fetch override for tests.
 * @returns A fetch-compatible upload function.
 *
 * @example
 * ```ts
 * const uploadFetch = createConvexEmbeddedUploadFetch(client);
 * const response = await uploadFetch(uploadUrl, { method: "POST", body: file });
 * const { storageId } = await response.json();
 * ```
 *
 * @public
 */
export function createConvexEmbeddedUploadFetch(
  client: EmbeddedClient,
  options: ConvexEmbeddedUploadFetchOptions = {},
): ConvexEmbeddedUploadFetch {
  const nativeFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    if (!isEmbeddedUpload(input)) return nativeFetch(input, init);
    const request = new Request(input, init);
    if (!isEmbeddedUpload(request.url)) return nativeFetch(input, init);
    if (request.method.toUpperCase() !== "POST") {
      return json({ error: "Embedded upload URLs only accept POST." }, 405);
    }
    try {
      const contentType = request.headers.get("content-type") ?? "";
      const blob = new Blob([await request.arrayBuffer()], {
        type: contentType || undefined,
      });
      const result = await (
        client as unknown as {
          handleUploadUrl(url: string, blob: Blob): Promise<{ storageId: string }>;
        }
      ).handleUploadUrl(request.url, blob);
      return json(result, 200);
    } catch (error) {
      return json({ error: errorMessage(error) }, 404);
    }
  };
}

function isEmbeddedUpload(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  try {
    return new URL(url, globalThis.location?.origin).pathname.startsWith(EMBEDDED_UPLOAD_PATH);
  } catch {
    return false;
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
