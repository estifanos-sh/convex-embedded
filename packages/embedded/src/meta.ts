import type { GenericValidator, Validator, ValidatorJSON, VOptional } from "convex/values";

const EMBEDDED_FIELD = Symbol.for("convex-embedded:field");
declare const EMBEDDED_FIELD_TYPE: unique symbol;

export interface EmbeddedValidator<Placement extends EmbeddedFieldPlacement> {
  readonly [EMBEDDED_FIELD_TYPE]: Placement;
}

export type EmbeddedAnnotatedValidator<
  Value extends Validator<any, any, any>,
  Placement extends EmbeddedFieldPlacement,
> = Value &
  EmbeddedValidator<Placement> & {
    asOptional(): EmbeddedAnnotatedValidator<VOptional<Value>, Placement>;
  };

export type EmbeddedFieldPlacement = "replicated" | "remote" | "local";

export type EmbeddedCrdtMeta =
  | { kind: "text" }
  | { kind: "count" }
  | { kind: "set"; member: ValidatorJSON };

export type EmbeddedCrdtKind = EmbeddedCrdtMeta["kind"];

export type EmbeddedFieldMeta =
  | { placement: "replicated"; crdt: EmbeddedCrdtMeta }
  | { placement: "remote" }
  | { placement: "local" };

type EmbeddedFieldValidator = GenericValidator & {
  readonly [EMBEDDED_FIELD]?: EmbeddedFieldMeta;
};

export function withEmbeddedFieldMeta<T extends GenericValidator>(
  validator: T,
  meta: EmbeddedFieldMeta,
): T {
  if (embeddedFieldMeta(validator) !== null) {
    throw new Error("embedded field annotations cannot be combined");
  }
  Object.defineProperty(validator, EMBEDDED_FIELD, {
    configurable: false,
    enumerable: false,
    value: Object.freeze(meta),
    writable: false,
  });
  const optional = (validator as unknown as { asOptional(): GenericValidator }).asOptional.bind(
    validator,
  );
  Object.defineProperty(validator, "asOptional", {
    configurable: false,
    enumerable: false,
    value: () => withEmbeddedFieldMeta(optional(), meta),
    writable: false,
  });
  return validator;
}

export function embeddedFieldMeta(value: unknown): EmbeddedFieldMeta | null {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { isConvexValidator?: unknown }).isConvexValidator !== true
  ) {
    return null;
  }
  return (value as EmbeddedFieldValidator)[EMBEDDED_FIELD] ?? null;
}
