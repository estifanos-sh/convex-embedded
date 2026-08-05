import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONVEX_EMBEDDED_NATIVE = new URL(
  `../../dist/native/${nativeTarget()}/convex-embedded.node`,
  import.meta.url,
).pathname;
const [{ StoreAdapter }, { openCandidate }] = await Promise.all([
  import(new URL("../../dist/internal/storage.mjs", import.meta.url).href),
  import(new URL("../../dist/internal/candidate.mjs", import.meta.url).href),
]);
const native = createRequire(import.meta.url)(process.env.CONVEX_EMBEDDED_NATIVE);
const temporary = mkdtempSync(join(tmpdir(), "embedded-candidate-stress-"));
const reports: unknown[] = [];
try {
  for (const rows of [1_000, 10_000]) reports.push(await measure(rows));
  const [small, large] = reports as Array<{
    coldMs: number;
    fileBytes: number;
    fileBudgetBytes: number;
    warmMs: number;
    rows: number;
  }>;
  if (
    large.coldMs / large.rows > (small.coldMs / small.rows) * 3 ||
    large.warmMs > small.warmMs * 15 + 5 ||
    reports.some(
      (report) =>
        (report as { fileBytes: number; fileBudgetBytes: number }).fileBytes >
        (report as { fileBytes: number; fileBudgetBytes: number }).fileBudgetBytes,
    )
  ) {
    throw new Error(`candidate scaling regression: ${JSON.stringify({ large, small })}`);
  }
  console.log(JSON.stringify(reports));
} finally {
  rmSync(temporary, { force: true, recursive: true });
}

async function measure(rows: number): Promise<unknown> {
  const path = join(temporary, `stress-${rows}.sqlite3`);
  const source = schema(false);
  const seeded = await raw(path);
  try {
    await seeded.setup(source);
    const first = Math.floor(rows / 3);
    const second = Math.floor((rows * 2) / 3);
    for (const [identity, from, to] of [
      ["unauthenticated", 0, first],
      ["stress:a", first, second],
      ["stress:b", second, rows],
    ] as const) {
      await seeded.identity.write(identity);
      for (let start = from; start < to; start += 1_000) {
        const end = Math.min(to, start + 1_000);
        await seeded.commit(
          {
            deletes: [],
            docWrites: Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              return {
                cols: [],
                creationTime: index + 1,
                data: { value: index },
                id: `documents|${index.toString(16).padStart(32, "0")}`,
                table: "documents",
              };
            }),
          },
          { changes: "omit", source: "device" },
        );
      }
    }
    await seeded.wal.write();
  } finally {
    await seeded.close();
  }
  const seedBytes = statSync(path).size;

  const target = schema(true);
  const coldStore = await raw(path);
  const coldStarted = performance.now();
  const cold = await candidate(coldStore, target);
  const coldMs = performance.now() - coldStarted;
  const count = await partitionRows(coldStore, rows);
  await coldStore.wal.write();
  await coldStore.close();
  if (count !== rows || !cold.required || cold.resumed) {
    throw new Error(`invalid cold candidate result: ${JSON.stringify({ cold, count, rows })}`);
  }

  for (const cycleTarget of [schema(false), target]) {
    const cycleStore = await raw(path);
    const cycle = await candidate(cycleStore, cycleTarget);
    const cycleRows = await partitionRows(cycleStore, rows);
    await cycleStore.wal.write();
    await cycleStore.close();
    if (!cycle.required || cycleRows !== rows) {
      throw new Error(
        `repeated generation lost partitioned rows: ${JSON.stringify({ cycle, cycleRows, rows })}`,
      );
    }
  }
  const fileBytes = statSync(path).size;
  const fileBudgetBytes = Math.max(seedBytes * 4, seedBytes + 32 * 1024 * 1024);

  const warmStore = await raw(path);
  const warmStarted = performance.now();
  const warm = await candidate(warmStore, target);
  const warmMs = performance.now() - warmStarted;
  const warmCount = await partitionRows(warmStore, rows);
  await warmStore.wal.write();
  await warmStore.close();
  if (warmCount !== rows || warm.required || warm.resumed) {
    throw new Error(`invalid warm candidate result: ${JSON.stringify({ rows, warm, warmCount })}`);
  }
  const coldBudgetMs = rows === 1_000 ? 5_000 : 30_000;
  if (coldMs >= coldBudgetMs || warmMs >= 2_000) {
    throw new Error(
      `candidate performance budget exceeded: ${JSON.stringify({ coldBudgetMs, coldMs, rows, warmBudgetMs: 2_000, warmMs })}`,
    );
  }
  return {
    coldMs,
    fileBudgetBytes,
    fileBytes,
    rows,
    rowsPerSecond: Math.round(rows / (coldMs / 1_000)),
    warmMs,
  };
}

async function partitionRows(store: any, rows: number): Promise<number> {
  const first = Math.floor(rows / 3);
  const second = Math.floor((rows * 2) / 3);
  let total = 0;
  for (const [identity, expected] of [
    ["unauthenticated", first],
    ["stress:a", second - first],
    ["stress:b", rows - second],
  ] as const) {
    await store.identity.write(identity);
    const count = await store.doc.count.read({ table: "documents" });
    if (count !== expected) {
      throw new Error(`${identity} retained ${String(count)}/${expected} rows`);
    }
    total += count;
  }
  return total;
}

async function raw(path: string): Promise<any> {
  return new StoreAdapter(await native.Store.open(path, path, "unauthenticated"));
}

async function candidate(store: any, targetSchema: ReturnType<typeof schema>): Promise<any> {
  const opened = await openCandidate(store, {
    createRunner: () => ({}),
    localReady: async () => undefined,
    remote: false,
    runnerSchema: targetSchema,
    targetSchema,
  });
  return opened.report;
}

function schema(target: boolean) {
  return {
    hash: (target ? "b" : "a").repeat(64),
    setupHash: "",
    tables: [
      {
        name: "documents",
        placement: "device" as const,
        columns: target ? [{ name: "value" }] : [],
        crdtFields: [],
        localFields: [],
        indexes: [],
      },
    ],
  };
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
