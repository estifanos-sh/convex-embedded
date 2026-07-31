import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { v, type GenericValidator, type ValidatorJSON } from "convex/values";
import { expect, test } from "vite-plus/test";

import {
  carry,
  defineDeviceMigrations,
  deviceMigration,
  withDeviceMigrations,
} from "../../src/migrations";
import { NativeStore } from "../../src/node/native";
import type { StoreSchema } from "../../src/storage/types";
import { nativeModule } from "../testkit/native";

function validatorJson(validator: GenericValidator): ValidatorJSON {
  return (validator as GenericValidator & { json: ValidatorJSON }).json;
}

function path(name: string): string {
  const value = join(tmpdir(), name);
  for (const suffix of ["", "-wal", "-shm", ".owner"]) {
    rmSync(`${value}${suffix}`, { force: true });
  }
  return value;
}

const oldValue = v.object({ theme: v.string() });
const newValue = v.object({ appearance: v.string() });
const finalValue = v.object({ appearance: v.string(), contrast: v.number() });

function schema(hash: string, document: GenericValidator): StoreSchema {
  return {
    hash: hash.repeat(64),
    tables: [
      {
        name: "preferences",
        placement: "device",
        columns: [],
        document: validatorJson(document),
        indexes: [],
      },
    ],
  };
}

function localFieldSchema(hash: string, validator: GenericValidator): StoreSchema {
  return {
    hash: hash.repeat(64),
    tables: [
      {
        name: "issues",
        placement: "replicated",
        columns: [],
        document: validatorJson(v.object({ title: v.string() })),
        localFields: [{ field: "draft", validator: validatorJson(validator) }],
        indexes: [],
      },
    ],
  };
}

test("device migrations transform originated documents before cutover", async () => {
  const storePath = path("embedded-device-migration.db");
  const source = await NativeStore.openWith(nativeModule().Store, storePath);
  await source.setup(schema("0", oldValue));
  await source.commit(
    {
      deletes: [],
      docWrites: [
        {
          table: "preferences",
          id: "preference-1",
          data: { theme: "dark" },
          cols: {},
          creationTime: 1,
        },
      ],
    },
    { source: "device", changes: "include" },
  );
  await source.close();

  const manifest = defineDeviceMigrations([
    deviceMigration({
      id: "001-appearance",
      source: carry.document({ table: "preferences", value: oldValue }),
      target: carry.document({ table: "preferences", value: newValue }),
      async handler(ctx, records) {
        for (const record of records) {
          await ctx.migration.write(record.key, {
            table: "preferences",
            id: record.id!,
            value: { appearance: record.value.theme },
          });
        }
      },
    }),
  ]);
  const target = withDeviceMigrations(schema("1", newValue), manifest);
  const migrated = await NativeStore.openWith(nativeModule().Store, storePath);
  await migrated.setup(target);

  expect(migrated.migrationReport).toMatchObject({
    created: true,
    discarded: 0,
    migrated: 1,
    quarantined: 0,
    required: true,
    resumed: false,
  });
  expect(await migrated.doc.read("preferences", "preference-1")).toEqual({
    _creationTime: 1,
    _id: "preference-1",
    appearance: "dark",
  });
  await migrated.close();
});

test("a later migration can recover an automatically quarantined document", async () => {
  const storePath = path("embedded-device-migration-quarantine.db");
  const source = await NativeStore.openWith(nativeModule().Store, storePath);
  await source.setup(schema("0", oldValue));
  await source.commit(
    {
      deletes: [],
      docWrites: [
        {
          table: "preferences",
          id: "preference-1",
          data: { theme: "dark" },
          cols: {},
          creationTime: 1,
        },
      ],
    },
    { source: "device", changes: "include" },
  );
  await source.close();

  const quarantined = await NativeStore.openWith(nativeModule().Store, storePath);
  await quarantined.setup(schema("1", newValue));
  expect(quarantined.migrationReport).toMatchObject({
    quarantined: 1,
    reasons: { unclaimed: 1 },
    required: true,
  });
  const quarantinePage = await quarantined.ledger.quarantine!.read();
  expect(quarantinePage.records).toHaveLength(1);
  expect(quarantinePage.records[0]).toMatchObject({
    codec: 1,
    kind: 2,
    migrationId: "__finalize__",
    reason: "unclaimed",
  });
  expect(JSON.parse(new TextDecoder().decode(quarantinePage.records[0]!.payload))).toMatchObject({
    id: "preference-1",
    table: "preferences",
  });
  expect(await quarantined.doc.read("preferences", "preference-1")).toBeUndefined();
  await quarantined.close();

  const manifest = defineDeviceMigrations([
    deviceMigration({
      id: "001-recover-appearance",
      source: carry.document({
        table: "preferences",
        value: oldValue,
        quarantined: true,
      }),
      target: carry.document({ table: "preferences", value: newValue }),
      async handler(ctx, records) {
        for (const record of records) {
          expect(record.quarantine).toEqual({
            migrationId: "__finalize__",
            reason: "unclaimed",
          });
          await ctx.migration.write(record.key, {
            table: "preferences",
            id: record.id!,
            value: { appearance: record.value.theme },
          });
        }
      },
    }),
  ]);
  const recovered = await NativeStore.openWith(nativeModule().Store, storePath);
  await recovered.setup(withDeviceMigrations(schema("1", newValue), manifest));
  expect(await recovered.doc.read("preferences", "preference-1")).toEqual({
    _creationTime: 1,
    _id: "preference-1",
    appearance: "dark",
  });
  await recovered.close();
});

test("finalization quarantines a local field rejected by its target validator", async () => {
  const storePath = path("embedded-device-migration-local-field.db");
  const source = await NativeStore.openWith(nativeModule().Store, storePath);
  await source.setup(localFieldSchema("0", v.string()));
  await source.commit(
    {
      deletes: [],
      docWrites: [],
      localFieldWrites: [
        {
          table: "issues",
          id: "issue-1",
          field: "draft",
          value: "offline text",
        },
      ],
    },
    { source: "device", changes: "include" },
  );
  expect(await source.doc.device!.read("issues", "issue-1")).toEqual({
    draft: "offline text",
  });
  await source.close();

  const migrated = await NativeStore.openWith(nativeModule().Store, storePath);
  await migrated.setup(localFieldSchema("1", v.number()));
  expect(await migrated.doc.device!.read("issues", "issue-1")).toEqual({});
  await migrated.close();

  const localFieldRecord = v.object({
    table: v.string(),
    id: v.string(),
    field: v.string(),
    value: v.any(),
  });
  let recoveredRecords = 0;
  const manifest = defineDeviceMigrations([
    deviceMigration({
      id: "001-recover-local-field",
      source: carry.record({ kind: 3, value: localFieldRecord, quarantined: true }),
      target: carry.record({ kind: 3, value: localFieldRecord }),
      async handler(ctx, records) {
        recoveredRecords += records.length;
        for (const record of records) {
          await ctx.migration.write(record.key, {
            key: record.recordKey,
            value: { ...record.value, value: 42 },
          });
        }
      },
    }),
  ]);
  const recovered = await NativeStore.openWith(nativeModule().Store, storePath);
  await recovered.setup(withDeviceMigrations(localFieldSchema("1", v.number()), manifest));
  expect(recoveredRecords).toBe(1);
  expect(await recovered.doc.device!.read("issues", "issue-1")).toEqual({ draft: 42 });
  await recovered.close();
});

test("a skipped release runs the complete retained migration suffix", async () => {
  const storePath = path("embedded-device-migration-skipped-release.db");
  const source = await NativeStore.openWith(nativeModule().Store, storePath);
  await source.setup(schema("0", oldValue));
  await source.commit(
    {
      deletes: [],
      docWrites: [
        {
          table: "preferences",
          id: "preference-1",
          data: { theme: "dark" },
          cols: {},
          creationTime: 1,
        },
      ],
    },
    { source: "device", changes: "include" },
  );
  await source.close();

  const manifest = defineDeviceMigrations([
    deviceMigration({
      id: "001-appearance",
      source: carry.document({ table: "preferences", value: oldValue }),
      target: carry.document({ table: "preferences", value: newValue }),
      async handler(ctx, records) {
        for (const record of records) {
          await ctx.migration.write(record.key, {
            table: "preferences",
            id: record.id!,
            value: { appearance: record.value.theme },
          });
        }
      },
    }),
    deviceMigration({
      id: "002-contrast",
      source: carry.document({ table: "preferences", value: newValue }),
      target: carry.document({ table: "preferences", value: finalValue }),
      async handler(ctx, records) {
        for (const record of records) {
          await ctx.migration.write(record.key, {
            table: "preferences",
            id: record.id!,
            value: { ...record.value, contrast: 1 },
          });
        }
      },
    }),
  ]);
  const migrated = await NativeStore.openWith(nativeModule().Store, storePath);
  await migrated.setup(withDeviceMigrations(schema("2", finalValue), manifest));
  expect(await migrated.doc.read("preferences", "preference-1")).toEqual({
    _creationTime: 1,
    _id: "preference-1",
    appearance: "dark",
    contrast: 1,
  });
  await migrated.close();
});
