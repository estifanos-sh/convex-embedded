import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { EMBEDDED_PROTOCOL_VERSION } from "../protocol";
import type { EmbeddedBundleResult, EmbeddedCompatibleRuntimeIdentity } from "./index";

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

  return `import { embeddedSchema } from ${JSON.stringify(toVirtualSourceId(bundle.generatedPath))};

export { embeddedSchema };
export const embeddedManifest = ${JSON.stringify(bundle.manifest)};
export const modules = {
${moduleEntries}
};
`;
}

export async function renderEmbeddedIdentity(
  bundle: EmbeddedBundleResult,
  compatiblePriorRuntimes: readonly EmbeddedCompatibleRuntimeIdentity[] = [],
): Promise<string> {
  const schemaHash = bundle.runtimeSchemaHash;
  if (schemaHash === undefined) {
    throw new Error("Embedded identity requires a generated runtime storage schema hash");
  }
  const moduleGraphHash = await hashJson({
    manifest: bundle.manifest,
    sources: await Promise.all(bundle.sourceFiles.map(fileHash)),
  });
  const compatible = validateCompatiblePriorRuntimes(
    compatiblePriorRuntimes,
    moduleGraphHash,
    schemaHash,
  );

  return `export const embeddedIdentity = ${JSON.stringify({
    compatiblePriorRuntimes: compatible,
    moduleGraphHash,
    schemaHash,
  })};
`;
}

function validateCompatiblePriorRuntimes(
  values: readonly EmbeddedCompatibleRuntimeIdentity[],
  moduleGraphHash: string,
  schemaHash: string,
): Array<Omit<EmbeddedCompatibleRuntimeIdentity, "targetModuleGraphHash">> {
  const seen = new Set<string>();
  return values.map((value) => {
    if (!Number.isInteger(value.protocolVersion) || value.protocolVersion < 1) {
      throw new Error("compatiblePriorRuntimes protocolVersion must be a positive integer");
    }
    if (value.protocolVersion > EMBEDDED_PROTOCOL_VERSION) {
      throw new Error(
        `compatiblePriorRuntimes protocolVersion cannot be newer than ${EMBEDDED_PROTOCOL_VERSION}`,
      );
    }
    if (value.schemaHash.length === 0) {
      throw new Error("compatiblePriorRuntimes schemaHash must be non-empty");
    }
    if (value.schemaHash !== schemaHash) {
      throw new Error(
        `compatiblePriorRuntimes schemaHash ${JSON.stringify(value.schemaHash)} does not match the current runtime schemaHash ${JSON.stringify(schemaHash)}`,
      );
    }
    if (value.moduleGraphHash.length === 0 || value.moduleGraphHash === moduleGraphHash) {
      throw new Error("compatiblePriorRuntimes must name a non-current moduleGraphHash");
    }
    if (value.targetModuleGraphHash !== moduleGraphHash) {
      throw new Error(
        `compatiblePriorRuntimes targetModuleGraphHash ${JSON.stringify(value.targetModuleGraphHash)} does not match the current moduleGraphHash ${JSON.stringify(moduleGraphHash)}`,
      );
    }
    const key = `${value.protocolVersion}\u0000${value.schemaHash}\u0000${value.moduleGraphHash}`;
    if (seen.has(key)) throw new Error("compatiblePriorRuntimes contains a duplicate identity");
    seen.add(key);
    return {
      moduleGraphHash: value.moduleGraphHash,
      protocolVersion: value.protocolVersion,
      schemaHash: value.schemaHash,
    };
  });
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
