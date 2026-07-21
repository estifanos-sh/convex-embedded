import type { EmbeddedCrdtKind } from "../meta";

export function fieldValue(document: unknown, field: string): unknown {
  let cursor: unknown = document;
  for (const segment of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** A UTF-16 offset splits a surrogate pair when it lands between a high and its low unit. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (isHighSurrogate(unit)) {
      if (!isLowSurrogate(text.charCodeAt(i + 1))) return true;
      i += 1;
    } else if (isLowSurrogate(unit)) {
      return true;
    }
  }
  return false;
}

export function assertIntentField(
  table: string,
  field: string,
  kind: EmbeddedCrdtKind,
  declared: EmbeddedCrdtKind | undefined,
): void {
  if (declared === undefined) throw new Error(`${table}.${field} is not an embedded ${kind} field`);
  if (declared !== kind) throw new Error(`${table}.${field} is embedded ${declared}, not ${kind}`);
}

export function assertFiniteDelta(table: string, field: string, delta: number): void {
  if (!Number.isFinite(delta)) {
    throw new Error(`count.add: ${table}.${field} delta must be a finite number`);
  }
}

export type CountAddDecision = { consume: false } | { consume: true; next: number };

export function validateCountAdd(
  table: string,
  id: string,
  field: string,
  document: Record<string, unknown> | null,
  delta: number,
): CountAddDecision {
  assertFiniteDelta(table, field, delta);
  if (!document) throw new Error(`count.add: document not found: ${id}`);
  const currentValue = fieldValue(document, field);
  if (currentValue !== undefined && typeof currentValue !== "number") {
    throw new Error(`count.add: ${table}.${field} is not a number`);
  }
  if (delta === 0) return { consume: false };
  const next = (currentValue ?? 0) + delta;
  if (!Number.isFinite(next)) {
    throw new Error(`count.add: ${table}.${field} result must be a finite number`);
  }
  return { consume: true, next };
}

export function validateSetField(
  operation: "set.add" | "set.delete",
  table: string,
  id: string,
  field: string,
  document: Record<string, unknown> | null,
): unknown[] {
  if (!document) throw new Error(`${operation}: document not found: ${id}`);
  const currentValue = fieldValue(document, field);
  if (currentValue !== undefined && !Array.isArray(currentValue)) {
    throw new Error(`${operation}: ${table}.${field} is not an array`);
  }
  return (currentValue as unknown[] | undefined) ?? [];
}

export function validateTextSplice(
  table: string,
  id: string,
  field: string,
  document: Record<string, unknown> | null,
  change: { delete: number; index: number; insert: string },
): string {
  if (!document) throw new Error(`text.splice: document not found: ${id}`);
  const currentValue = fieldValue(document, field);
  if (currentValue !== undefined && typeof currentValue !== "string") {
    throw new Error(`text.splice: ${table}.${field} is not a string`);
  }
  const source = (currentValue as string | undefined) ?? "";
  const end = change.index + change.delete;
  if (
    change.index < 0 ||
    change.delete < 0 ||
    change.index > source.length ||
    end > source.length
  ) {
    throw new Error("text.splice: change range is outside the current value");
  }
  if (splitsSurrogatePair(source, change.index) || splitsSurrogatePair(source, end)) {
    throw new Error("text.splice: change range must start and end on a Unicode scalar boundary");
  }
  if (hasUnpairedSurrogate(change.insert)) {
    throw new Error("text.splice: insert is not valid Unicode (contains an unpaired surrogate)");
  }
  return source;
}
