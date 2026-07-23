import { useEffect, useState } from "react";

export type OpenTiming = {
  id: string;
  tapToMaterializedMs: number | null;
  materializedToReadyMs: number | null;
  totalMs: number;
  warm: boolean;
};

export type PerfSnapshot = {
  jsStartToRenderMs: number | null;
  jsStartToListMs: number | null;
  lastOpen: OpenTiming | null;
  opens: OpenTiming[];
};

const jsStartMs = performance.now();
let jsStartToRenderMs: number | null = null;
let jsStartToListMs: number | null = null;
let openStartMs = 0;
let openId = "";
let openMaterializedMs: number | null = null;
let openReadyIds = new Set<string>();
let snapshot: PerfSnapshot = {
  jsStartToRenderMs: null,
  jsStartToListMs: null,
  lastOpen: null,
  opens: [],
};
const listeners = new Set<() => void>();

function publish(next: PerfSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Record when the root screen first commits a render after JS start. */
export function markFirstRender(): void {
  if (jsStartToRenderMs !== null) return;
  jsStartToRenderMs = Math.round(performance.now() - jsStartMs);
  publish({ ...snapshot, jsStartToRenderMs });
}

/** Record the first moment the document list becomes interactive after JS start. */
export function markListReady(): void {
  if (jsStartToListMs !== null) return;
  jsStartToListMs = Math.round(performance.now() - jsStartMs);
  publish({ ...snapshot, jsStartToListMs });
}

/** Begin timing a fresh document open triggered by a tap. */
export function markOpenTap(id: string): void {
  openStartMs = performance.now();
  openId = id;
  openMaterializedMs = null;
}

/** Record when the tapped document's data is materialized in local storage. */
export function markMaterialized(id: string): void {
  if (id !== openId) return;
  openMaterializedMs = Math.round(performance.now() - openStartMs);
}

/** Record when the editor for the tapped document becomes interactive. */
export function markOpenReady(id: string): void {
  if (id !== openId) return;
  const totalMs = Math.round(performance.now() - openStartMs);
  const timing: OpenTiming = {
    id,
    tapToMaterializedMs: openMaterializedMs,
    materializedToReadyMs: openMaterializedMs === null ? null : totalMs - openMaterializedMs,
    totalMs,
    warm: openReadyIds.size > 0,
  };
  openReadyIds.add(id);
  publish({ ...snapshot, lastOpen: timing, opens: [timing, ...snapshot.opens].slice(0, 6) });
}

export function usePerfSnapshot(): PerfSnapshot {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}
