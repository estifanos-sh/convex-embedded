import { compareValues, convexToJson, jsonToConvex } from "convex/values";
import type { JSONValue, Value } from "convex/values";

export function encode(value: unknown): string {
  return JSON.stringify(convexToJson(normalize(value) as Value));
}

export function decode(value: string): unknown {
  return fromJson(JSON.parse(value) as JSONValue);
}

export function fromJson(value: JSONValue): unknown {
  return jsonToConvex(value);
}

export function clone(value: unknown): unknown {
  return decode(encode(value));
}

export function normalize(value: unknown): unknown {
  return normalizeInner(value, true);
}

function normalizeInner(value: unknown, topLevel: boolean): unknown {
  if (value === undefined) return topLevel ? null : undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) throw new Error(`undefined array element at index ${index}`);
      return normalizeInner(entry, false);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = normalizeInner(v, false);
  }
  return out;
}

export function normalizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalize(value);
  if (!isRecord(normalized)) throw new Error("expected a Convex object");
  return normalized;
}

export function equals(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0;
}

export function compare(a: unknown, b: unknown): number {
  return compareValues(a as Value | undefined, b as Value | undefined);
}

export function assertValue(value: unknown, path: string): void {
  try {
    convexToJson(normalize(value) as Value);
  } catch (error) {
    throw new Error(`${path} is not a valid Convex value: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
