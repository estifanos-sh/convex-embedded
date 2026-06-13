import type { GenericValidator, PropertyValidators, ValidatorJSON } from "convex/values";
import { assertValueWalk, equals, fromJson, isNormalized, isSimpleObject } from "./codec";
import { tableFromId } from "./values";

/**
 * Validators are implemented as check functions returning the first error message (or
 * `undefined` on success), so union dispatch is a plain loop instead of thrown-Error control
 * flow. The public functions throw on a returned message.
 */

/**
 * Validates an object against Convex property validators.
 *
 * @internal
 */
export function validateFields(
  value: Record<string, unknown>,
  fields: PropertyValidators,
  path: string,
): void {
  raise(checkFields(value, fields, path));
}

/**
 * Validates a value against a runtime Convex validator.
 *
 * @internal
 */
export function validateValue(value: unknown, validator: GenericValidator, path: string): void {
  raise(checkValue(value, validator, path));
}

/**
 * Validates a value against Convex's exported JSON validator shape.
 *
 * @internal
 */
export function validateJson(value: unknown, validator: ValidatorJSON, path: string): void {
  raise(checkJson(value, validator, path));
}

function raise(message: string | undefined): void {
  if (message !== undefined) throw new Error(message);
}

function checkFields(
  value: Record<string, unknown>,
  fields: PropertyValidators,
  path: string,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) return `${path}.${key} is not a declared field`;
  }
  for (const [key, validator] of Object.entries(fields)) {
    const error = checkValue(value[key], validator as GenericValidator, `${path}.${key}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function checkValue(value: unknown, validator: GenericValidator, path: string): string | undefined {
  if (isOptional(validator) && value === undefined) return undefined;
  if (value === undefined) return `${path} is required`;
  return checkValueByKind[validator.kind](value, validator as never, path);
}

type RuntimeValidatorHandlers = {
  [K in GenericValidator["kind"]]: (
    value: unknown,
    validator: Extract<GenericValidator, { kind: K }>,
    path: string,
  ) => string | undefined;
};

const checkValueByKind = {
  any(value, _validator, path) {
    return checkAnyValue(value, path);
  },
  id(value, validator, path) {
    if (typeof value !== "string") return `${path} must be an id`;
    if (validator.tableName && tableFromId(value) !== validator.tableName) {
      return `${path} must be an id for table ${validator.tableName}`;
    }
    return undefined;
  },
  string(value, _validator, path) {
    return typeof value === "string" ? undefined : `${path} must be a string`;
  },
  float64(value, _validator, path) {
    return typeof value === "number" ? undefined : `${path} must be a number`;
  },
  int64(value, _validator, path) {
    return typeof value === "bigint" ? undefined : `${path} must be an int64`;
  },
  boolean(value, _validator, path) {
    return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
  },
  bytes(value, _validator, path) {
    return value instanceof ArrayBuffer ? undefined : `${path} must be bytes`;
  },
  null(value, _validator, path) {
    return value === null ? undefined : `${path} must be null`;
  },
  literal(value, validator, path) {
    return equals(value, validator.value) ? undefined : `${path} must be the literal value`;
  },
  array(value, validator, path) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (const [i, entry] of value.entries()) {
      const error = checkValue(entry, validator.element, `${path}[${i}]`);
      if (error !== undefined) return error;
    }
    return undefined;
  },
  object(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    return checkFields(value as Record<string, unknown>, validator.fields, path);
  },
  record(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const keyError = checkValue(key, validator.key, `${path}.${key} key`);
      if (keyError !== undefined) return keyError;
      const error = checkValue(entry, validator.value, `${path}.${key}`);
      if (error !== undefined) return error;
    }
    return undefined;
  },
  union(value, validator, path) {
    for (const member of validator.members) {
      if (checkValue(value, member, path) === undefined) return undefined;
    }
    return `${path} does not match any union member`;
  },
} satisfies RuntimeValidatorHandlers;

function checkJson(value: unknown, validator: ValidatorJSON, path: string): string | undefined {
  return checkJsonByType[validator.type](value, validator as never, path);
}

type JsonValidatorHandlers = {
  [K in ValidatorJSON["type"]]: (
    value: unknown,
    validator: Extract<ValidatorJSON, { type: K }>,
    path: string,
  ) => string | undefined;
};

const checkJsonByType = {
  any(value, _validator, path) {
    return checkAnyValue(value, path);
  },
  id(value, validator, path) {
    if (typeof value !== "string") return `${path} must be an id`;
    if (tableFromId(value) !== validator.tableName) {
      return `${path} must be an id for table ${validator.tableName}`;
    }
    return undefined;
  },
  string(value, _validator, path) {
    return typeof value === "string" ? undefined : `${path} must be a string`;
  },
  number(value, _validator, path) {
    return typeof value === "number" ? undefined : `${path} must be a number`;
  },
  bigint(value, _validator, path) {
    return typeof value === "bigint" ? undefined : `${path} must be an int64`;
  },
  boolean(value, _validator, path) {
    return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
  },
  bytes(value, _validator, path) {
    return value instanceof ArrayBuffer ? undefined : `${path} must be bytes`;
  },
  null(value, _validator, path) {
    return value === null ? undefined : `${path} must be null`;
  },
  literal(value, validator, path) {
    return equals(value, fromJson(validator.value))
      ? undefined
      : `${path} must be the literal value`;
  },
  array(value, validator, path) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (const [i, entry] of value.entries()) {
      const error = checkJson(entry, validator.value, `${path}[${i}]`);
      if (error !== undefined) return error;
    }
    return undefined;
  },
  object(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    return checkJsonFields(value as Record<string, unknown>, validator.value, path);
  },
  record(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const keyError = checkJson(key, validator.keys, `${path}.${key} key`);
      if (keyError !== undefined) return keyError;
      const error = checkJson(entry, validator.values.fieldType, `${path}.${key}`);
      if (error !== undefined) return error;
    }
    return undefined;
  },
  union(value, validator, path) {
    for (const member of validator.value) {
      if (checkJson(value, member, path) === undefined) return undefined;
    }
    return `${path} does not match any union member`;
  },
} satisfies JsonValidatorHandlers;

function checkJsonFields(
  value: Record<string, unknown>,
  fields: Extract<ValidatorJSON, { type: "object" }>["value"],
  path: string,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) return `${path}.${key} is not a declared field`;
  }
  for (const [key, field] of Object.entries(fields)) {
    if (value[key] === undefined && field.optional) continue;
    const error = checkJson(value[key], field.fieldType, `${path}.${key}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

/** `v.any()` only requires a representable Convex value; branded values short-circuit. */
function checkAnyValue(value: unknown, path: string): string | undefined {
  if (isNormalized(value)) return undefined;
  try {
    assertValueWalk(value, path);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function checkRecordObject(value: unknown, path: string): string | undefined {
  return isSimpleObject(value) ? undefined : `${path} must be an object`;
}

function isOptional(validator: GenericValidator): boolean {
  return (
    "isOptional" in validator &&
    typeof validator.isOptional === "string" &&
    validator.isOptional === "optional"
  );
}
