import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { analyzeEmbeddedSchema, toRuntimeStoreSchema, toStoreSchema } from "../../src/schema";
import { count, set, text } from "../../src/values";

describe("Convex schema storage conversion", () => {
  test("preserves Convex index fields while aliasing storage columns", () => {
    const schema = defineSchema({
      users: defineTable({
        profile: v.object({ email: v.string() }),
        status: v.string(),
      })
        .index("by_email", ["profile.email"])
        .index("by_status", ["status"]),
    });

    expect(toStoreSchema(schema)).toEqual({
      hash: expect.any(String),
      tables: [
        {
          name: "users",
          columns: [
            { name: "idx_profile_email", field: "profile.email" },
            { name: "idx_status", field: "status" },
          ],
          document: expect.any(Object),
          indexes: [
            {
              name: "by_email",
              fields: ["profile.email", "_creationTime"],
              columns: ["idx_profile_email", "creation_time_ms"],
            },
            {
              name: "by_status",
              fields: ["status", "_creationTime"],
              columns: ["idx_status", "creation_time_ms"],
            },
            { name: "by_id", fields: ["_id"], columns: ["id"] },
            {
              name: "by_creation_time",
              fields: ["_creationTime"],
              columns: ["creation_time_ms"],
            },
          ],
        },
      ],
    });
  });

  test("rejects unsupported Convex index kinds explicitly", () => {
    const schema = defineSchema({
      articles: defineTable({
        body: v.string(),
        category: v.string(),
      }).searchIndex("by_body", { searchField: "body", filterFields: ["category"] }),
    });

    expect(() => toStoreSchema(schema)).toThrow(
      "embedded storage does not support search indexes on articles",
    );
  });

  test("rejects user indexes with reserved system names", () => {
    const schema = defineSchema({
      users: defineTable({ email: v.string() }).index("by_id", ["email"]),
    });

    expect(() => toStoreSchema(schema)).toThrow("index name users.by_id is reserved");
  });

  test("rejects indexes whose generated storage identifier is too long", () => {
    const schema = defineSchema({
      documents: defineTable({ value: v.string() }).index(
        "by_value_with_a_name_that_exceeds_the_physical_storage_limit",
        ["value"],
      ),
    });

    expect(() => toStoreSchema(schema)).toThrow(
      "embedded storage physical identifier must be valid and at most 64 bytes",
    );
  });

  test("keeps every package-owned physical identifier within the storage limit", () => {
    const schema = defineSchema({ documents: defineTable({ value: v.string() }) });

    expect(() => toRuntimeStoreSchema(schema)).not.toThrow();
  });

  test("aliases indexed user fields that collide with storage internals", () => {
    const schema = defineSchema({
      docs: defineTable({
        data: v.string(),
        id: v.string(),
        identity_key: v.string(),
        creation_time_ms: v.number(),
      })
        .index("by_data", ["data"])
        .index("by_id_field", ["id"])
        .index("by_identity_key", ["identity_key"])
        .index("by_creation_time_ms_field", ["creation_time_ms"]),
    });

    expect(toStoreSchema(schema).tables[0]!.columns).toEqual([
      { name: "idx_data", field: "data" },
      { name: "idx_id", field: "id" },
      { name: "idx_identity_key", field: "identity_key" },
      {
        name: "idx_creation_time_ms",
        field: "creation_time_ms",
      },
    ]);
  });

  test("supports indexed fields on compatible top-level object unions", () => {
    const schema = defineSchema({
      events: defineTable(
        v.union(
          v.object({ type: v.literal("email"), status: v.string() }),
          v.object({ type: v.literal("sms"), status: v.string() }),
        ),
      ).index("by_status", ["status"]),
    });

    expect(toStoreSchema(schema).tables[0]).toMatchObject({
      columns: [{ name: "idx_status", field: "status" }],
      indexes: [
        {
          columns: ["idx_status", "creation_time_ms"],
          fields: ["status", "_creationTime"],
          name: "by_status",
        },
        { columns: ["id"], fields: ["_id"], name: "by_id" },
        {
          columns: ["creation_time_ms"],
          fields: ["_creationTime"],
          name: "by_creation_time",
        },
      ],
      name: "events",
    });
  });

  test("supports mixed-type indexed unions (order keys carry no affinity)", () => {
    const schema = defineSchema({
      events: defineTable(
        v.union(v.object({ value: v.string() }), v.object({ value: v.number() })),
      ).index("by_value", ["value"]),
    });

    expect(toStoreSchema(schema).tables[0]!.columns).toEqual([
      { name: "idx_value", field: "value" },
    ]);
  });

  test("extracts embedded CRDT field metadata without changing Convex validators", () => {
    const schema = defineSchema({
      docs: defineTable({
        title: v.string(),
        body: text(),
        stats: v.object({ votes: count() }),
        tags: set(v.string()),
      }),
    });

    expect(toStoreSchema(schema).tables[0]).toMatchObject({
      crdtFields: [
        { field: "body", kind: "text" },
        { field: "stats.votes", kind: "count" },
        { field: "tags", kind: "set", member: { type: "string" } },
      ],
      document: {
        type: "object",
        value: {
          body: { fieldType: { type: "string" }, optional: false },
          stats: {
            fieldType: {
              type: "object",
              value: { votes: { fieldType: { type: "number" }, optional: false } },
            },
            optional: false,
          },
          tags: { fieldType: { type: "array", value: { type: "string" } }, optional: false },
          title: { fieldType: { type: "string" }, optional: false },
        },
      },
    });
  });

  test("extracts hosted storage id paths from exported schema JSON", () => {
    const schema = defineSchema({
      docs: defineTable({
        attachment: v.optional(v.id("_storage")),
        cover: v.object({
          image: v.id("_storage"),
        }),
        gallery: v.array(v.object({ image: v.id("_storage") })),
        metadata: v.record(v.string(), v.id("_storage")),
        owner: v.id("users"),
        variant: v.union(
          v.object({ kind: v.literal("text"), body: v.string() }),
          v.object({ kind: v.literal("file"), value: v.id("_storage") }),
        ),
      }),
      users: defineTable({
        name: v.string(),
      }),
    });

    expect(analyzeEmbeddedSchema(schema).storageIdPaths).toEqual({
      docs: ["attachment", "cover.image", "gallery[].image", "metadata{}", "variant.value"],
    });
  });

  test("rejects ambiguous storage id paths in mixed string unions", () => {
    const schema = defineSchema({
      docs: defineTable({
        variant: v.union(
          v.object({ kind: v.literal("text"), value: v.string() }),
          v.object({ kind: v.literal("file"), value: v.id("_storage") }),
        ),
      }),
    });

    expect(() => analyzeEmbeddedSchema(schema)).toThrow(
      "storage id path variant.value is ambiguous",
    );
  });

  test("escapes literal storage id field path separators and collection markers", () => {
    const schema = defineSchema({
      docs: defineTable(
        v.object({
          "a.b": v.id("_storage"),
          "literal[]": v.id("_storage"),
          "literal{}": v.id("_storage"),
          nested: v.object({ "file.name": v.id("_storage") }),
        }),
      ),
    });

    expect(analyzeEmbeddedSchema(schema).storageIdPaths).toEqual({
      docs: ["a\\.b", "literal\\[\\]", "literal\\{\\}", "nested.file\\.name"],
    });
  });

  test("analyzes store schema and storage id paths from one schema pass", () => {
    const schema = defineSchema({
      docs: defineTable({
        body: text(),
        file: v.id("_storage"),
        slug: v.string(),
      }).index("by_slug", ["slug"]),
    });

    expect(analyzeEmbeddedSchema(schema)).toMatchObject({
      storageIdPaths: { docs: ["file"] },
      storeSchema: {
        tables: [
          {
            crdtFields: [{ field: "body", kind: "text" }],
            indexes: [
              { columns: ["idx_slug", "creation_time_ms"], fields: ["slug", "_creationTime"] },
              { columns: ["id"], fields: ["_id"] },
              { columns: ["creation_time_ms"], fields: ["_creationTime"] },
            ],
            name: "docs",
          },
        ],
      },
    });
  });
});

describe("Convex schema storage conversion — generated", () => {
  const RESERVED_COLUMNS = ["id", "identity_key", "creation_time_ms", "data"];
  const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const validatorFor = {
    string: () => v.string(),
    number: () => v.number(),
    boolean: () => v.boolean(),
    int64: () => v.int64(),
  };
  type FieldKind = keyof typeof validatorFor;

  interface TableSpec {
    fields: (readonly [string, FieldKind])[];
    indexes: { name: string; fields: string[] }[];
  }
  type SchemaSpec = (readonly [string, TableSpec])[];

  const fieldName = fc.oneof(
    fc.constantFrom(...RESERVED_COLUMNS, "idx_id", "status", "name"),
    fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/),
  );
  const fieldKind: fc.Arbitrary<FieldKind> = fc.constantFrom(
    "string",
    "number",
    "boolean",
    "int64",
  );
  const indexName = fc
    .stringMatching(/^by_[a-z][a-z0-9_]{0,9}$/)
    .filter((name) => name !== "by_id" && name !== "by_creation_time");
  const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/);

  const tableSpec: fc.Arbitrary<TableSpec> = fc
    .uniqueArray(fc.tuple(fieldName, fieldKind), {
      minLength: 1,
      maxLength: 6,
      selector: ([name]) => name,
    })
    .chain((fields) => {
      const names = fields.map(([name]) => name);
      const indexes = fc.uniqueArray(indexName, { maxLength: 4 }).chain((indexNames) =>
        indexNames.length
          ? fc.tuple(
              ...indexNames.map((name) =>
                fc
                  .uniqueArray(fc.constantFrom(...names), {
                    minLength: 1,
                    maxLength: Math.min(3, names.length),
                  })
                  .map((indexFields) => ({ name, fields: indexFields })),
              ),
            )
          : fc.constant([] as { name: string; fields: string[] }[]),
      );
      return fc.record({ fields: fc.constant(fields), indexes });
    });

  const schemaSpec: fc.Arbitrary<SchemaSpec> = fc
    .uniqueArray(identifier, { minLength: 1, maxLength: 3 })
    .chain((tableNames) =>
      fc.tuple(...tableNames.map((name) => tableSpec.map((spec) => [name, spec] as const))),
    );

  interface LooseTableBuilder {
    index(name: string, fields: readonly string[]): LooseTableBuilder;
  }

  function build(spec: SchemaSpec) {
    const tables: Record<string, ReturnType<typeof defineTable>> = {};
    for (const [name, table] of spec) {
      const fields = Object.fromEntries(
        table.fields.map(([field, kind]) => [field, validatorFor[kind]()]),
      );
      let builder = defineTable(fields) as unknown as LooseTableBuilder;
      for (const index of table.indexes) {
        builder = builder.index(index.name, index.fields);
      }
      tables[name] = builder as unknown as ReturnType<typeof defineTable>;
    }
    return toStoreSchema(defineSchema(tables));
  }

  test("every table carries the reserved by_id and by_creation_time indexes", () => {
    fc.assert(
      fc.property(schemaSpec, (spec) => {
        for (const table of build(spec).tables) {
          expect(table.indexes).toContainEqual({ name: "by_id", fields: ["_id"], columns: ["id"] });
          expect(table.indexes).toContainEqual({
            name: "by_creation_time",
            fields: ["_creationTime"],
            columns: ["creation_time_ms"],
          });
        }
      }),
    );
  });

  test("every non-id index ends with the _creationTime tiebreaker and resolves all columns", () => {
    fc.assert(
      fc.property(schemaSpec, (spec) => {
        for (const table of build(spec).tables) {
          const declared = new Set(table.columns.map((column) => column.name));
          for (const index of table.indexes) {
            if (index.name === "by_id") continue;
            const columns = index.columns;
            if (!columns) throw new Error(`index ${index.name} has no storage columns`);
            expect(index.fields.at(-1)).toBe("_creationTime");
            expect(columns.at(-1)).toBe("creation_time_ms");
            expect(columns).toHaveLength(index.fields.length);
            for (const column of columns) {
              const resolved =
                column === "id" || column === "creation_time_ms" || declared.has(column);
              expect(resolved).toBe(true);
            }
          }
        }
      }),
    );
  });

  test("storage columns are unique, valid identifiers that avoid reserved names", () => {
    fc.assert(
      fc.property(schemaSpec, (spec) => {
        for (const table of build(spec).tables) {
          const names = table.columns.map((column) => column.name);
          expect(new Set(names).size).toBe(names.length);
          for (const name of names) {
            expect(name).toMatch(IDENTIFIER);
            expect(name.length).toBeLessThanOrEqual(64);
            expect(RESERVED_COLUMNS).not.toContain(name);
          }
        }
      }),
    );
  });
});
