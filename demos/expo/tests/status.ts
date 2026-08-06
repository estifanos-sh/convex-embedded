import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { documentStatus } from "../src/status";

void describe("document status", () => {
  void it("reports local save progress before remote state", () => {
    const connection = {
      local: { persistence: "durable", status: "ready" },
      replication: { status: "online", sync: "idle" },
    } as const;
    assert.equal(documentStatus("dirty", connection).label, "Unsaved");
    assert.equal(documentStatus("saving", connection).label, "Saving");
    assert.equal(documentStatus("error", connection).label, "Retry");
  });

  void it("distinguishes a local save from completed replication", () => {
    assert.equal(
      documentStatus("saved", {
        local: { persistence: "durable", status: "ready" },
        replication: { status: "disabled" },
      }).label,
      "Saved",
    );
    assert.equal(
      documentStatus("saved", {
        local: { persistence: "durable", status: "ready" },
        replication: { status: "online", sync: "pending" },
      }).label,
      "Syncing",
    );
    assert.equal(
      documentStatus("saved", {
        local: { persistence: "durable", status: "ready" },
        replication: { status: "online", sync: "idle" },
      }).label,
      "Synced",
    );
    assert.equal(
      documentStatus("saved", {
        local: { persistence: "durable", status: "ready" },
        replication: { status: "offline" },
      }).label,
      "Saved offline",
    );
  });

  void it("surfaces remote failures without turning them into a local save retry", () => {
    const status = documentStatus("saved", {
      local: { persistence: "durable", status: "ready" },
      replication: {
        error: { code: "EMBEDDED_REPLICATION", message: "Deployment mismatch" },
        status: "error",
      },
    });
    assert.equal(status.label, "Sync error");
    assert.equal(status.accessibilityLabel, "Sync error: Deployment mismatch");
    assert.equal(status.tone, "error");
  });
});
