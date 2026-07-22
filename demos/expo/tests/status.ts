import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { documentStatus } from "../src/status";

void describe("document status", () => {
  void it("reports local save progress before remote state", () => {
    const connection = { local: "ready", remote: "ready" } as const;
    assert.equal(documentStatus("dirty", connection).label, "Unsaved");
    assert.equal(documentStatus("saving", connection).label, "Saving");
    assert.equal(documentStatus("error", connection).label, "Retry");
  });

  void it("distinguishes a local save from completed replication", () => {
    assert.equal(documentStatus("saved", { local: "ready", remote: "disabled" }).label, "Saved");
    assert.equal(documentStatus("saved", { local: "ready", remote: "connected" }).label, "Syncing");
    assert.equal(documentStatus("saved", { local: "ready", remote: "ready" }).label, "Synced");
    assert.equal(
      documentStatus("saved", { local: "ready", remote: "offline" }).label,
      "Saved offline",
    );
  });

  void it("surfaces remote failures without turning them into a local save retry", () => {
    const status = documentStatus("saved", {
      local: "ready",
      remote: "error",
      remoteError: "Deployment mismatch",
    });
    assert.equal(status.label, "Sync error");
    assert.equal(status.accessibilityLabel, "Sync error: Deployment mismatch");
    assert.equal(status.tone, "error");
  });
});
