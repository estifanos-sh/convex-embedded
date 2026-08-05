import { describe, expect, test, vi } from "vite-plus/test";
import { v } from "convex/values";

import { applyQueuedMutationPolicy, validateStoreSetup } from "../../src/migrations";
import { setupWorkspaceSchema } from "../../src/storage/workspace";
import type { RuntimeStorage, StoreSchema } from "../../src/storage/types";
import { defineEmbeddedSchema, localTable } from "../../src/schema";

const source: StoreSchema = {
  hash: "source",
  tables: [
    {
      name: "docs",
      placement: "device",
      columns: [{ name: "status", field: "state" }],
      crdtFields: [{ field: "body", kind: "text" }],
      document: { type: "string" } as never,
      indexes: [{ name: "by_status", fields: ["state"], columns: ["status"] }],
    },
  ],
};

const target: StoreSchema = {
  hash: "target",
  tables: [
    {
      name: "docs",
      placement: "device",
      columns: [{ name: "status", field: "phase" }],
      crdtFields: [{ field: "body", kind: "count" }],
      document: { type: "number" } as never,
      indexes: [{ name: "by_status", fields: ["phase"], columns: ["status"] }],
    },
  ],
};

describe("candidate setup workspace", () => {
  test("keeps source projections privately while target semantics own public names", () => {
    const workspace = setupWorkspaceSchema(source, target, []);
    const table = workspace.tables[0]!;
    const sourceColumn = table.columns.find((column) => column.field === "state")!;
    const sourceIndex = table.indexes.find((index) => index.fields[0] === "state")!;

    expect(table.document).toEqual(target.tables[0]!.document);
    expect(sourceColumn.name).toMatch(/^setup_c_[0-9a-f]{40}$/);
    expect(table.columns).toContainEqual({ name: "status", field: "phase" });
    expect(sourceIndex.name).toMatch(/^setup_i_[0-9a-f]{40}$/);
    expect(sourceIndex.columns).toEqual([sourceColumn.name]);
    expect(table.indexes).toContainEqual({
      name: "by_status",
      fields: ["phase"],
      columns: ["status"],
    });
    expect(table.crdtFields).toEqual([{ field: "body", kind: "count" }]);
  });

  test("allocates collision-safe bounded aliases across three skipped shapes", () => {
    const compatibility: StoreSchema = {
      ...target,
      hash: "compatibility",
      tables: [
        {
          ...target.tables[0]!,
          columns: [{ name: "status", field: "stage" }],
          indexes: [{ name: "by_status", fields: ["stage"], columns: ["status"] }],
        },
      ],
    };
    const sourceToCompatibility = setupWorkspaceSchema(source, compatibility, []);
    const workspace = setupWorkspaceSchema(sourceToCompatibility, target, []);
    const table = workspace.tables[0]!;
    const columnNames = table.columns.map((column) => column.name);
    const indexNames = table.indexes.map((index) => index.name);

    expect(new Set(columnNames).size).toBe(columnNames.length);
    expect(new Set(indexNames).size).toBe(indexNames.length);
    expect(columnNames.every((name) => new TextEncoder().encode(name).length <= 64)).toBe(true);
    expect(indexNames.every((name) => new TextEncoder().encode(name).length <= 64)).toBe(true);
    expect(
      table.columns.map((column) => column.field).sort((a, b) => a!.localeCompare(b!)),
    ).toEqual(["phase", "stage", "state"]);
  });

  test("rejects a compatibility function that would silently bind a changed index name", () => {
    const compatibility = defineEmbeddedSchema({
      docs: localTable({ state: v.string() }).index("by_status", ["state"]),
    });

    expect(() => setupWorkspaceSchema(source, target, [compatibility])).toThrow(
      "Setup compatibility index conflict for docs.by_status",
    );
  });

  test("rejects carried documents that the target validator does not accept", async () => {
    const targetSchema: StoreSchema = {
      hash: "target-validator",
      tables: [
        {
          name: "docs",
          placement: "device",
          columns: [],
          document: {
            type: "object",
            value: { status: { fieldType: { type: "string" }, optional: false } },
          },
          indexes: [],
        },
      ],
    };
    const store = {
      doc: {
        page: {
          read: async () => ({
            cursor: null,
            docs: [{ _creationTime: 1, _id: "docs:1", status: 7 }],
          }),
        },
      },
    } as unknown as RuntimeStorage;

    await expect(validateStoreSetup(store, targetSchema)).rejects.toThrow(
      "docs.status must be a string",
    );
  });

  test("retains an invalid orphan local-field origin without publishing it", async () => {
    const targetSchema: StoreSchema = {
      hash: "target-local-field",
      tables: [
        {
          name: "docs",
          placement: "replicated",
          columns: [],
          indexes: [],
          localFields: [{ field: "draft", validator: { type: "string" } as never }],
        },
      ],
    };
    const store = {
      doc: {
        read: async () => undefined,
        page: { read: async () => ({ cursor: null, docs: [] }) },
      },
    } as unknown as RuntimeStorage;
    const disposition = vi.fn(async () => undefined);
    const binding = {
      migrationBegin: async () => "{}",
      migrationCommit: async () => undefined,
      migrationRecordDispositionWrite: disposition,
      originPageRead: async () =>
        JSON.stringify({
          cursor: null,
          records: [
            {
              identityKey: "anonymous",
              kind: 3,
              recordKey: btoa("docs\0docs:missing\0draft"),
              flags: 0,
              payload: btoa(
                JSON.stringify({ table: "docs", id: "docs:missing", field: "draft", value: 7 }),
              ),
            },
          ],
        }),
    };

    await expect(validateStoreSetup(store, targetSchema, binding, 1)).resolves.toBeUndefined();
    expect(disposition).toHaveBeenCalledWith(
      1,
      "anonymous",
      3,
      expect.any(Uint8Array),
      "__embedded_target_contract__",
      "target contract does not accept docs.draft without a base document",
      false,
    );
  });

  test("marks the first validator-incompatible queued mutation per identity", async () => {
    const targetSchema: StoreSchema = {
      hash: "target-queue",
      tables: [
        {
          name: "docs",
          placement: "replicated",
          columns: [],
          document: {
            type: "object",
            value: { status: { fieldType: { type: "string" }, optional: false } },
          },
          indexes: [],
        },
      ],
    };
    const policy = vi.fn(async (_generation: number, request: string) => {
      return (JSON.parse(request) as { collectComplete: boolean }).collectComplete;
    });
    const envelope = (commitSeq: number, status: unknown) => ({
      afterImages: [
        { content: "value", rowId: `docs:${commitSeq}`, table: "docs", value: { status } },
      ],
      commitSeq,
      mutationId: `mutation:${commitSeq}`,
    });
    const binding = {
      migrationBegin: async () => "{}",
      migrationCommit: async () => undefined,
      migrationQueuePolicyStateRead: async () =>
        JSON.stringify({ cursor: null, done: false, state: "collecting" }),
      migrationQueuePolicyWrite: policy,
      migrationRecordDispositionWrite: async () => undefined,
      originPageRead: async () =>
        JSON.stringify({
          cursor: null,
          records: [
            {
              flags: 0,
              identityKey: "alice",
              kind: 5,
              payload: btoa(JSON.stringify(envelope(3, "valid"))),
              recordKey: btoa("mutation:3"),
            },
            {
              flags: 0,
              identityKey: "alice",
              kind: 5,
              payload: btoa(JSON.stringify(envelope(4, 7))),
              recordKey: btoa("mutation:4"),
            },
            {
              flags: 0,
              identityKey: "alice",
              kind: 5,
              payload: btoa(JSON.stringify(envelope(5, 8))),
              recordKey: btoa("mutation:5"),
            },
          ],
        }),
    };

    await applyQueuedMutationPolicy(binding, targetSchema, 9);

    expect(policy).toHaveBeenNthCalledWith(
      1,
      9,
      JSON.stringify({
        collectComplete: true,
        cursor: null,
        thresholds: [{ commitSeq: 4, identityKey: "alice" }],
      }),
    );
  });
});
