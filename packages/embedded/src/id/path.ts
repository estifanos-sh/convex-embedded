export type ValidatorIdReference = { path: string; table: string };
export type ValidatorIdValue = ValidatorIdReference & { id: string };

export function validatorIdReferences(validator: unknown, value: unknown): ValidatorIdReference[] {
  const references = new Map<string, ValidatorIdReference>();
  collect(validator, value, "", references);
  return [...references.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function validatorIdValues(validator: unknown, value: unknown): ValidatorIdValue[] {
  return validatorIdReferences(validator, value).flatMap((reference) => {
    const id = pointerRead(value, reference.path);
    return id === undefined ? [] : [{ ...reference, id }];
  });
}

function collect(
  validator: unknown,
  value: unknown,
  path: string,
  references: Map<string, ValidatorIdReference>,
): void {
  const record = validator as {
    kind?: string;
    type?: string;
    fields?: Record<string, unknown>;
    element?: unknown;
    members?: unknown[];
    value?: unknown;
    tableName?: string;
  };
  const kind = record?.kind ?? record?.type;
  if (kind === "id" && typeof value === "string") {
    references.set(path, { path, table: record.tableName ?? "unknown" });
    return;
  }
  if (kind === "object" && isObject(value)) {
    const fields = record.fields ?? jsonFields(record.value);
    for (const [field, child] of Object.entries(fields)) {
      collect(child, value[field], `${path}/${pointerPart(field)}`, references);
    }
    return;
  }
  if (kind === "array" && Array.isArray(value)) {
    const element = record.element ?? record.value;
    value.forEach((child, index) => collect(element, child, `${path}/${index}`, references));
    return;
  }
  if (kind === "union") {
    const members = record.members ?? (Array.isArray(record.value) ? record.value : []);
    for (const member of members) collect(member, value, path, references);
    return;
  }
  if (kind === undefined && isObject(validator) && isObject(value)) {
    for (const [field, child] of Object.entries(validator)) {
      collect(child, value[field], `${path}/${pointerPart(field)}`, references);
    }
  }
}

function jsonFields(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([field, descriptor]) => [
      field,
      isObject(descriptor) && "fieldType" in descriptor ? descriptor.fieldType : descriptor,
    ]),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pointerPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerRead(value: unknown, path: string): string | undefined {
  if (path === "") return typeof value === "string" ? value : undefined;
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}
