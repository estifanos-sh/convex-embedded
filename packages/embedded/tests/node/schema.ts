import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { toStoreSchema } from "../../src/schema";

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
      tables: [
        {
          name: "users",
          columns: [
            { name: "idx_profile_email", field: "profile.email" },
            { name: "status", field: undefined },
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
              columns: ["status", "creation_time_ms"],
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
      columns: [{ name: "status", field: undefined }],
      indexes: [
        {
          columns: ["status", "creation_time_ms"],
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

    // A union of string|number on an indexed field is now valid: order keys sort any type.
    expect(toStoreSchema(schema).tables[0]!.columns).toEqual([{ name: "value", field: undefined }]);
  });
});
