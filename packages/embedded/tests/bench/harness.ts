import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareValues, v } from "convex/values";
import type { Value } from "convex/values";
import { type DataModelFromSchemaDefinition, defineSchema, defineTable } from "convex/server";

import type {
  BindingColValue,
  BindingTaggedValue,
  BindingWriteBatch,
  StoreBinding,
  ReadCacheStats,
} from "../../src/storage/binding";
import type {
  CommitOptions,
  CommitResult,
  CountSpec,
  DocPage,
  IdMapping,
  KeyPage,
  MutationCall,
  MutationRecord,
  RuntimeStorage,
  ReadSpec,
  StoreSchema,
  StoredDoc,
  UpsertIn,
  WriteBatch,
} from "../../src/storage/types";
import { loadNativeModule, type NativeModule } from "../../src/node/artifact";
import { NativeStore } from "../../src/node/native";
import { encode } from "../../src/runtime/codec";
import { defineFunctions } from "../../src/runtime/functions";
import { getTimerTime } from "../../src/time";
import { createRunner, type Runner } from "../../src/runtime/runner";
import { toRuntimeStoreSchema, toStoreSchema } from "../../src/schema";

export const benchSchema = defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
    sequence: v.number(),
    updated: v.optional(v.number()),
  })
    .index("by_channel", ["channel"])
    .index("by_channel_and_sequence", ["channel", "sequence"]),
});

type BenchDataModel = DataModelFromSchemaDefinition<typeof benchSchema>;

const { mutation, query } = defineFunctions<BenchDataModel>();

export const benchModules = {
  seed: mutation({
    args: { channel: v.string(), rows: v.number() },
    handler: async (ctx, args) => {
      const ids: string[] = [];
      for (let index = 0; index < args.rows; index += 1) {
        ids.push(
          await ctx.db.insert("messages", {
            body: `seed-${index}`,
            channel: args.channel,
            sequence: index,
          }),
        );
      }
      return ids;
    },
  }),
  get: query({
    args: { id: v.id("messages") },
    handler: (ctx, args) => ctx.db.get(args.id),
  }),
  listByChannel: query({
    args: { channel: v.string(), limit: v.number() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (index) => index.eq("channel", args.channel))
        .take(args.limit),
  }),
  countByChannel: query({
    args: { channel: v.string() },
    handler: (ctx, args) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel", (index) => index.eq("channel", args.channel))
        .count(),
  }),
  insert: mutation({
    args: { body: v.string(), channel: v.string(), sequence: v.number() },
    handler: (ctx, args) =>
      ctx.db.insert("messages", {
        body: args.body,
        channel: args.channel,
        sequence: args.sequence,
      }),
  }),
  patch: mutation({
    args: { body: v.string(), id: v.id("messages"), updated: v.number() },
    handler: (ctx, args) =>
      ctx.db.patch("messages", args.id, {
        body: args.body,
        updated: args.updated,
      }),
  }),
  readYourWrites: mutation({
    args: { body: v.string(), channel: v.string(), sequence: v.number() },
    handler: async (ctx, args) => {
      const id = await ctx.db.insert("messages", {
        body: args.body,
        channel: args.channel,
        sequence: args.sequence,
      });
      const doc = await ctx.db.get(id);
      return doc?._id === id;
    },
  }),
};

export const runtimeBenchRevs = {
  countByChannel: "messages:countByChannel",
  get: "messages:get",
  insert: "messages:insert",
  listByChannel: "messages:listByChannel",
  patch: "messages:patch",
  readYourWrites: "messages:readYourWrites",
  seed: "messages:seed",
} as const;

export interface RuntimeBenchHarness {
  channel: string;
  clearReadCache?: () => void;
  close(): Promise<void>;
  ids: string[];
  readCacheStats?: () => ReadCacheStats;
  runner: Runner;
  store: RuntimeStorage;
}

export interface RuntimeBenchHarnessOptions {
  channel?: string;
  seedRows?: number;
}

export interface NativeVolumeSeed {
  batchSize?: number;
  channel: string;
  deadlineMs: number;
  path: string;
  rows: number;
}

export const runtimeBenchStoreSchema = toStoreSchema(benchSchema);
const runtimeBenchClientStoreSchema = toRuntimeStoreSchema(benchSchema);
let native: NativeModule | undefined;
let nativePathCounter = 0;

export async function createRuntimeBenchHarness(
  options: RuntimeBenchHarnessOptions = {},
): Promise<RuntimeBenchHarness> {
  const store = new BenchStorage(runtimeBenchStoreSchema);
  return seedHarness(store, options);
}

export async function createNativeRuntimeBenchHarness(
  options: RuntimeBenchHarnessOptions = {},
): Promise<RuntimeBenchHarness> {
  const path = temporaryStorePath();
  const store = await NativeStore.openWith(nativeModule().Store, path);
  await store.setup(runtimeBenchStoreSchema);
  const harness = await seedHarness(store, options);
  return {
    ...harness,
    close: async () => {
      try {
        await harness.close();
      } finally {
        removeTemporaryStore(path);
      }
    },
  };
}

export async function seedNativeVolume(options: NativeVolumeSeed): Promise<void> {
  const store = await NativeStore.openWith(nativeModule().Store, options.path);
  try {
    await store.setup(runtimeBenchClientStoreSchema);
    const batchSize = options.batchSize ?? 10_000;
    for (let start = 0; start < options.rows; start += batchSize) {
      if (getTimerTime() >= options.deadlineMs) {
        throw new Error(
          `volume seed exceeded its budget after ${start.toLocaleString()} of ${options.rows.toLocaleString()} rows`,
        );
      }
      const end = Math.min(options.rows, start + batchSize);
      await store.commit(
        {
          deletes: [],
          upserts: Array.from({ length: end - start }, (_, offset) =>
            adapterUpsert(benchId(start + offset), options.channel, start + offset),
          ),
        },
        { changes: "include", source: "remote" },
      );
    }
  } finally {
    await store.close();
  }
}

export interface AdapterBenchHarness {
  channel: string;
  close(): Promise<void>;
  ids: string[];
  readCacheStats?: () => ReadCacheStats;
  store: NativeStore;
}

export interface BindingBenchHarness {
  binding: StoreBinding;
  channel: string;
  close(): Promise<void>;
  ids: string[];
}

export async function createAdapterBenchHarness(
  options: RuntimeBenchHarnessOptions = {},
): Promise<AdapterBenchHarness> {
  const path = temporaryStorePath();
  const store = await NativeStore.openWith(nativeModule().Store, path);
  await store.setup(runtimeBenchStoreSchema);
  const channel = options.channel ?? "general";
  const ids = await seedAdapter(store, channel, options.seedRows ?? 1_000);
  return {
    channel,
    close: async () => {
      try {
        await store.close();
      } finally {
        removeTemporaryStore(path);
      }
    },
    ids,
    readCacheStats: () => store.readCacheStats(),
    store,
  };
}

export async function createBindingBenchHarness(
  options: RuntimeBenchHarnessOptions = {},
): Promise<BindingBenchHarness> {
  const path = temporaryStorePath();
  const binding = (await nativeModule().Store.open(path)) as StoreBinding;
  await binding.setup(runtimeBenchStoreSchema);
  const channel = options.channel ?? "general";
  const ids = await seedBinding(binding, channel, options.seedRows ?? 1_000);
  return {
    binding,
    channel,
    close: async () => {
      try {
        await Promise.resolve(binding.close());
      } finally {
        removeTemporaryStore(path);
      }
    },
    ids,
  };
}

async function seedHarness(
  store: RuntimeStorage & { close?: () => Promise<void> | void },
  options: RuntimeBenchHarnessOptions,
): Promise<RuntimeBenchHarness> {
  const channel = options.channel ?? "general";
  const seedRows = options.seedRows ?? 1_000;
  const runner = createRunner({ messages: benchModules }, store, runtimeBenchStoreSchema);
  const ids = await seedRuntimeStore(store, channel, seedRows);
  const cacheStore = store as RuntimeStorage & {
    clearReadCacheForBench?: () => void;
    readCacheStats?: () => ReadCacheStats;
  };
  return {
    channel,
    clearReadCache: cacheStore.clearReadCacheForBench
      ? () => cacheStore.clearReadCacheForBench!()
      : undefined,
    close: async () => {
      await store.close?.();
    },
    ids,
    readCacheStats: cacheStore.readCacheStats ? () => cacheStore.readCacheStats!() : undefined,
    runner,
    store,
  };
}

async function seedRuntimeStore(
  store: RuntimeStorage,
  channel: string,
  rows: number,
): Promise<string[]> {
  const ids = Array.from({ length: rows }, (_, index) => benchId(index));
  for (let start = 0; start < ids.length; start += 500) {
    const slice = ids.slice(start, start + 500);
    await store.commit(
      {
        upserts: slice.map((id, offset) => adapterUpsert(id, channel, start + offset)),
        deletes: [],
      },
      { changes: "include", source: "remote" },
    );
  }
  return ids;
}

export class BenchStorage implements RuntimeStorage {
  private now = 1;
  private seq = 0;
  private readonly ids = new Map<string, IdMapping>();
  private readonly tables = new Map<string, Map<string, StoredDoc>>();
  private readonly mutations = new Map<string, MutationRecord & { args: string; name: string }>();

  readonly capabilities = { exactScanBounds: true };

  readonly clock = {
    read: (): number => this.now++,
  };

  readonly doc = {
    read: (table: string, id: string): Promise<StoredDoc | undefined> =>
      Promise.resolve(this.tables.get(table)?.get(id)),
    version: {
      read: (_table: string, _id: string): Promise<number | undefined> =>
        Promise.resolve(undefined),
    },
    crdt: {
      read: (_table: string, _id: string, _field: string): Promise<number | undefined> =>
        Promise.resolve(undefined),
      snapshot: { read: (_table: string, _id: string) => Promise.resolve([]) },
    },
    page: {
      read: (spec: ReadSpec): Promise<DocPage> => {
        const page = this.page(spec);
        return Promise.resolve({ cursor: page.cursor, docs: page.rows });
      },
    },
    count: {
      read: (spec: CountSpec): Promise<number | null> =>
        Promise.resolve(this.matchingRows({ ...spec, order: "asc" }).length),
    },
  };

  readonly key = {
    page: {
      read: (spec: ReadSpec): Promise<KeyPage> => {
        const page = this.page(spec);
        return Promise.resolve({
          creationTimes: page.rows.map((doc) => doc._creationTime),
          cursor: page.cursor,
          ids: page.rows.map((doc) => doc._id),
        });
      },
    },
  };

  readonly mutation = {
    begin: (call: MutationCall): Promise<MutationRecord> => {
      const existing = this.mutations.get(call.mutationId);
      if (existing) {
        if (existing.args !== call.args || existing.name !== call.name) {
          throw new Error(`mutation id reused with different call: ${call.mutationId}`);
        }
        return Promise.resolve(existing);
      }
      const record: MutationRecord & { args: string; name: string } = {
        args: call.args,
        mutationId: call.mutationId,
        name: call.name,
        status: "accepted",
      };
      this.mutations.set(call.mutationId, record);
      return Promise.resolve(record);
    },
    fail: (mutationId: string, error: string): Promise<void> => {
      const record = this.mutations.get(mutationId);
      if (record) {
        record.error = error;
        record.status = "failed";
      }
      return Promise.resolve();
    },
  };

  readonly id = {
    write: (mapping: IdMapping): Promise<void> => {
      this.ids.set(`${mapping.table}\0${mapping.localId}`, { ...mapping });
      return Promise.resolve();
    },
    read: (table: string, localId: string): Promise<IdMapping | undefined> => {
      const mapping = this.ids.get(`${table}\0${localId}`);
      return Promise.resolve(mapping ? { ...mapping } : undefined);
    },
    page: {
      read: (table: string): Promise<IdMapping[]> =>
        Promise.resolve(
          [...this.ids.values()]
            .filter((mapping) => mapping.table === table)
            .map((mapping) => ({
              ...mapping,
            })),
        ),
    },
    delete: (table: string, localId: string): Promise<void> => {
      this.ids.delete(`${table}\0${localId}`);
      return Promise.resolve();
    },
  };

  constructor(private readonly schema: StoreSchema) {
    for (const table of schema.tables) this.tables.set(table.name, new Map());
  }

  commit(batch: WriteBatch, options?: CommitOptions): Promise<CommitResult> {
    if (
      options?.source === "local" &&
      (options.mutation === "existing" || options.mutation === "terminal")
    ) {
      let record = this.mutations.get(options.mutationId);
      if (!record && options.mutation === "terminal" && options.mutationFresh) {
        record = {
          args: options.mutationArgs ?? "",
          mutationId: options.mutationId,
          name: options.mutationName ?? "",
          status: "accepted",
        };
        this.mutations.set(options.mutationId, record);
      }
      if (!record || record.status !== "accepted") {
        return Promise.reject(new Error(`mutation is not accepted: ${options.mutationId}`));
      }
    }

    const changes = [
      ...batch.upserts.map((upsert) => ({
        id: upsert.id,
        op: "upsert" as const,
        row: {
          ...upsert.data,
          _creationTime: upsert.creationTime,
          _id: upsert.id,
        },
        table: upsert.table,
      })),
      ...batch.deletes.map((deleted) => ({
        id: deleted.id,
        op: "delete" as const,
        table: deleted.table,
      })),
    ];

    for (const upsert of batch.upserts) {
      this.table(upsert.table).set(upsert.id, {
        ...upsert.data,
        _creationTime: upsert.creationTime,
        _id: upsert.id,
      });
    }
    for (const deleted of batch.deletes) {
      this.tables.get(deleted.table)?.delete(deleted.id);
    }
    for (const mapping of batch.idMappings ?? []) {
      this.ids.set(`${mapping.table}\0${mapping.localId}`, { ...mapping });
    }

    this.seq += 1;
    if (options?.source === "local" && options.mutation !== "none") {
      const record = this.mutations.get(options.mutationId);
      if (!record) throw new Error(`mutation disappeared during commit: ${options.mutationId}`);
      record.commitSeq = this.seq;
      record.result = "mutationResult" in options ? options.mutationResult : undefined;
      record.status = "committed";
    }

    return Promise.resolve({
      changedTables: [...new Set([...batch.upserts, ...batch.deletes].map((write) => write.table))],
      changes,
      commitSeq: this.seq,
    });
  }

  private table(name: string): Map<string, StoredDoc> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  private page(spec: ReadSpec): { cursor: string | null; rows: StoredDoc[] } {
    const rows = this.matchingRows(spec);
    const offset = spec.cursor ? Number(spec.cursor) : 0;
    const pageSize = spec.pageSize ?? rows.length;
    const page = rows.slice(offset, offset + pageSize);
    const cursor = offset + page.length < rows.length ? String(offset + page.length) : null;
    return { cursor, rows: page };
  }

  private matchingRows(spec: CountSpec & { order: "asc" | "desc" }): StoredDoc[] {
    const table = this.schema.tables.find((entry) => entry.name === spec.table);
    const index = spec.index
      ? table?.indexes.find((candidate) => candidate.name === spec.index)
      : undefined;
    const fields = [...(index?.fields ?? [])];
    for (const field of ["_creationTime", "_id"]) {
      if (!fields.includes(field)) fields.push(field);
    }
    const direction = spec.order === "desc" ? -1 : 1;
    return [...(this.tables.get(spec.table)?.values() ?? [])]
      .filter((doc) => matchesBounds(doc, index?.fields ?? [], spec.bounds ?? []))
      .sort((left, right) => {
        for (const field of fields) {
          const compared = compareValues(
            readField(left, field) as Value,
            readField(right, field) as Value,
          );
          if (compared !== 0) return direction * compared;
        }
        return 0;
      });
  }
}

export function benchId(index: number): string {
  return `messages|${index.toString(16).padStart(32, "0")}`;
}

export function adapterUpsert(
  id: string,
  channel: string,
  sequence: number,
  body = `seed-${sequence}`,
): UpsertIn {
  return {
    table: "messages",
    id,
    data: { body, channel, sequence },
    cols: { idx_channel: channel, idx_sequence: sequence },
    creationTime: sequence + 1,
  };
}

export function bindingUpsert(
  id: string,
  channel: string,
  sequence: number,
  body = `seed-${sequence}`,
): BindingWriteBatch["upserts"][number] {
  return {
    table: "messages",
    id,
    data: encode({ body, channel, sequence }),
    cols: [bindingCol("idx_channel", channel), bindingCol("idx_sequence", sequence)],
    creationTime: sequence + 1,
  };
}

export function bindingEq(value: string | number): { kind: "eq"; value: BindingTaggedValue } {
  return { kind: "eq", value: bindingValue(value) };
}

async function seedAdapter(store: NativeStore, channel: string, rows: number): Promise<string[]> {
  const ids = Array.from({ length: rows }, (_, index) => benchId(index));
  for (let start = 0; start < ids.length; start += 500) {
    const slice = ids.slice(start, start + 500);
    await store.commit(
      {
        upserts: slice.map((id, offset) => adapterUpsert(id, channel, start + offset)),
        deletes: [],
      },
      { changes: "include", source: "remote" },
    );
  }
  return ids;
}

async function seedBinding(
  binding: StoreBinding,
  channel: string,
  rows: number,
): Promise<string[]> {
  const ids = Array.from({ length: rows }, (_, index) => benchId(index));
  for (let start = 0; start < ids.length; start += 500) {
    const slice = ids.slice(start, start + 500);
    const batch = {
      upserts: slice.map((id, offset) => bindingUpsert(id, channel, start + offset)),
      deletes: [],
      freshIds: [],
      idMappings: [],
    };
    const options = { source: "remote" as const };
    await binding.commit(batch, options);
  }
  return ids;
}

function bindingCol(name: string, value: string | number): BindingColValue {
  return { ...bindingValue(value), name };
}

function bindingValue(value: string | number): BindingTaggedValue {
  return typeof value === "string" ? { text: value } : { real: value };
}

function readField(doc: StoredDoc, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>((current, segment) => (current as Record<string, unknown>)?.[segment], doc);
}

function matchesBounds(
  doc: StoredDoc,
  fields: string[],
  bounds: NonNullable<ReadSpec["bounds"]>,
): boolean {
  for (let index = 0; index < bounds.length; index += 1) {
    const field = fields[index];
    const bound = bounds[index];
    if (!field || !bound) continue;
    const value = readField(doc, field) as Value;
    if (bound.kind === "eq") {
      if (compareValues(value, bound.value as Value) !== 0) return false;
    } else {
      if (
        bound.lower !== undefined &&
        compareValues(value, bound.lower as Value) < (bound.lowerInclusive ? 0 : 1)
      ) {
        return false;
      }
      if (
        bound.upper !== undefined &&
        compareValues(value, bound.upper as Value) > (bound.upperInclusive ? 0 : -1)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function nativeModule(): NativeModule {
  if (native) return native;
  native = loadNativeModule();
  return native;
}

export function temporaryStorePath(): string {
  nativePathCounter += 1;
  const path = join(
    tmpdir(),
    `embedded-bench-${process.pid}-${getTimerTime()}-${nativePathCounter}.db`,
  );
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  return path;
}

export function removeTemporaryStore(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}
