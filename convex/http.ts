import { httpRouter } from "convex/server";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";

const http = httpRouter();

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const serveStaticFile = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === "" || path === "/") {
    path = "/index.html";
  }

  let resolvedPath = path;
  let asset = await readAsset(ctx, path);
  if (!asset && !hasFileExtension(path)) {
    resolvedPath = "/index.html";
    asset = await readAsset(ctx, resolvedPath);
  }

  if (!asset) {
    return response("Not Found", 404, {
      "Content-Type": "text/plain",
    });
  }

  if (!asset.storageId) {
    return response("Asset not available", 500, {
      "Content-Type": "text/plain",
    });
  }

  const cacheControl = isHashedAsset(resolvedPath)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";

  const compressible = isCompressiblePath(resolvedPath);
  let storageId = asset.storageId;
  let contentEncoding: string | undefined;
  if (compressible) {
    const encoding = negotiateEncoding(request.headers.get("Accept-Encoding"));
    if (encoding) {
      const variant = await readAsset(ctx, `${resolvedPath}.${ENCODING_EXTENSION[encoding]}`);
      if (variant?.storageId) {
        storageId = variant.storageId;
        contentEncoding = encoding;
      }
    }
  }

  const etag = `"${storageId}"`;

  if (request.headers.get("If-None-Match") === etag) {
    const notModified: Record<string, string> = {
      ETag: etag,
      "Cache-Control": cacheControl,
    };
    if (compressible) notModified.Vary = "Accept-Encoding";
    return response(null, 304, notModified);
  }

  const blob = await ctx.storage.get(storageId);
  if (!blob) {
    return response("Storage error", 500, {
      "Content-Type": "text/plain",
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": resolvedPath.endsWith(".wasm") ? "application/wasm" : asset.contentType,
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (contentEncoding) headers["Content-Encoding"] = contentEncoding;
  if (compressible) headers.Vary = "Accept-Encoding";
  return response(blob, 200, headers);
});

const serveAttachment = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return response("Attachment token is required", 400, {
      "Content-Type": "text/plain",
    });
  }

  const attachment = await ctx.runQuery(internal.files.serve, { token });
  if (!attachment) {
    return response("Attachment not found", 404, {
      "Content-Type": "text/plain",
    });
  }

  const blob = await ctx.storage.get(attachment.storageId);
  if (!blob) {
    return response("Attachment data not found", 404, {
      "Content-Type": "text/plain",
    });
  }

  return response(blob, 200, {
    "Cache-Control": "private, max-age=2592000, immutable",
    "Content-Type": attachment.contentType,
    "X-Content-Type-Options": "nosniff",
  });
});

const ENCODING_EXTENSION: Record<string, string> = {
  br: "br",
  gzip: "gz",
};

function negotiateEncoding(acceptEncoding: string | null): "br" | "gzip" | undefined {
  if (!acceptEncoding) return undefined;
  const accepted = acceptEncoding.toLowerCase();
  if (/(^|,)\s*br\b/.test(accepted)) return "br";
  if (/(^|,)\s*gzip\b/.test(accepted)) return "gzip";
  return undefined;
}

function isCompressiblePath(path: string): boolean {
  return /\.(?:js|mjs|css|html|json|wasm|svg|txt|map|xml|webmanifest)$/i.test(path);
}

http.route({
  path: "/attachment",
  method: "GET",
  handler: serveAttachment,
});

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: serveStaticFile,
});

export default http;

type StaticAsset = {
  _creationTime: number;
  _id: string;
  blobId?: string;
  contentType: string;
  deploymentId: string;
  path: string;
  storageId?: Id<"_storage">;
} | null;

async function readAsset(ctx: ActionCtx, path: string): Promise<StaticAsset> {
  return (await ctx.runQuery(components.staticHosting.lib.getByPath, { path })) as StaticAsset;
}

function response(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      ...isolationHeaders,
    },
  });
}

function hasFileExtension(path: string): boolean {
  return /\/[^/]+\.[^/]+$/.test(path);
}

function isHashedAsset(path: string): boolean {
  return /-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(path);
}
