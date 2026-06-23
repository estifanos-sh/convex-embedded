import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { embeddedCrdtMeta } from "../../src/crdt/meta";
import { count, set, text } from "../../src/values";

function json(value: unknown) {
  return (value as { json: unknown }).json;
}

describe("embedded values", () => {
  test("named CRDT validators remain normal Convex validators", () => {
    expect(json(text())).toEqual(json(v.string()));
    expect(json(count())).toEqual(json(v.number()));
    expect(json(set(v.string()))).toEqual(json(v.array(v.string())));
  });

  test("named validators carry private runtime metadata", () => {
    const body = text();
    const votes = count();
    const tags = set(v.string());

    expect(embeddedCrdtMeta(body)).toEqual({ kind: "text" });
    expect(embeddedCrdtMeta(votes)).toEqual({ kind: "count" });
    expect(embeddedCrdtMeta(tags)).toEqual({ kind: "set", member: { type: "string" } });
    expect(embeddedCrdtMeta(v.string())).toBeNull();
  });
});
