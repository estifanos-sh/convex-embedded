import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fixtureTargetSchema,
  portableOracle,
  portableOracleJson,
} from "../../tests/fixture/oracle.ts";

process.env.CONVEX_EMBEDDED_NATIVE = new URL(
  `../../dist/native/${nativeTarget()}/convex-embedded.node`,
  import.meta.url,
).pathname;

if (process.argv[2] === "child") {
  const path = process.argv[3];
  if (!path) throw new Error("candidate kill child requires a store path");
  const { openCandidate, store } = await load(path);
  await openCandidate(store, {
    checkpoint: async (phase: string) => {
      if (phase === "finalizePrepare") process.kill(process.pid, "SIGKILL");
    },
    createRunner: () => ({}),
    localReady: async () => undefined,
    remote: false,
    runnerSchema: fixtureTargetSchema,
    targetSchema: fixtureTargetSchema,
  });
  throw new Error("candidate kill child survived SIGKILL");
}

const repositoryDir = new URL("../../../..", import.meta.url).pathname;
const fixture = join(repositoryDir, "crates/storage/tests/fixtures/baseline/store.sqlite3");
const manifest = JSON.parse(
  readFileSync(join(repositoryDir, "crates/storage/tests/fixtures/baseline/manifest.json"), "utf8"),
) as { portableOracle: unknown };
const temporary = mkdtempSync(join(tmpdir(), "embedded-candidate-kill-"));
const path = join(temporary, "store.sqlite3");
cpSync(fixture, path);
try {
  const child = spawnSync(process.execPath, [import.meta.filename, "child", path], {
    encoding: "utf8",
    env: process.env,
  });
  if (child.signal !== "SIGKILL") {
    throw new Error(
      `candidate child was not killed: ${JSON.stringify({ signal: child.signal, status: child.status, stderr: child.stderr })}`,
    );
  }

  const { openCandidate, store } = await load(path);
  try {
    const opened = await openCandidate(store, {
      createRunner: () => ({}),
      localReady: async () => undefined,
      remote: false,
      runnerSchema: fixtureTargetSchema,
      targetSchema: fixtureTargetSchema,
    });
    if (!opened.report.resumed || !opened.report.required) {
      throw new Error(`candidate did not resume after SIGKILL: ${JSON.stringify(opened.report)}`);
    }
    const actual = await portableOracle(store);
    if (portableOracleJson(actual) !== portableOracleJson(manifest.portableOracle)) {
      throw new Error("resumed SIGKILL candidate changed the portable oracle");
    }
    console.log(JSON.stringify({ signal: child.signal, report: opened.report }));
  } finally {
    await store.close();
  }
} finally {
  rmSync(temporary, { force: true, recursive: true });
}

async function load(path: string): Promise<any> {
  const [{ StoreAdapter }, { openCandidate }] = await Promise.all([
    import(new URL("../../dist/internal/storage.mjs", import.meta.url).href),
    import(new URL("../../dist/internal/candidate.mjs", import.meta.url).href),
  ]);
  const native = createRequire(import.meta.url)(process.env.CONVEX_EMBEDDED_NATIVE!);
  const store = new StoreAdapter(await native.Store.open(path, path, "unauthenticated"));
  return { openCandidate, store };
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
