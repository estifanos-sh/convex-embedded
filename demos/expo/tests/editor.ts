import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  documentWrite,
  documentBlocks,
  draftFingerprint,
  emptyBlocks,
  normalizeDocumentDraft,
  parseBlocks,
  recoveryDecode,
  recoveryDecision,
  recoveryEncode,
  recoveryRecord,
  textSplice,
  titleFromBlocks,
} from "../src/text";
import type { EditorDraft } from "../src/types";

void describe("editor text", () => {
  void it("creates Unicode-safe UTF-16 splices", () => {
    const samples = ["", "plain text", "🙂 alpha", "e\u0301", "雪の文書", "👨‍👩‍👧‍👦 family"];
    for (const before of samples) {
      for (const after of samples) {
        const splice = textSplice(before, after);
        const result = splice
          ? before.slice(0, splice.index) +
            splice.insert +
            before.slice(splice.index + splice.delete)
          : before;
        assert.equal(result, after);
      }
    }
    assert.deepEqual(textSplice("🙂a", "🙂b"), { delete: 1, index: 2, insert: "b" });
  });

  void it("falls back to a usable document for malformed or empty bodies", () => {
    assert.deepEqual(parseBlocks("not json"), emptyBlocks);
    assert.deepEqual(parseBlocks("[]"), emptyBlocks);
    assert.deepEqual(parseBlocks('{"type":"paragraph"}'), emptyBlocks);
    const valid = [{ type: "paragraph", content: "hello" }];
    assert.deepEqual(parseBlocks(JSON.stringify(valid)), valid);
  });

  void it("uses only the dedicated first block for the document title", () => {
    const body = [
      { type: "heading", content: "Stale body title" },
      { type: "paragraph", content: "Body text must not become the title" },
    ];
    const blocks = documentBlocks(JSON.stringify(body), "Stored title");
    assert.equal(titleFromBlocks(blocks), "Stored title");
    assert.equal(
      titleFromBlocks([
        { type: "heading", content: "" },
        { type: "paragraph", content: "Body text" },
      ]),
      "",
    );
    const normalized = normalizeDocumentDraft({
      body: JSON.stringify(body),
      title: "Stored title",
    });
    assert.equal(titleFromBlocks(parseBlocks(normalized.body)), "Stored title");
  });
});

void describe("editor recovery", () => {
  const base: EditorDraft = { body: "base body", title: "Base" };
  const draft: EditorDraft = { body: "draft 🙂", title: "Draft" };

  void it("uses a stable compact fingerprint that changes with either field", () => {
    assert.equal(draftFingerprint(base), draftFingerprint({ ...base }));
    assert.notEqual(draftFingerprint(base), draftFingerprint({ ...base, body: "base body!" }));
    assert.notEqual(draftFingerprint(base), draftFingerprint({ ...base, title: "Other" }));
    assert.ok(draftFingerprint(base).length < 40);
  });

  void it("recovers only when the native baseline still matches", () => {
    const record = recoveryRecord(draftFingerprint(base), draft);
    assert.deepEqual(recoveryDecision(base, record), {
      draft,
      recovered: true,
      remove: false,
    });

    const newer = { body: "newer native body", title: "Newer" };
    assert.deepEqual(recoveryDecision(newer, record), {
      draft: newer,
      recovered: false,
      remove: true,
    });
    assert.deepEqual(recoveryDecision(draft, record), {
      draft,
      recovered: false,
      remove: true,
    });

    const newerDraft = { body: "newer pending body", title: "Newer pending" };
    const rebased = recoveryRecord(draftFingerprint(draft), newerDraft);
    assert.deepEqual(recoveryDecision(draft, rebased), {
      draft: newerDraft,
      recovered: true,
      remove: false,
    });
  });

  void it("discards malformed recovery values", () => {
    assert.deepEqual(recoveryDecision(base, { base: 42, draft, version: 2 }), {
      draft: base,
      recovered: false,
      remove: true,
    });
    assert.deepEqual(recoveryDecision(base, null), {
      draft: base,
      recovered: false,
      remove: true,
    });
  });

  void it("encodes the body without JSON-escaping it a second time", () => {
    const record = recoveryRecord(draftFingerprint(base), draft);
    const encoded = recoveryEncode(record);
    assert.ok(encoded.endsWith(`\n${draft.body}`));
    assert.deepEqual(recoveryDecode(encoded), record);
  });
});

void describe("editor writes", () => {
  void it("skips identical drafts and supports title-only writes", () => {
    const base = { body: "body", title: "Before" };
    assert.equal(documentWrite("id", base, { ...base }), undefined);
    assert.deepEqual(documentWrite("id", base, { ...base, title: "After" }), {
      id: "id",
      splices: [],
      title: "After",
    });
  });

  void it("builds one compact body splice", () => {
    const write = documentWrite(
      "id",
      { body: "hello 🙂 world", title: "Title" },
      { body: "hello bright world", title: "Title" },
    );
    assert.ok(write);
    assert.equal(write.splices.length, 1);
    const before = "hello 🙂 world";
    const splice = write.splices[0]!;
    const result =
      before.slice(0, splice.index) + splice.insert + before.slice(splice.index + splice.delete);
    assert.equal(result, "hello bright world");
  });
});
