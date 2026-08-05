import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  messages: defineTable({
    body: v.string(),
  }),
});

const { ConvexEmbeddedClient } = (await import(
  new URL("../../dist/node.mjs", import.meta.url).href
)) as {
  ConvexEmbeddedClient: new (options: {
    modules: Record<string, unknown>;
    path: string;
    schema: typeof schema;
  }) => { close(): Promise<void>; open(): Promise<void> };
};

process.env.CONVEX_EMBEDDED_NATIVE = new URL(
  `../../dist/native/${nativeTarget()}/convex-embedded.node`,
  import.meta.url,
).pathname;

const path = join(tmpdir(), `embedded_node_entrypoint_smoke_${process.pid}.db`);
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });

const client = new ConvexEmbeddedClient({ schema, modules: {}, path });
await client.open();
await client.close();

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
