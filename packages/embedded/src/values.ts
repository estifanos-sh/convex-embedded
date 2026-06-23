import { v } from "convex/values";
import type { Infer, Validator, ValidatorJSON } from "convex/values";

import { withCrdtMeta } from "./crdt/meta";

export function text(): Validator<string> {
  return withCrdtMeta(v.string(), { kind: "text" });
}

export function count(): Validator<number> {
  return withCrdtMeta(v.number(), { kind: "count" });
}

export function set<T extends Validator<any, "required", any>>(member: T): Validator<Infer<T>[]> {
  const json = (member as unknown as { json: ValidatorJSON }).json;
  return withCrdtMeta(v.array(member), { kind: "set", member: json });
}
