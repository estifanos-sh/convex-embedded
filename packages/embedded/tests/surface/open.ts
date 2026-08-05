import { v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import type { EmbeddedClient } from "../../src/client";
import { defineLocal } from "../../src/local";
import { defineEmbeddedSchema } from "../../src/schema";

const local = defineLocal(defineEmbeddedSchema({}));
const valid = local.internalAction({
  args: {},
  returns: v.null(),
  handler: () => null,
});
const withArgs = local.internalAction({
  args: { value: v.string() },
  returns: v.null(),
  handler: () => null,
});
const withResult = local.internalAction({
  args: {},
  returns: v.string(),
  handler: () => "done",
});
const query = local.internalQuery({ args: {}, handler: () => null });
const mutation = local.internalMutation({ args: {}, handler: () => null });

function typecheckOpen(client: EmbeddedClient): void {
  void client.open(valid);
  // @ts-expect-error setup is a typed local action, never a string path
  void client.open("lifecycle:open");
  // @ts-expect-error setup cannot require application arguments
  void client.open(withArgs);
  // @ts-expect-error setup returns only null
  void client.open(withResult);
  // @ts-expect-error a query cannot orchestrate setup
  void client.open(query);
  // @ts-expect-error a mutation is one transaction, not the setup action
  void client.open(mutation);
}
void typecheckOpen;

describe("explicit open surface", () => {
  test("keeps setup typing in the public declaration build", () => {
    expect(valid.kind).toBe("action");
  });
});
