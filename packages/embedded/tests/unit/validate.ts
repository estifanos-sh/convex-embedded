import { type GenericValidator, type ValidatorJSON, v } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import { validateFields, validateJson, validateValue } from "../../src/runtime/validate";

type Case = {
  name: string;
  value: unknown;
  validator: GenericValidator;
  error?: string;
};

const cases: Case[] = [
  {
    name: "primitive",
    value: 1,
    validator: v.string(),
    error: "value must be a string",
  },
  {
    name: "array entry",
    value: ["first", 2],
    validator: v.array(v.string()),
    error: "value[1] must be a string",
  },
  {
    name: "record key",
    value: { other: "entry" },
    validator: v.record(v.union(v.literal("first"), v.literal("second")), v.string()),
    error: "value.other key does not match any union member",
  },
  {
    name: "record value",
    value: { first: ["ok", false] },
    validator: v.record(v.string(), v.array(v.string())),
    error: "value.first[1] must be a string",
  },
  {
    name: "record key name",
    value: { $reserved: "entry" },
    validator: v.record(v.string(), v.string()),
    error: "value: record key \"$reserved\" starts with a reserved '$'",
  },
  {
    name: "union",
    value: false,
    validator: v.union(v.string(), v.number()),
    error: "value does not match any union member",
  },
  {
    name: "object field",
    value: { name: "Ada", extra: true },
    validator: v.object({ name: v.string() }),
    error: "value.extra is not a declared field",
  },
  {
    name: "optional object field",
    value: {},
    validator: v.object({ alias: v.optional(v.string()) }),
  },
];

function json(validator: GenericValidator): ValidatorJSON {
  return (validator as unknown as { json: ValidatorJSON }).json;
}

describe("runtime validator traversal", () => {
  test.each(cases)(
    "keeps runtime and JSON $name errors identical",
    ({ value, validator, error }) => {
      const runtime = () => validateValue(value, validator, "value");
      const exported = () => validateJson(value, json(validator), "value");

      if (error === undefined) {
        expect(runtime).not.toThrow();
        expect(exported).not.toThrow();
        return;
      }

      expect(runtime).toThrow(error);
      expect(exported).toThrow(error);
    },
  );

  test("keeps declared-field and optional-field paths", () => {
    const fields = { name: v.string(), alias: v.optional(v.string()) };

    expect(() => validateFields({ name: "Ada" }, fields, "args")).not.toThrow();
    expect(() => validateFields({ name: "Ada", extra: true }, fields, "args")).toThrow(
      "args.extra is not a declared field",
    );
    expect(() => validateFields({}, fields, "args")).toThrow("args.name is required");
  });
});
