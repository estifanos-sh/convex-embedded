import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureTargetSchema,
  portableOracle,
  portableOracleJson,
} from "../../tests/fixture/oracle.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryDir = resolve(packageDir, "../..");
const fixture = resolve(repositoryDir, "crates/storage/tests/fixtures/baseline/store.sqlite3");
const manifest = JSON.parse(
  readFileSync(
    resolve(repositoryDir, "crates/storage/tests/fixtures/baseline/manifest.json"),
    "utf8",
  ),
) as { portableOracle: unknown };
const temporary = mkdtempSync(join(tmpdir(), "embedded-baseline-node-"));
const path = join(temporary, "store.sqlite3");
cpSync(fixture, path);

process.env.CONVEX_EMBEDDED_NATIVE = resolve(
  packageDir,
  `dist/native/${nativeTarget()}/convex-embedded.node`,
);

const [{ StoreAdapter }, { openCandidate }] = await Promise.all([
  import(new URL("../../dist/internal/storage.mjs", import.meta.url).href),
  import(new URL("../../dist/internal/candidate.mjs", import.meta.url).href),
]);
const native = createRequire(import.meta.url)(process.env.CONVEX_EMBEDDED_NATIVE);

try {
  const cold = await open(path);
  if (!cold.report.required || cold.report.resumed) {
    throw new Error(`cold fixture did not enter a fresh candidate: ${JSON.stringify(cold.report)}`);
  }
  assertOracle("cold", cold.oracle);

  const warm = await open(path);
  if (warm.report.required || warm.report.resumed) {
    throw new Error(
      `warm fixture unexpectedly entered a candidate: ${JSON.stringify(warm.report)}`,
    );
  }
  assertOracle("warm", warm.oracle);
  console.log(JSON.stringify({ cold: cold.report, oracle: warm.oracle, warm: warm.report }));
} finally {
  rmSync(temporary, { force: true, recursive: true });
}

async function open(
  path: string,
): Promise<{ oracle: unknown; report: { required: boolean; resumed: boolean } }> {
  const inner = await native.Store.open(path, path, "unauthenticated");
  const store = new StoreAdapter(inner);
  try {
    const opened = await openCandidate(store, {
      createRunner: () => ({}),
      localReady: async () => undefined,
      remote: false,
      runnerSchema: fixtureTargetSchema,
      targetSchema: fixtureTargetSchema,
    });
    return { oracle: await portableOracle(store), report: opened.report };
  } finally {
    await store.close();
  }
}

function assertOracle(phase: string, actual: unknown): void {
  if (portableOracleJson(actual) !== portableOracleJson(manifest.portableOracle)) {
    throw new Error(
      `${phase} packaged Node fixture oracle mismatch\nexpected=${JSON.stringify(manifest.portableOracle)}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

function nativeTarget(): string {
  const arch = process.arch;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "linux") return `linux-${arch}-${hasGlibc() ? "gnu" : "musl"}`;
  return `${process.platform}-${arch}`;
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return Boolean(report?.header?.glibcVersionRuntime);
}
