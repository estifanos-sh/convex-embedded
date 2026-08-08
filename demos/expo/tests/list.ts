import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  documentIdSetsAreEqual,
  documentListItems,
  documentRowIsEqual,
  type DocumentRowProps,
  type DocumentSummary,
} from "../src/row";

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

void describe("document list projection", () => {
  void it("keeps pinned and unpinned query order in one projection", () => {
    const second = {
      ...document,
      _id: "documents|second" as DocumentSummary["_id"],
      title: "Second",
    };
    const third = { ...document, _id: "documents|third" as DocumentSummary["_id"], title: "Third" };

    const items = documentListItems(
      [document, second, third],
      new Set([third._id, second._id]),
      new Set([second._id]),
      third._id,
    );

    assert.deepEqual(
      items.map(({ document: item, expanded, opening, pinned }) => ({
        id: item._id,
        expanded,
        opening,
        pinned,
      })),
      [
        { id: second._id, expanded: true, opening: false, pinned: true },
        { id: third._id, expanded: false, opening: true, pinned: true },
        { id: document._id, expanded: false, opening: false, pinned: false },
      ],
    );
  });

  void it("recognizes an unchanged local id set", () => {
    assert.equal(documentIdSetsAreEqual(new Set(["one", "two"]), new Set(["two", "one"])), true);
    assert.equal(documentIdSetsAreEqual(new Set(["one"]), new Set(["two"])), false);
  });
});
