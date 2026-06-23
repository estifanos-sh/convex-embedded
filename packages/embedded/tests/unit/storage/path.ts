import { describe, expect, test } from "vite-plus/test";

import {
  compileStorageIdPaths,
  diffStorageIds,
  readStorageIds,
} from "../../../src/storage/id/path";

describe("storage-id-path id extraction", () => {
  test("reads a single field ref", () => {
    const compiled = compileStorageIdPaths(["image"]);
    expect(readStorageIds({ image: "s1" }, compiled)).toEqual(["s1"]);
  });

  test("skips a missing or cleared optional field", () => {
    const compiled = compileStorageIdPaths(["image"]);
    expect(readStorageIds({}, compiled)).toEqual([]);
    expect(readStorageIds({ image: null }, compiled)).toEqual([]);
  });

  test("skips non-string leaves", () => {
    const compiled = compileStorageIdPaths(["image"]);
    expect(readStorageIds({ image: 42 }, compiled)).toEqual([]);
  });

  test("reads each element of an array ref with multiplicity", () => {
    const compiled = compileStorageIdPaths(["attachments[]"]);
    expect(readStorageIds({ attachments: ["s1", "s2", "s1"] }, compiled)).toEqual([
      "s1",
      "s2",
      "s1",
    ]);
  });

  test("descends into a nested object ref", () => {
    const compiled = compileStorageIdPaths(["cover.hero"]);
    expect(readStorageIds({ cover: { hero: "s9" } }, compiled)).toEqual(["s9"]);
    expect(readStorageIds({ cover: {} }, compiled)).toEqual([]);
    expect(readStorageIds({}, compiled)).toEqual([]);
  });

  test("treats escaped separators and collection markers as literal field names", () => {
    const compiled = compileStorageIdPaths([
      "a\\.b",
      "literal\\[\\]",
      "literal\\{\\}",
      "nested.actual\\.field",
    ]);
    expect(
      readStorageIds(
        {
          "a.b": "dot",
          "literal[]": "array-name",
          "literal{}": "record-name",
          nested: { "actual.field": "nested-dot" },
        },
        compiled,
      ),
    ).toEqual(["dot", "array-name", "record-name", "nested-dot"]);
  });

  test("composes array-of-object refs", () => {
    const compiled = compileStorageIdPaths(["gallery[].hero"]);
    expect(readStorageIds({ gallery: [{ hero: "a" }, { hero: "b" }, {}] }, compiled)).toEqual([
      "a",
      "b",
    ]);
  });

  test("composes record refs", () => {
    const compiled = compileStorageIdPaths(["attachments{}", "nested{}.image"]);
    expect(
      readStorageIds(
        {
          attachments: { cover: "a", ignored: 1 },
          nested: { first: { image: "b" }, second: {} },
        },
        compiled,
      ),
    ).toEqual(["a", "b"]);
  });

  test("reads across multiple storage-id paths", () => {
    const compiled = compileStorageIdPaths(["image", "attachments[]"]);
    expect(readStorageIds({ image: "s1", attachments: ["s2"] }, compiled)).toEqual(["s1", "s2"]);
  });

  test("a null row yields no ids", () => {
    const compiled = compileStorageIdPaths(["image"]);
    expect(readStorageIds(null, compiled)).toEqual([]);
  });
});

describe("storage-id-path before/after diff", () => {
  test("field overwrite dereferences old and references new", () => {
    const compiled = compileStorageIdPaths(["image"]);
    const diff = diffStorageIds(
      readStorageIds({ image: "old" }, compiled),
      readStorageIds({ image: "new" }, compiled),
    );
    expect(diff.dereferenced).toEqual(["old"]);
    expect(diff.newlyReferenced).toEqual(["new"]);
  });

  test("same id both sides is a no-op", () => {
    const compiled = compileStorageIdPaths(["image"]);
    const diff = diffStorageIds(
      readStorageIds({ image: "s1" }, compiled),
      readStorageIds({ image: "s1" }, compiled),
    );
    expect(diff.dereferenced).toEqual([]);
    expect(diff.newlyReferenced).toEqual([]);
  });

  test("row delete dereferences every prior id", () => {
    const compiled = compileStorageIdPaths(["image", "attachments[]"]);
    const diff = diffStorageIds(
      readStorageIds({ image: "s1", attachments: ["s2", "s3"] }, compiled),
      readStorageIds(null, compiled),
    );
    expect(diff.dereferenced.sort()).toEqual(["s1", "s2", "s3"]);
    expect(diff.newlyReferenced).toEqual([]);
  });

  test("array element removal dereferences only the removed element", () => {
    const compiled = compileStorageIdPaths(["attachments[]"]);
    const diff = diffStorageIds(
      readStorageIds({ attachments: ["s1", "s2"] }, compiled),
      readStorageIds({ attachments: ["s1"] }, compiled),
    );
    expect(diff.dereferenced).toEqual(["s2"]);
    expect(diff.newlyReferenced).toEqual([]);
  });

  test("duplicate ids keep multiplicity: removing one leaves one referenced", () => {
    const compiled = compileStorageIdPaths(["attachments[]"]);
    const diff = diffStorageIds(
      readStorageIds({ attachments: ["s1", "s1"] }, compiled),
      readStorageIds({ attachments: ["s1"] }, compiled),
    );
    expect(diff.dereferenced).toEqual(["s1"]);
    expect(diff.newlyReferenced).toEqual([]);
  });

  test("array insert references only the added element", () => {
    const compiled = compileStorageIdPaths(["attachments[]"]);
    const diff = diffStorageIds(
      readStorageIds({ attachments: ["s1"] }, compiled),
      readStorageIds({ attachments: ["s1", "s2"] }, compiled),
    );
    expect(diff.dereferenced).toEqual([]);
    expect(diff.newlyReferenced).toEqual(["s2"]);
  });

  test("empty compiled paths short-circuit to no ids", () => {
    const compiled = compileStorageIdPaths([]);
    expect(readStorageIds({ image: "s1" }, compiled)).toEqual([]);
  });
});
