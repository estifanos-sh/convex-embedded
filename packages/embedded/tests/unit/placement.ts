import { defineTable } from "convex/server";
import type { GenericId } from "convex/values";
import { v } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import {
  analyzeEmbeddedSchema,
  defineEmbeddedSchema,
  type DeviceModel,
  type DeviceDataModel,
  embeddedTable,
  localTable,
  type ReplicatedDataModel,
  type ServerDataModel,
  type ServerModel,
  type WireModel,
} from "../../src/schema";
import { e } from "../../src/values";

const schema = defineEmbeddedSchema({
  documents: embeddedTable({
    expanded: e.local(v.boolean()),
    secret: e.omit(v.string()),
    title: v.string(),
  })
    .index("by_title", ["title"])
    .index("by_secret", ["secret"]),
  preferences: localTable({ compact: v.boolean() }).index("by_compact", ["compact"]),
  receipts: defineTable({ token: v.string() }),
});

describe("embedded schema placement", () => {
  test("exports only server tables and fields to Convex", () => {
    const exported = JSON.parse((schema as unknown as { export(): string }).export()) as {
      tables: { tableName: string; documentType: { value: Record<string, unknown> } }[];
    };
    expect(exported.tables.map((table) => table.tableName)).toEqual(["documents", "receipts"]);
    expect(Object.keys(exported.tables[0]!.documentType.value)).toEqual(["secret", "title"]);
  });

  test("projects the local store and preserves placement validators", () => {
    const analysis = analyzeEmbeddedSchema(schema);
    expect(analysis.placements).toMatchObject({
      localTables: ["preferences"],
      remoteTables: ["receipts"],
      replicatedTables: ["documents"],
      fields: {
        documents: {
          local: ["expanded"],
          remote: ["secret"],
          replicated: ["title"],
        },
      },
    });
    expect(analysis.placements.validators.documents?.expanded).toEqual({ type: "boolean" });
    expect(analysis.storeSchema.tables.map((table) => table.name)).toEqual([
      "documents",
      "preferences",
    ]);
    expect(analysis.storeSchema.tables[0]).toMatchObject({
      document: { type: "object", value: { title: { fieldType: { type: "string" } } } },
      indexes: [{ name: "by_title" }, { name: "by_id" }, { name: "by_creation_time" }],
      localFields: [{ field: "expanded", validator: { type: "boolean" } }],
      placement: "replicated",
    });
    expect(analysis.storeSchema.tables[1]).toMatchObject({ placement: "device" });
  });

  test("rejects local-field indexes and nested annotations", () => {
    expect(() =>
      defineEmbeddedSchema({
        docs: embeddedTable({ expanded: e.local(v.boolean()) }).index("by_expanded", ["expanded"]),
      }),
    ).toThrow("cannot contain local field");
    expect(() => embeddedTable({ nested: v.object({ secret: e.omit(v.string()) }) })).toThrow(
      "must be top-level",
    );
  });

  test("derives distinct server, wire, and device document types", () => {
    type ServerDocument = ServerModel<typeof schema>["documents"];
    type WireDocument = WireModel<typeof schema>["documents"];
    type DeviceDocument = DeviceModel<typeof schema>["documents"];
    type ServerDataDocument = ServerDataModel<typeof schema>["documents"]["document"];
    type ReplicatedDataDocument = ReplicatedDataModel<typeof schema>["documents"]["document"];
    type DeviceDataDocument = DeviceDataModel<typeof schema>["documents"]["document"];
    type ReplicatedIndexes = ReplicatedDataModel<typeof schema>["documents"]["indexes"];
    type DeviceIndexes = DeviceDataModel<typeof schema>["documents"]["indexes"];

    expectTypeOf<ServerDocument["secret"]>().toEqualTypeOf<string>();
    expectTypeOf<keyof ServerDocument>().not.toEqualTypeOf<"expanded">();
    expectTypeOf<keyof WireDocument>().not.toEqualTypeOf<"secret">();
    expectTypeOf<DeviceDocument["expanded"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ServerDataDocument["secret"]>().toEqualTypeOf<string>();
    expectTypeOf<keyof ReplicatedDataDocument>().not.toEqualTypeOf<"secret">();
    expectTypeOf<DeviceDataDocument["expanded"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<keyof ReplicatedIndexes>().toEqualTypeOf<
      "by_creation_time" | "by_id" | "by_title"
    >();
    expectTypeOf<keyof DeviceIndexes>().toEqualTypeOf<"by_creation_time" | "by_id" | "by_title">();

    const deviceWithoutOverlay: DeviceDocument = {
      _creationTime: 1,
      _id: "documents:1" as GenericId<"documents">,
      title: "hello",
    };
    expect(deviceWithoutOverlay.expanded).toBeUndefined();
  });

  test("preserves placement metadata through asOptional at type and runtime", () => {
    const optionalSchema = defineEmbeddedSchema({
      docs: embeddedTable({
        secret: e.omit(v.string()).asOptional(),
        title: e.text().asOptional(),
      }),
    });
    type ServerDocument = ServerModel<typeof optionalSchema>["docs"];
    type WireDocument = WireModel<typeof optionalSchema>["docs"];

    expectTypeOf<ServerDocument["secret"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<WireDocument["title"]>().toEqualTypeOf<string | undefined>();
    expect(analyzeEmbeddedSchema(optionalSchema).placements.fields.docs).toEqual({
      local: [],
      remote: ["secret"],
      replicated: ["title"],
    });
  });

  test("includes placement metadata in the local schema identity", () => {
    const replicated = defineEmbeddedSchema({ docs: embeddedTable({ value: v.string() }) });
    const remote = defineEmbeddedSchema({
      docs: embeddedTable({ value: e.omit(v.string()) }),
    });
    const local = defineEmbeddedSchema({
      docs: embeddedTable({ value: e.local(v.string()) }),
    });

    const hashes = [replicated, remote, local].map(
      (value) => analyzeEmbeddedSchema(value).storeSchema.hash,
    );
    expect(new Set(hashes)).toHaveLength(3);
  });

  test("keeps hosted-only search and vector indexes out of the local contract", () => {
    const hostedIndexes = defineEmbeddedSchema({
      docs: embeddedTable({
        embedding: e.omit(v.array(v.float64())),
        text: e.omit(v.string()),
        title: v.string(),
      })
        .searchIndex("search_text", { searchField: "text" })
        .vectorIndex("vector_embedding", { vectorField: "embedding", dimensions: 3 }),
    });

    const analysis = analyzeEmbeddedSchema(hostedIndexes);
    type ReplicatedSearchIndexes = ReplicatedDataModel<
      typeof hostedIndexes
    >["docs"]["searchIndexes"];
    type ReplicatedVectorIndexes = ReplicatedDataModel<
      typeof hostedIndexes
    >["docs"]["vectorIndexes"];
    type ServerSearchIndexes = ServerDataModel<typeof hostedIndexes>["docs"]["searchIndexes"];
    type ServerVectorIndexes = ServerDataModel<typeof hostedIndexes>["docs"]["vectorIndexes"];
    expectTypeOf<keyof ReplicatedSearchIndexes>().toEqualTypeOf<never>();
    expectTypeOf<keyof ReplicatedVectorIndexes>().toEqualTypeOf<never>();
    expectTypeOf<keyof ServerSearchIndexes>().toEqualTypeOf<"search_text">();
    expectTypeOf<keyof ServerVectorIndexes>().toEqualTypeOf<"vector_embedding">();
    expect(analysis.placements.indexes.docs?.remote).toEqual(["search_text", "vector_embedding"]);
    expect(analysis.storeSchema.tables[0]?.indexes.map((index) => index.name)).toEqual([
      "by_id",
      "by_creation_time",
    ]);
  });
});
