/// <reference lib="dom" />

import type { EmbeddedDevtoolsOperation } from "../core/types";
import { badge, button } from "./dom";

export function statusBadge(status: EmbeddedDevtoolsOperation["status"]): HTMLElement {
  if (status === "success") return badge("success", "success");
  if (status === "error") return badge("error", "error");
  return badge("pending", "pending");
}

export function valuePreview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function rowId(row: Record<string, unknown>): string {
  const id = row._id ?? row.id ?? row.localStorageId ?? row.localId ?? row.jobId;
  return typeof id === "string" ? id : "";
}

export function copyButton(label: string, value: string): HTMLButtonElement {
  return button(label, () => void navigator.clipboard?.writeText(value));
}
