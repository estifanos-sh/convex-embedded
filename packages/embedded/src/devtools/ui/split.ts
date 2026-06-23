/// <reference lib="dom" />

import { el } from "./dom";

export interface SplitHandleOptions {
  container: HTMLElement;
  cursor?: string;
  label: string;
  max: number;
  min: number;
  invert?: boolean;
  onChange(value: number): void;
  read(): number;
  reset(): void;
}

export function splitHandle(options: SplitHandleOptions): HTMLElement {
  const handle = el("button", {
    className: "ce-split-handle",
    on: {
      dblclick: () => options.reset(),
      pointerdown: (event) => handleSplitPointerDown(event as PointerEvent, options),
    },
  });
  handle.type = "button";
  handle.ariaLabel = options.label;
  handle.title = `${options.label}. Drag to resize. Double-click to reset.`;
  return handle;
}

export function readSize(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function writeSize(key: string, value: number): void {
  localStorage.setItem(key, String(Math.round(value)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function handleSplitPointerDown(event: PointerEvent, options: SplitHandleOptions): void {
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const start = options.read();
  document.body.classList.add("ce-resizing");
  document.body.style.cursor = options.cursor ?? "col-resize";

  const move = (next: PointerEvent) => {
    const delta = next.clientX - startX;
    const value = clamp(start + (options.invert ? -delta : delta), options.min, options.max);
    options.onChange(value);
  };
  const stop = (next: PointerEvent) => {
    target.releasePointerCapture(next.pointerId);
    document.body.classList.remove("ce-resizing");
    document.body.style.cursor = "";
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
  };

  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}
