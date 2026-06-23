import type { GenericValidator, ValidatorJSON } from "convex/values";

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

export type EmbeddedCrdtKind = "text" | "count" | "set";

export type EmbeddedCrdtMeta =
  | { kind: "text" }
  | { kind: "count" }
  | { kind: "set"; member: ValidatorJSON };

type EmbeddedCrdtValidator = GenericValidator & {
  readonly [CRDT_FIELD]?: EmbeddedCrdtMeta;
};

export function withCrdtMeta<T extends GenericValidator>(validator: T, meta: EmbeddedCrdtMeta): T {
  Object.defineProperty(validator, CRDT_FIELD, {
    configurable: false,
    enumerable: false,
    value: Object.freeze(meta),
    writable: false,
  });
  const asOptional = (validator as unknown as { asOptional(): GenericValidator }).asOptional.bind(
    validator,
  );
  Object.defineProperty(validator, "asOptional", {
    configurable: false,
    enumerable: false,
    value: () => withCrdtMeta(asOptional(), meta),
    writable: false,
  });
  return validator;
}

export function embeddedCrdtMeta(value: unknown): EmbeddedCrdtMeta | null {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { isConvexValidator?: unknown }).isConvexValidator !== true
  ) {
    return null;
  }
  return (value as EmbeddedCrdtValidator)[CRDT_FIELD] ?? null;
}
