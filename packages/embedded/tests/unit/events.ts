import { describe, expect, test } from "vite-plus/test";

import type { DiagnosticEvent } from "../../src/events";

describe("internal diagnostic events", () => {
  test("retain rich data only for private consumers", () => {
    const event: DiagnosticEvent = {
      at: 1,
      changedTables: ["todos"],
      deletes: [{ id: "removed", table: "todos" }],
      docWrites: [{ id: "written", row: { title: "Draft" }, table: "todos" }],
      source: "local",
      type: "data",
    };

    expect(event).toMatchObject({
      changedTables: ["todos"],
      type: "data",
    });
  });
});
