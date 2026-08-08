import type { GenericValidator, PropertyValidators, ValidatorJSON } from "convex/values";
import { assertValueWalk, equals, fromJson, isNormalized, isSimpleObject } from "./codec";
import { isPendingCommitTs } from "./pending";
import { tableFromId } from "./doc";

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
  return checkObjectFields(value, fields, path, (entry, validator, fieldPath) =>
    checkValue(entry, validator as GenericValidator, fieldPath),
  );
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
    return checkId(value, validator.tableName, path, Boolean(validator.tableName));
  },
  string(value, _validator, path) {
    return checkType(value, "string", "string", path);
  },
  float64(value, _validator, path) {
    return checkType(value, "number", "number", path);
  },
  int64(value, _validator, path) {
    return checkType(value, "bigint", "int64", path);
  },
  commitTs(value, _validator, path) {
    return checkCommitTs(value, path);
  },
  boolean(value, _validator, path) {
    return checkType(value, "boolean", "boolean", path);
  },
  bytes(value, _validator, path) {
    return checkBytes(value, path);
  },
  null(value, _validator, path) {
    return checkNull(value, path);
  },
  literal(value, validator, path) {
    return checkLiteral(value, validator.value, path);
  },
  array(value, validator, path) {
    return checkArray(value, validator.element, path, checkValue);
  },
  object(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    return checkFields(value as Record<string, unknown>, validator.fields, path);
  },
  record(value, validator, path) {
    return checkRecord(value, validator.key, validator.value, path, checkValue);
  },
  union(value, validator, path) {
    return checkUnion(value, validator.members, path, checkValue);
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
    return checkId(value, validator.tableName, path, true);
  },
  string(value, _validator, path) {
    return checkType(value, "string", "string", path);
  },
  number(value, _validator, path) {
    return checkType(value, "number", "number", path);
  },
  bigint(value, _validator, path) {
    return checkType(value, "bigint", "int64", path);
  },
  commitTs(value, _validator, path) {
    return checkCommitTs(value, path);
  },
  boolean(value, _validator, path) {
    return checkType(value, "boolean", "boolean", path);
  },
  bytes(value, _validator, path) {
    return checkBytes(value, path);
  },
  null(value, _validator, path) {
    return checkNull(value, path);
  },
  literal(value, validator, path) {
    return checkLiteral(value, fromJson(validator.value), path);
  },
  array(value, validator, path) {
    return checkArray(value, validator.value, path, checkJson);
  },
  object(value, validator, path) {
    const shape = checkRecordObject(value, path);
    if (shape !== undefined) return shape;
    return checkJsonFields(value as Record<string, unknown>, validator.value, path);
  },
  record(value, validator, path) {
    return checkRecord(value, validator.keys, validator.values.fieldType, path, checkJson);
  },
  union(value, validator, path) {
    return checkUnion(value, validator.value, path, checkJson);
  },
} satisfies JsonValidatorHandlers;

function formatIdTableError(path: string, tableName: string, value: string): string {
  return `${path} must be an id for table ${tableName}; received ${JSON.stringify(value)}. If this came from stale local browser data, clear local data for this origin, including OPFS/storage buckets. Clearing only localStorage does not reset the embedded database.`;
}

function checkJsonFields(
  value: Record<string, unknown>,
  fields: Extract<ValidatorJSON, { type: "object" }>["value"],
  path: string,
): string | undefined {
  return checkObjectFields(value, fields, path, (entry, field, fieldPath) => {
    if (entry === undefined && field.optional) return undefined;
    return checkJson(entry, field.fieldType, fieldPath);
  });
}

type Check<Validator> = (value: unknown, validator: Validator, path: string) => string | undefined;

function checkObjectFields<Field>(
  value: Record<string, unknown>,
  fields: Record<string, Field>,
  path: string,
  check: (value: unknown, field: Field, path: string) => string | undefined,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) return `${path}.${key} is not a declared field`;
  }
  for (const [key, field] of Object.entries(fields)) {
    const error = check(value[key], field, `${path}.${key}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function checkArray<Validator>(
  value: unknown,
  validator: Validator,
  path: string,
  check: Check<Validator>,
): string | undefined {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (const [index, entry] of value.entries()) {
    const error = check(entry, validator, `${path}[${index}]`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function checkRecord<KeyValidator, ValueValidator>(
  value: unknown,
  keyValidator: KeyValidator,
  valueValidator: ValueValidator,
  path: string,
  check: Check<KeyValidator | ValueValidator>,
): string | undefined {
  const shape = checkRecordObject(value, path);
  if (shape !== undefined) return shape;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nameError = recordKeyError(key, path);
    if (nameError !== undefined) return nameError;
    const keyError = check(key, keyValidator, `${path}.${key} key`);
    if (keyError !== undefined) return keyError;
    const valueError = check(entry, valueValidator, `${path}.${key}`);
    if (valueError !== undefined) return valueError;
  }
  return undefined;
}

function checkUnion<Validator>(
  value: unknown,
  validators: readonly Validator[],
  path: string,
  check: Check<Validator>,
): string | undefined {
  for (const validator of validators) {
    if (check(value, validator, path) === undefined) return undefined;
  }
  return `${path} does not match any union member`;
}

function checkId(
  value: unknown,
  tableName: string,
  path: string,
  checkTable: boolean,
): string | undefined {
  if (typeof value !== "string") return `${path} must be an id`;
  if (checkTable && tableFromId(value) !== tableName) {
    return formatIdTableError(path, tableName, value);
  }
  return undefined;
}

function checkType(
  value: unknown,
  type: "string" | "number" | "bigint" | "boolean",
  name: string,
  path: string,
): string | undefined {
  return typeof value === type ? undefined : `${path} must be a ${name}`;
}

function checkCommitTs(value: unknown, path: string): string | undefined {
  return typeof value === "bigint" || isPendingCommitTs(value)
    ? undefined
    : `${path} must be a commit timestamp`;
}

function checkBytes(value: unknown, path: string): string | undefined {
  return value instanceof ArrayBuffer ? undefined : `${path} must be bytes`;
}

function checkNull(value: unknown, path: string): string | undefined {
  return value === null ? undefined : `${path} must be null`;
}

function checkLiteral(value: unknown, literal: unknown, path: string): string | undefined {
  return equals(value, literal) ? undefined : `${path} must be the literal value`;
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

function recordKeyError(key: string, path: string): string | undefined {
  if (key.length === 0) return `${path}: record keys must be nonempty`;
  if (key.startsWith("$")) return `${path}: record key "${key}" starts with a reserved '$'`;
  if (key.startsWith("_")) return `${path}: record key "${key}" starts with a reserved '_'`;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 32 || code >= 127) {
      return `${path}: record key "${key}" must contain only non-control ASCII characters`;
    }
  }
  return undefined;
}

function isOptional(validator: GenericValidator): boolean {
  return (
    "isOptional" in validator &&
    typeof validator.isOptional === "string" &&
    validator.isOptional === "optional"
  );
}
