import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { embeddedFieldMeta } from "../../src/meta";
import { e } from "../../src/values";

function json(value: unknown) {
  return (value as { json: unknown }).json;
}

describe("embedded values", () => {
  test("named CRDT validators remain normal Convex validators", () => {
    expect(json(e.text())).toEqual(json(v.string()));
    expect(json(e.count())).toEqual(json(v.number()));
    expect(json(e.set(v.string()))).toEqual(json(v.array(v.string())));
    expect(json(e.remote(v.string()))).toEqual(json(v.string()));
    expect(json(e.local(v.boolean()))).toEqual(json(v.boolean()));
  });

  test("named validators carry private runtime metadata", () => {
    const body = e.text();
    const votes = e.count();
    const tags = e.set(v.string());

    expect(embeddedFieldMeta(body)).toEqual({
      crdt: { kind: "text" },
      placement: "replicated",
    });
    expect(embeddedFieldMeta(votes)).toEqual({
      crdt: { kind: "count" },
      placement: "replicated",
    });
    expect(embeddedFieldMeta(tags)).toEqual({
      crdt: { kind: "set", member: { type: "string" } },
      placement: "replicated",
    });
    expect(embeddedFieldMeta(e.remote(v.string()))).toEqual({ placement: "remote" });
    expect(embeddedFieldMeta(e.local(v.boolean()))).toEqual({ placement: "local" });
    expect(embeddedFieldMeta(v.string())).toBeNull();
  });

  test("annotations cannot be combined", () => {
    expect(() => e.local(e.text())).toThrow("cannot be combined");
    expect(() => e.remote(e.set(v.string()))).toThrow("cannot be combined");
  });
});
