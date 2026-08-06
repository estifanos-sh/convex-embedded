import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { documentRowIsEqual, type DocumentRowProps, type DocumentSummary } from "../src/row";

const document: DocumentSummary = {
  _creationTime: 1,
  _id: "documents|row" as DocumentSummary["_id"],
  body: "[]",
  slug: "row",
  title: "Row",
  updatedAt: 1,
};

const onOpen: DocumentRowProps["onOpen"] = () => undefined;
const onToggleExpanded: DocumentRowProps["onToggleExpanded"] = () => undefined;
const onTogglePin: DocumentRowProps["onTogglePin"] = () => undefined;

function row(overrides: Partial<DocumentRowProps> = {}): DocumentRowProps {
  return {
    document,
    expanded: false,
    opening: false,
    pinned: false,
    onOpen,
    onToggleExpanded,
    onTogglePin,
    ...overrides,
  };
}

void describe("document row memo boundary", () => {
  void it("accepts reconstructed query records when their visible row state is unchanged", () => {
    const current = row();

    assert.equal(documentRowIsEqual(current, row({ document: { ...document } })), true);
    assert.equal(
      documentRowIsEqual(current, row({ document: { ...document, body: "changed" } })),
      true,
    );
    assert.equal(
      documentRowIsEqual(current, row({ document: { ...document, _creationTime: 2 } })),
      true,
    );
  });

  void it("invalidates every displayed field, control state, and handler", () => {
    const current = row();
    const changed = (overrides: Partial<DocumentRowProps>) =>
      assert.equal(documentRowIsEqual(current, row(overrides)), false);

    changed({ document: { ...document, _id: "documents|other" as DocumentSummary["_id"] } });
    changed({ document: { ...document, slug: "other" } });
    changed({ document: { ...document, title: "Other" } });
    changed({ document: { ...document, updatedAt: 2 } });
    changed({ expanded: true });
    changed({ opening: true });
    changed({ pinned: true });
    changed({ onOpen: () => undefined });
    changed({ onToggleExpanded: () => undefined });
    changed({ onTogglePin: () => undefined });
  });
});
