import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  documentBlocks,
  draftFingerprint,
  emptyBlocks,
  isEmptyTable,
  normalizeDocumentDraft,
  parseBlocks,
  recoveryDecode,
  recoveryDecision,
  recoveryEncode,
  recoveryRecord,
  titleRecoveryDecision,
  titleRecoveryRecord,
  titleFromBlocks,
} from "../src/text";
import { documentPreview } from "../src/preview";
import type { EditorDraft } from "../src/types";

void describe("editor text", () => {
  void it("recognizes only completely empty BlockNote tables", () => {
    assert.equal(
      isEmptyTable({
        type: "table",
        content: {
          rows: [
            { cells: [[], [], []] },
            {
              cells: [
                { type: "tableCell", content: [] },
                { type: "tableCell", content: [] },
                { type: "tableCell", content: [] },
              ],
            },
          ],
        },
      }),
      true,
    );
    assert.equal(
      isEmptyTable({
        type: "table",
        content: { rows: [{ cells: [[{ type: "text", text: "kept" }], [], []] }] },
      }),
      false,
    );
    assert.equal(isEmptyTable({ type: "paragraph", content: [] }), false);
  });

  void it("builds an immediate native preview without repeating the title", () => {
    const body = JSON.stringify([
      { type: "heading", content: "Title" },
      { type: "paragraph", content: [{ type: "text", text: "First line" }] },
      { type: "paragraph", content: "Second line" },
    ]);
    assert.equal(documentPreview(body), "First line\nSecond line");
    assert.equal(documentPreview("not json"), "");
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

  void it("mirrors a native title into block zero without changing document content", () => {
    const body = [
      { type: "heading", props: { level: 1 }, content: "Before" },
      { type: "heading", props: { level: 2 }, content: "Section" },
      { type: "paragraph", content: "Body text" },
    ];
    const next = normalizeDocumentDraft({ body: JSON.stringify(body), title: "After 🙂" });
    const blocks = parseBlocks(next.body);

    assert.equal(titleFromBlocks(blocks), "After 🙂");
    assert.deepEqual(blocks.slice(1), body.slice(1));
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

  void it("recovers titles independently from body progress", () => {
    const titleRecord = titleRecoveryRecord("Before", "After");
    const advancedBody = { body: "new native body", title: "Before" };
    const staleBodyRecovery = recoveryRecord(draftFingerprint(base), draft);

    assert.equal(recoveryDecision(advancedBody, staleBodyRecovery).recovered, false);
    assert.deepEqual(titleRecoveryDecision(advancedBody.title, titleRecord), {
      recovered: true,
      remove: false,
      title: "After",
    });
    assert.deepEqual(titleRecoveryDecision("Changed elsewhere", titleRecord), {
      recovered: false,
      remove: true,
      title: "Changed elsewhere",
    });
    assert.deepEqual(titleRecoveryDecision("After", titleRecord), {
      recovered: false,
      remove: true,
      title: "After",
    });
  });
});
