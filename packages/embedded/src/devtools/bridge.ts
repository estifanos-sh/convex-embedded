import type { EmbeddedClient } from "../client";
import type { DiagnosticEvent, DiagnosticEventListener, EmbeddedOperationKind } from "../events";
import type { RunMutationTiming, RunnerDevtoolsRequest } from "../runtime/runner";

/** Client activity retained exclusively for the optional devtools package. @internal */
export interface DevtoolsOperation {
  args: unknown;
  durationMs?: number;
  error?: string;
  id: number;
  kind: EmbeddedOperationKind;
  name: string;
  result?: unknown;
  resultSize?: number;
  startedAt: number;
  status: "pending" | "success" | "error";
  timing?: RunMutationTiming;
}

/** Watched-query activity retained exclusively for the optional devtools package. @internal */
export interface DevtoolsQuery {
  args: unknown;
  error?: string;
  hasValue: boolean;
  key: string;
  name: string;
  subscribers: number;
  value?: unknown;
}

/** Upload activity retained exclusively for the optional devtools package. @internal */
export interface DevtoolsUpload {
  contentType?: string;
  durationMs?: number;
  error?: string;
  size: number;
  startedAt: number;
  status: "pending" | "success" | "error";
  storageId?: string;
  url: string;
}

/** Snapshot consumed by the optional devtools package entrypoint. @internal */
export interface DevtoolsClientSnapshot {
  clientId: string;
  closed: boolean;
  operations: DevtoolsOperation[];
  queries: DevtoolsQuery[];
  uploads: DevtoolsUpload[];
}

/** A function invocation requested by the devtools Functions tab. @internal */
export interface DevtoolsRunFunctionInput {
  args: Record<string, unknown>;
  kind: "query" | "mutation" | "action";
  path: string;
}

interface DevtoolsControls {
  clearActivity(): void;
  runFunction(input: DevtoolsRunFunctionInput): Promise<unknown>;
  runtime(request: RunnerDevtoolsRequest): Promise<unknown>;
  snapshot(): DevtoolsClientSnapshot;
}

/** Internal bridge between one client and one or more devtools sources. */
export interface DevtoolsBridge {
  clearActivity(): void;
  emit(event: DiagnosticEvent): void;
  hasListeners(): boolean;
  runFunction(input: DevtoolsRunFunctionInput): Promise<unknown>;
  runtime(request: RunnerDevtoolsRequest): Promise<unknown>;
  snapshot(): DevtoolsClientSnapshot;
  subscribe(listener: DiagnosticEventListener): () => void;
}

// This remains module-private so an application cannot discover devtools controls from a client.
const bridges = new WeakMap<EmbeddedClient, DevtoolsBridge>();

/** Bind the private devtools bridge while the client is constructed. @internal */
export function createDevtoolsBridge(
  client: EmbeddedClient,
  controls: DevtoolsControls,
): DevtoolsBridge {
  const bridge = new ClientDevtoolsBridge(controls);
  bridges.set(client, bridge);
  return bridge;
}

/** Read a bridge only from the optional devtools package. @internal */
export function readDevtoolsBridge(client: EmbeddedClient): DevtoolsBridge {
  const bridge = bridges.get(client);
  if (!bridge) throw new Error("This client does not expose an embedded devtools bridge.");
  return bridge;
}

class ClientDevtoolsBridge implements DevtoolsBridge {
  private readonly listeners = new Set<DiagnosticEventListener>();

  constructor(private readonly controls: DevtoolsControls) {}

  clearActivity(): void {
    this.controls.clearActivity();
  }

  emit(event: DiagnosticEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  runFunction(input: DevtoolsRunFunctionInput): Promise<unknown> {
    return this.controls.runFunction(input);
  }

  runtime(request: RunnerDevtoolsRequest): Promise<unknown> {
    return this.controls.runtime(request);
  }

  snapshot(): DevtoolsClientSnapshot {
    return this.controls.snapshot();
  }

  subscribe(listener: DiagnosticEventListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }
}

function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (report) {
    report(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}
