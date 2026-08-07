import path from "node:path";

import type { EmbeddedBundleResult } from "./index";

export const VIRTUAL_MODULE_ID = "virtual:convex-embedded";
export const VIRTUAL_IDENTITY_MODULE_ID = "virtual:convex-embedded/identity";
export const VIRTUAL_SOURCE_MODULE_PREFIX = `${VIRTUAL_MODULE_ID}/source/`;
export const VIRTUAL_FACADE_MODULE_PREFIX = `${VIRTUAL_MODULE_ID}/facade/`;

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

/** A generated immutable facade for an application import of a local module. */
export function toVirtualFacadeId(filePath: string): string {
  return `${VIRTUAL_FACADE_MODULE_PREFIX}${Buffer.from(path.resolve(filePath), "utf8").toString(
    "base64url",
  )}`;
}

export function fromVirtualFacadeId(id: string): string | undefined {
  if (!id.startsWith(VIRTUAL_FACADE_MODULE_PREFIX)) return undefined;
  const encoded = id.slice(VIRTUAL_FACADE_MODULE_PREFIX.length);
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
  const localEntries = Object.entries(bundle.localModules)
    .map(
      ([moduleId, module]) =>
        `  ${objectKey(moduleId)}: () => import(${JSON.stringify(
          toVirtualSourceId(module.file),
        )}),`,
    )
    .join("\n");

  return `const embeddedSchemaBase = ${JSON.stringify(bundle.embeddedSchema)};
export const embeddedSchema = embeddedSchemaBase;
export const embeddedManifest = ${JSON.stringify(bundle.manifest)};
export const embeddedArtifact = ${JSON.stringify(bundle.artifact)};
export const modules = {
${moduleEntries}
};
export const localModules = {
${localEntries}
};
`;
}

/**
 * Renders the Metro-facing module wrapper for one local entrypoint.
 *
 * The facade evaluates the original module but never changes one of its exports. Each local
 * function exported to application code gets a frozen clone that carries its stable logical
 * reference and execution hash. The virtual registry deliberately imports the source directly:
 * its runner maintains the legacy direct-runtime registration path without making an application
 * setup value depend on evaluation order.
 */
export function renderLocalShim(
  moduleId: string,
  graphHash: string,
  sourcePath: string,
  exports: readonly string[] = [],
): string {
  const source = JSON.stringify(toVirtualSourceId(sourcePath));
  const named = [...new Set(exports)]
    .sort()
    .map((name) => `export const ${name} = embeddedLocal[${JSON.stringify(name)}];`)
    .join("\n");
  return `import * as source from ${source};
import { createLocalFacade } from "@estifanos-sh/convex-embedded/internal/local";

const embeddedLocal = createLocalFacade(${JSON.stringify(moduleId)}, ${JSON.stringify(
    graphHash,
  )}, source);

export * from ${source};
${named}
`;
}

export function renderEmbeddedIdentity(bundle: EmbeddedBundleResult): string {
  const schemaHash = bundle.embeddedSchema.runtimeStoreSchema.hash;
  if (schemaHash === undefined) {
    throw new Error("Embedded identity requires a generated runtime storage schema hash");
  }
  return `export const embeddedIdentity = ${JSON.stringify({
    artifactHash: bundle.artifact.artifactHash,
    moduleGraphHash: bundle.moduleGraphHash,
    schemaHash,
  })};
`;
}

function objectKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}
