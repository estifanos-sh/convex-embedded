import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vite-plus/test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
  name: string;
};
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

type EntrypointClass =
  | "stable app API"
  | "version-coupled tooling"
  | "experimental devtools"
  | "generated-only";

interface EntrypointContract {
  class: EntrypointClass;
  exports?: readonly string[];
  signatures?: readonly string[];
}

/** Every package export is deliberate: app APIs, build tooling, devtools, or generated code only. */
const ENTRYPOINTS = {
  bundler: {
    class: "version-coupled tooling",
    exports: [
      "AppArtifactModule",
      "AppArtifactV1",
      "EMBEDDED_GENERATED_FORMAT_VERSION",
      "EmbeddedBundleInput",
      "EmbeddedBundleResult",
      "EmbeddedFunctionKind",
      "EmbeddedFunctionManifest",
      "EmbeddedFunctionManifestEntry",
      "EmbeddedFunctionVisibility",
      "EmbeddedGeneratedIdentity",
      "EmbeddedGeneratedSchema",
      "FunctionPlacement",
      "GenerateEmbeddedResult",
      "LocalExportDescriptor",
      "LocalSetupDescriptor",
      "createEmbeddedBundle",
      "generateEmbedded",
      "readLocalExportNames",
      "renderEmbeddedGenerated",
      "toModuleId",
    ],
    signatures: [
      "declare const EMBEDDED_GENERATED_FORMAT_VERSION = 4;",
      "declare function generateEmbedded(input: EmbeddedBundleInput): Promise<GenerateEmbeddedResult>;",
      "declare function renderEmbeddedGenerated(bundle: EmbeddedBundleResult): string;",
    ],
  },
  browser: {
    class: "stable app API",
    exports: [
      "AuthTokenFetcher",
      "ConvexEmbeddedClient",
      "ConvexEmbeddedClientOptions",
      "ConvexEmbeddedSchema",
      "ConvexEmbeddedUploadFetch",
      "ConvexEmbeddedUploadFetchOptions",
      "EMBEDDED_ERROR_CODES",
      "EMBEDDED_SETTLEMENT_CODES",
      "EMBEDDED_UPLOAD_PATH",
      "EmbeddedConnectionError",
      "EmbeddedConnectionErrorCode",
      "EmbeddedConnectionState",
      "EmbeddedError",
      "EmbeddedErrorCode",
      "EmbeddedLocalConnectionState",
      "EmbeddedMutationSettlement",
      "EmbeddedReplicationConnectionState",
      "EmbeddedRetainedRevision",
      "EmbeddedSettlementCode",
      "Watch",
      "createConvexEmbeddedUploadFetch",
      "isEmbeddedError",
    ],
    signatures: [
      "declare class ConvexEmbeddedClient extends EmbeddedClient {",
      "declare function createConvexEmbeddedUploadFetch(client: EmbeddedClient, options?: ConvexEmbeddedUploadFetchOptions): ConvexEmbeddedUploadFetch;",
    ],
  },
  devtools: {
    class: "experimental devtools",
    exports: [
      "EmbeddedDevtoolsSource",
      "MountEmbeddedDevtoolsOptions",
      "MountedEmbeddedDevtools",
      "createEmbeddedDevtoolsSource",
      "mountEmbeddedDevtools",
    ],
    signatures: [
      "declare function mountEmbeddedDevtools(client: EmbeddedClient, options?: MountEmbeddedDevtoolsOptions): MountedEmbeddedDevtools;",
    ],
  },
  "devtools/vite": {
    class: "experimental devtools",
    exports: ["EmbeddedDevtoolsVitePlugin", "EmbeddedDevtoolsVitePlugins", "embeddedDevtools"],
    signatures: [
      "declare function embeddedDevtools(config?: TanStackDevtoolsViteConfig): EmbeddedDevtoolsVitePlugins;",
    ],
  },
  node: {
    class: "stable app API",
    exports: [
      "AuthTokenFetcher",
      "ConvexEmbeddedClient",
      "ConvexEmbeddedClientOptions",
      "ConvexEmbeddedSchema",
      "ConvexEmbeddedUploadFetch",
      "ConvexEmbeddedUploadFetchOptions",
      "ConvexLocalModules",
      "ConvexModules",
      "EMBEDDED_ERROR_CODES",
      "EMBEDDED_SETTLEMENT_CODES",
      "EMBEDDED_UPLOAD_PATH",
      "EmbeddedConnectionError",
      "EmbeddedConnectionErrorCode",
      "EmbeddedConnectionState",
      "EmbeddedError",
      "EmbeddedErrorCode",
      "EmbeddedLocalConnectionState",
      "EmbeddedMutationSettlement",
      "EmbeddedReplicationConnectionState",
      "EmbeddedRetainedRevision",
      "EmbeddedSettlementCode",
      "Watch",
      "createConvexEmbeddedUploadFetch",
      "isEmbeddedError",
    ],
    signatures: ["declare class ConvexEmbeddedClient extends EmbeddedClient {"],
  },
  expo: {
    class: "stable app API",
    exports: [
      "AuthTokenFetcher",
      "ConvexEmbeddedClient",
      "ConvexEmbeddedClientOptions",
      "ConvexEmbeddedSchema",
      "EMBEDDED_ERROR_CODES",
      "EMBEDDED_SETTLEMENT_CODES",
      "EmbeddedConnectionError",
      "EmbeddedConnectionErrorCode",
      "EmbeddedConnectionState",
      "EmbeddedError",
      "EmbeddedErrorCode",
      "EmbeddedLocalConnectionState",
      "EmbeddedMutationSettlement",
      "EmbeddedReplicationConnectionState",
      "EmbeddedRetainedRevision",
      "EmbeddedSettlementCode",
      "Watch",
      "isEmbeddedError",
    ],
    signatures: ["declare class ConvexEmbeddedClient extends EmbeddedClient {"],
  },
  metro: {
    class: "version-coupled tooling",
    exports: ["ConvexEmbeddedMetroOptions", "withConvexEmbedded"],
    signatures: [
      "declare function withConvexEmbedded<Config extends object>(config: Config, options: ConvexEmbeddedMetroOptions): Promise<Config>;",
    ],
  },
  values: {
    class: "stable app API",
    exports: ["EmbeddedValue", "e"],
    signatures: ["declare const e: Readonly<{"],
  },
  schema: {
    class: "stable app API",
    exports: [
      "DeviceDataModel",
      "DeviceModel",
      "EmbeddedSchemaDefinition",
      "EmbeddedTableDefinition",
      "EmbeddedTableValidator",
      "LocalTableDefinition",
      "ReplicatedDataModel",
      "ServerDataModel",
      "ServerModel",
      "WireModel",
      "defineEmbeddedSchema",
      "localTable",
      "replicatedTable",
    ],
    signatures: [
      "declare function defineEmbeddedSchema<Tables extends GenericSchema>(tables: Tables, options?: DefineSchemaOptions<true>): EmbeddedSchemaDefinition<Tables>;",
      "declare function localTable<DocumentSchema extends EmbeddedFields>(documentSchema: DocumentSchema): LocalTableDefinition",
    ],
  },
  "convex.config": {
    class: "version-coupled tooling",
    exports: ["default"],
    signatures: ['declare const _default: import("convex/server").ComponentDefinition<any, {}>;'],
  },
  "convex.config.js": {
    class: "version-coupled tooling",
    exports: ["default"],
    signatures: ['declare const _default: import("convex/server").ComponentDefinition<any, {}>;'],
  },
  "_generated/component.js": {
    class: "generated-only",
    exports: ["ComponentApi"],
    signatures: ["type ComponentApi<Name extends string | undefined = string | undefined> = {"],
  },
  server: {
    class: "stable app API",
    exports: ["DefineEmbeddedOptions", "DefinedEmbedded", "defineEmbedded"],
    signatures: [
      "declare function defineEmbedded<Schema extends EmbeddedSchemaDefinition>(options: DefineEmbeddedOptions<Schema>): DefinedEmbedded<Schema>;",
    ],
  },
  local: {
    class: "stable app API",
    exports: [
      "LocalAction",
      "LocalActionBuilder",
      "LocalActionCtx",
      "LocalBuilders",
      "LocalCompatibilityBuilders",
      "LocalFunction",
      "LocalFunctionArgs",
      "LocalFunctionReturns",
      "LocalMutation",
      "LocalMutationBuilder",
      "LocalMutationCtx",
      "LocalQuery",
      "LocalQueryBuilder",
      "LocalQueryCtx",
    ],
    signatures: [
      'readonly placement: "local";',
      "type LocalBuilders<DataModel extends GenericDataModel> = {",
      "compatibility<Schema extends EmbeddedSchemaDefinition>(schema: Schema): LocalCompatibilityBuilders<DeviceDataModel<Schema>>;",
      'internalAction: LocalActionBuilder<DataModel, "internal">;',
    ],
  },
  "internal/local": {
    class: "generated-only",
    exports: ["createLocalFacade", "defineLocal", "stampLocal"],
    signatures: [
      "declare function defineLocal<Schema extends EmbeddedSchemaDefinition>(schema: Schema): LocalBuilders<DeviceDataModel<Schema>>;",
      "declare function stampLocal(moduleId: string, exports: Record<string, unknown>): void;",
      "declare function stampLocal(moduleId: string, graphHash: string, exports: Record<string, unknown>): void;",
    ],
  },
  "internal/text": {
    class: "stable app API",
    exports: ["TextFieldOptions", "TextFieldWriter", "createTextField"],
    signatures: [
      "declare function createTextField<R>(options: TextFieldOptions<R>): TextFieldWriter;",
    ],
  },
  unplugin: {
    class: "version-coupled tooling",
    exports: [
      "ConvexEmbeddedPluginOptions",
      "ConvexEmbeddedUnplugin",
      "convexEmbedded",
      "convexEmbeddedUnplugin",
      "default",
    ],
    signatures: ["declare const convexEmbeddedUnplugin: ConvexEmbeddedUnplugin;"],
  },
  vite: {
    class: "version-coupled tooling",
    exports: ["ConvexEmbeddedPluginOptions", "convexEmbedded", "default"],
    signatures: [
      "declare function convexEmbedded(options: ConvexEmbeddedPluginOptions): VitePlugin[];",
    ],
  },
  "package.json": { class: "version-coupled tooling" },
} as const satisfies Record<string, EntrypointContract>;

interface ExportEntry {
  dts: string;
  name: string;
  specifier: string;
}

function typedExportEntries(): ExportEntry[] {
  return Object.entries(packageJson.exports).flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const types = declarationPath(record);
    if (types === undefined) return [];
    const name = key === "." ? "." : key.replace(/^\.\//, "");
    const specifier = key === "." ? packageJson.name : `${packageJson.name}${key.slice(1)}`;
    return [{ dts: types.replace(/^\.\//, ""), name, specifier }];
  });
}

function declarationPath(record: Record<string, unknown>): string | undefined {
  if (typeof record.types === "string") return declarationFile(record.types);
  for (const condition of ["import", "require", "default"]) {
    const value = record[condition];
    if (typeof value !== "object" || value === null) continue;
    const types = (value as Record<string, unknown>).types;
    if (typeof types === "string") return declarationFile(types);
  }
  return undefined;
}

function declarationFile(value: string): string | undefined {
  return value.startsWith("./dist/") && /\.d\.[cm]ts$/.test(value) ? value : undefined;
}

function exportedNames(dts: string): string[] {
  const names = new Set<string>();

  for (const block of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of block[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliased = part.match(/\sas\s+(\w+)$/);
      names.add(aliased ? aliased[1] : part.split(/\s+/)[0]);
    }
  }
  const declaration =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|enum|namespace|interface|type)\s+(\w+)/g;
  for (const match of dts.matchAll(declaration)) names.add(match[1]);

  return [...names].sort();
}

function declarationClosure(entry: ExportEntry): string {
  const pending = [join(packageRoot, entry.dts)];
  const visited = new Set<string>();
  const sources: string[] = [];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (!visited.add(file)) continue;
    const source = readFileSync(file, "utf8");
    sources.push(source);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const declaration = resolve(dirname(file), specifier)
        .replace(/\.mjs$/, ".d.mts")
        .replace(/\.cjs$/, ".d.cts")
        .replace(/\.js$/, ".d.mts");
      if (existsSync(declaration)) pending.push(declaration);
    }
  }
  return sources.join("\n");
}

function normalize(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

const ENTRIES = typedExportEntries();
const require = createRequire(import.meta.url);

describe("package entrypoint contract", () => {
  test("classifies every exported package path", () => {
    const actual = Object.keys(packageJson.exports)
      .map((key) => (key === "." ? "." : key.replace(/^\.\//, "")))
      .sort();
    expect(Object.keys(ENTRYPOINTS).sort()).toEqual(actual);
    expect(Object.values(ENTRYPOINTS).map((entry) => entry.class)).toEqual(
      expect.arrayContaining([
        "stable app API",
        "version-coupled tooling",
        "experimental devtools",
        "generated-only",
      ]),
    );
  });

  for (const entry of ENTRIES) {
    const contract: EntrypointContract = ENTRYPOINTS[entry.name as keyof typeof ENTRYPOINTS];
    if (contract.exports === undefined) continue;

    test(`${contract.class}: ${entry.name} exports its exact declaration surface`, () => {
      const declaration = readFileSync(join(packageRoot, entry.dts), "utf8");
      expect(exportedNames(declaration)).toEqual(contract.exports);
      const closure = normalize(declarationClosure(entry));
      for (const signature of contract.signatures ?? []) {
        expect(closure).toContain(normalize(signature));
      }
    });
  }

  test("the public local entry is types-only", async () => {
    const local = await import("@estifanos-sh/convex-embedded/local");
    expect(Object.keys(local)).toEqual([]);
    for (const name of [
      "EMBEDDED_LOCAL_REFERENCE",
      "Register",
      "defineLocal",
      "isLocalFunction",
      "local",
      "localReferenceName",
      "stampLocal",
    ]) {
      expect(local).not.toHaveProperty(name);
    }
  });

  test("the generated-only local entry exposes only generated runtime helpers", async () => {
    const internal = await import("@estifanos-sh/convex-embedded/internal/local");
    expect(Object.keys(internal).sort()).toEqual([
      "createLocalFacade",
      "defineLocal",
      "stampLocal",
    ]);
  });

  test("Node-safe tooling entries are safe to import", async () => {
    for (const entry of ENTRIES) {
      if (
        !["bundler", "devtools", "devtools/vite", "local", "metro", "unplugin", "vite"].includes(
          entry.name,
        )
      ) {
        continue;
      }
      await import(entry.specifier);
    }
  });

  test("the Metro package entry is safe to require from CommonJS", () => {
    const metro = require("@estifanos-sh/convex-embedded/metro") as Record<string, unknown>;
    expect(typeof metro.withConvexEmbedded).toBe("function");
  });

  test("schema-definition package entries are safe to require from CommonJS", () => {
    const schema = require("@estifanos-sh/convex-embedded/schema") as Record<string, unknown>;
    const values = require("@estifanos-sh/convex-embedded/values") as Record<string, unknown>;

    expect(typeof schema.defineEmbeddedSchema).toBe("function");
    expect(typeof schema.replicatedTable).toBe("function");
    expect(typeof schema.localTable).toBe("function");
    expect(values.e).toEqual(
      expect.objectContaining({
        count: expect.any(Function),
        local: expect.any(Function),
        remote: expect.any(Function),
        set: expect.any(Function),
        text: expect.any(Function),
      }),
    );
  });

  test("CommonJS schema artifacts and their shared chunks are published", () => {
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "dist/*-*.cjs",
        "dist/*-*.d.cts",
        "dist/schema.cjs",
        "dist/schema.d.cts",
        "dist/values.cjs",
        "dist/values.d.cts",
      ]),
    );
  });

  test("a packed consumer can use local types but cannot import ambient local APIs", () => {
    const destination = mkdtempSync(join(tmpdir(), "convex-embedded-entrypoint-tarball-"));
    const consumer = mkdtempSync(join(tmpdir(), "convex-embedded-entrypoint-consumer-"));
    temporary.push(destination, consumer);
    execFileSync(
      "pnpm",
      ["--config.ignore-scripts=true", "pack", "--pack-destination", destination],
      {
        cwd: packageRoot,
        stdio: "pipe",
      },
    );
    const tarball = readdirSync(destination).find((file) => file.endsWith(".tgz"));
    if (tarball === undefined) throw new Error("pnpm pack did not create a package tarball");

    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "embedded-entrypoint-consumer", private: true, type: "module" }),
    );
    const installed = join(consumer, "node_modules", "@estifanos-sh", "convex-embedded");
    mkdirSync(dirname(installed), { recursive: true });
    execFileSync("tar", ["-xzf", join(destination, tarball), "-C", consumer], { stdio: "pipe" });
    renameSync(join(consumer, "package"), installed);
    symlinkSync(
      resolve(dirname(require.resolve("convex")), "../.."),
      join(consumer, "node_modules", "convex"),
      "dir",
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
        },
      }),
    );
    writeFileSync(
      join(consumer, "index.ts"),
      `import type { LocalBuilders } from "@estifanos-sh/convex-embedded/local";

export type LocalContract = LocalBuilders<any>;

// @ts-expect-error Generated modules, not app code, own the builder factory.
import { defineLocal } from "@estifanos-sh/convex-embedded/local";
// @ts-expect-error Generated modules export the schema-bound local value.
import { local } from "@estifanos-sh/convex-embedded/local";
// @ts-expect-error Local stamping stays package-private.
import { stampLocal } from "@estifanos-sh/convex-embedded/local";
// @ts-expect-error Local references stay package-private.
import { localReferenceName } from "@estifanos-sh/convex-embedded/local";
// @ts-expect-error The marker is package-private.
import { EMBEDDED_LOCAL_REFERENCE } from "@estifanos-sh/convex-embedded/local";
// @ts-expect-error Ambient registration was removed.
import type { Register } from "@estifanos-sh/convex-embedded/local";

void [defineLocal, local, stampLocal, localReferenceName, EMBEDDED_LOCAL_REFERENCE];
`,
    );
    writeFileSync(
      join(consumer, "runtime.mjs"),
      `import * as local from "@estifanos-sh/convex-embedded/local";
if (Object.keys(local).length !== 0) throw new Error("public local runtime exports must be empty");
`,
    );

    execFileSync(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "--project", "tsconfig.json"],
      {
        cwd: consumer,
        stdio: "pipe",
      },
    );
    execFileSync(process.execPath, ["runtime.mjs"], { cwd: consumer, stdio: "pipe" });
  }, 30_000);
});
