import { v } from "convex/values";
import type { Infer, Validator, ValidatorJSON } from "convex/values";

import { type EmbeddedAnnotatedValidator, withEmbeddedFieldMeta } from "./meta";

export type EmbeddedValue<
  Value extends Validator<any, any, any>,
  Placement extends "replicated" | "remote" | "local",
> = EmbeddedAnnotatedValidator<Value, Placement>;

function text(): EmbeddedValue<Validator<string>, "replicated"> {
  return withEmbeddedFieldMeta(v.string(), {
    crdt: { kind: "text" },
    placement: "replicated",
  }) as EmbeddedAnnotatedValidator<Validator<string>, "replicated">;
}

function count(): EmbeddedValue<Validator<number>, "replicated"> {
  return withEmbeddedFieldMeta(v.number(), {
    crdt: { kind: "count" },
    placement: "replicated",
  }) as EmbeddedAnnotatedValidator<Validator<number>, "replicated">;
}

function set<T extends Validator<any, "required", any>>(
  member: T,
): EmbeddedValue<Validator<Infer<T>[]>, "replicated"> {
  const json = (member as unknown as { json: ValidatorJSON }).json;
  return withEmbeddedFieldMeta(v.array(member), {
    crdt: { kind: "set", member: json },
    placement: "replicated",
  }) as unknown as EmbeddedAnnotatedValidator<Validator<Infer<T>[]>, "replicated">;
}

function remote<T extends Validator<any, any, any>>(member: T): EmbeddedValue<T, "remote"> {
  return withEmbeddedFieldMeta(member, { placement: "remote" }) as EmbeddedAnnotatedValidator<
    T,
    "remote"
  >;
}

function local<T extends Validator<any, any, any>>(member: T): EmbeddedValue<T, "local"> {
  return withEmbeddedFieldMeta(member, { placement: "local" }) as EmbeddedAnnotatedValidator<
    T,
    "local"
  >;
}

/** Embedded-aware value constructors and field placement annotations. */
export const e = Object.freeze({ count, local, remote, set, text });
