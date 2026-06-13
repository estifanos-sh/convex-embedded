import type { WorkerState } from "../runtime";
import type { WorkerResponse } from "../protocol";
import type { BroadcastChannelLike, InitRequest, LockManagerLike, Timer } from "./protocol";
import type { CoordinatorTimeouts } from "./state";

export interface CoordinatorEnv {
  assertCapabilities(): Promise<void> | void;
  channels: {
    open(name: string): BroadcastChannelLike;
  };
  clearTimer(timer: Timer): void;
  closeSelf(): void;
  locks: LockManagerLike;
  openRuntime(request: InitRequest, post: (response: WorkerResponse) => void): Promise<WorkerState>;
  postLocal(response: WorkerResponse): void;
  randomId(prefix: string): string;
  setTimer(callback: () => void, ms: number): Timer;
  timeouts: CoordinatorTimeouts;
}

export type WorkerGlobalLike = {
  close?: () => void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  postMessage?: (message: unknown) => void;
};

export async function assertRuntimeCapabilities(): Promise<void> {
  assertDedicatedWorkerGlobal();
  if (typeof globalValue("Worker") !== "function") {
    throw new Error("ConvexEmbeddedClient browser runtime requires Dedicated Worker support.");
  }
  if (typeof globalValue("BroadcastChannel") !== "function") {
    throw new Error("ConvexEmbeddedClient browser runtime requires BroadcastChannel support.");
  }
  requiredLockManager();
  if (
    globalValue("crossOriginIsolated") !== true ||
    typeof globalValue("SharedArrayBuffer") !== "function"
  ) {
    throw new Error(
      "ConvexEmbeddedClient browser storage requires cross-origin isolation and SharedArrayBuffer support.",
    );
  }
  const navigatorLike = navigatorLikeGlobal();
  if (typeof navigatorLike.storage?.getDirectory !== "function") {
    throw new Error(
      "ConvexEmbeddedClient browser storage requires navigator.storage.getDirectory support.",
    );
  }
}

export function workerGlobal(): WorkerGlobalLike {
  return ((globalThis as { self?: WorkerGlobalLike }).self ?? globalThis) as WorkerGlobalLike;
}

export function requiredLockManager(): LockManagerLike {
  const locks = navigatorLikeGlobal().locks;
  if (!locks || typeof locks.request !== "function") {
    throw new Error("ConvexEmbeddedClient browser runtime requires Web Locks support.");
  }
  return locks;
}

function assertDedicatedWorkerGlobal(): void {
  const ctor = globalValue("DedicatedWorkerGlobalScope");
  if (typeof ctor !== "function" || !(workerGlobal() instanceof ctor)) {
    throw new Error("ConvexEmbeddedClient browser runtime requires Dedicated Worker support.");
  }
}

function navigatorLikeGlobal(): {
  locks?: LockManagerLike;
  storage?: { getDirectory?: () => Promise<unknown> };
} {
  return (
    (
      globalThis as {
        navigator?: {
          locks?: LockManagerLike;
          storage?: { getDirectory?: () => Promise<unknown> };
        };
      }
    ).navigator ?? {}
  );
}

function globalValue(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name];
}
