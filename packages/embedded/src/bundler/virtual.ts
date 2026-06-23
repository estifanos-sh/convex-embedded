import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EmbeddedBundleResult } from "./index";

export const VIRTUAL_MODULE_ID = "virtual:convex-embedded";
export const VIRTUAL_IDENTITY_MODULE_ID = "virtual:convex-embedded/identity";
export const VIRTUAL_SOURCE_MODULE_PREFIX = `${VIRTUAL_MODULE_ID}/source/`;

export function toVirtualSourceId(filePath: string): string {
  return `${VIRTUAL_SOURCE_MODULE_PREFIX}${Buffer.from(path.resolve(filePath), "utf8").toString(
    "base64url",
  )}`;
}

export function fromVirtualSourceId(id: string): string | undefined {
  if (!id.startsWith(VIRTUAL_SOURCE_MODULE_PREFIX)) return undefined;
  const encoded = id.slice(VIRTUAL_SOURCE_MODULE_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return path.isAbsolute(decoded) ? path.normalize(decoded) : undefined;
  } catch {
    return undefined;
  }
}

export function renderEmbeddedBundle(bundle: EmbeddedBundleResult): string {
  const moduleEntries = Object.entries(bundle.modules)
    .map(
      ([moduleId, filePath]) =>
        `  ${objectKey(moduleId)}: () => import(${JSON.stringify(toVirtualSourceId(filePath))}),`,
    )
    .join("\n");

  return `import schema from ${JSON.stringify(toVirtualSourceId(bundle.schemaPath))};

export { schema };
export const modules = {
${moduleEntries}
};
`;
}

export async function renderEmbeddedIdentity(bundle: EmbeddedBundleResult): Promise<string> {
  const schemaHash = await fileHash(bundle.schemaPath);
  const moduleGraphHash = await hashJson(
    Object.fromEntries(
      await Promise.all(
        Object.entries(bundle.modules).map(async ([moduleId, filePath]) => [
          moduleId,
          await fileHash(filePath),
        ]),
      ),
    ),
  );

  return `export const embeddedIdentity = ${JSON.stringify({
    moduleGraphHash,
    schemaHash,
  })};
`;
}

function objectKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}

async function fileHash(file: string): Promise<string> {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function hashJson(value: unknown): Promise<string> {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
