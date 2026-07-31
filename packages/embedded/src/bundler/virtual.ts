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
  const localEntries = Object.entries(bundle.localModules)
    .map(
      ([moduleId, module]) =>
        `  ${objectKey(moduleId)}: () => import(${JSON.stringify(
          toVirtualSourceId(module.file),
        )}),`,
    )
    .join("\n");

  const migrationImport =
    bundle.migrationsPath === undefined
      ? ""
      : `import deviceMigrations from ${JSON.stringify(toVirtualSourceId(bundle.migrationsPath))};
import { withDeviceMigrations } from "@convex-dev/embedded/migrations";
`;
  const runtimeSchema =
    bundle.migrationsPath === undefined
      ? "embeddedSchemaBase"
      : `{ ...embeddedSchemaBase, runtimeStoreSchema: withDeviceMigrations(embeddedSchemaBase.runtimeStoreSchema, deviceMigrations) }`;

  return `${migrationImport}const embeddedSchemaBase = ${JSON.stringify(bundle.embeddedSchema)};
export const embeddedSchema = ${runtimeSchema};
export const embeddedManifest = ${JSON.stringify(bundle.manifest)};
export const modules = {
${moduleEntries}
};
export const localModules = {
${localEntries}
};
`;
}

/**
 * Renders the append-only stamp that names a device module's registrations in every graph that
 * bundles its source. Returns an empty string when the module exports nothing to name.
 */
export function renderLocalStamp(
  moduleId: string,
  source: string,
  exports: Array<[string, string]>,
): string {
  if (exports.length === 0) return "";
  let stamp = "__embeddedStampLocal";
  while (source.includes(stamp)) stamp += "$";
  const named = exports
    .map(([exported, binding]) => (exported === binding ? exported : `${exported}: ${binding}`))
    .join(", ");
  return `
import { stampLocal as ${stamp} } from "@convex-dev/embedded/local";
${stamp}(${JSON.stringify(moduleId)}, { ${named} });
`;
}

export function renderEmbeddedIdentity(bundle: EmbeddedBundleResult): string {
  const schemaHash = bundle.embeddedSchema.runtimeStoreSchema.hash;
  if (schemaHash === undefined) {
    throw new Error("Embedded identity requires a generated runtime storage schema hash");
  }
  return `export const embeddedIdentity = ${JSON.stringify({
    moduleGraphHash: bundle.moduleGraphHash,
    schemaHash,
  })};
`;
}

function objectKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}
