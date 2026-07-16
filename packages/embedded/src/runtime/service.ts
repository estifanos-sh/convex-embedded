import { getFunctionName } from "convex/server";
import type { RuntimeStorageWriter, ScheduledFunctionKind, StorageBackend } from "../storage/types";
import type { FunctionReference } from "./functions";

export interface RuntimeCalls {
  kind(ref: FunctionReference): Promise<ScheduledFunctionKind>;
  runAction?(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  runMutation(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
  runQuery(ref: FunctionReference, args?: Record<string, unknown>): Promise<unknown>;
}

export type ServiceStore = RuntimeStorageWriter &
  Partial<
    Pick<
      StorageBackend,
      | "blob"
      | "clear"
      | "dirtyHeadsDebugRead"
      | "file"
      | "id"
      | "remoteDocDebugRead"
      | "schedule"
      | "upload"
    >
  >;

export function fullStore(store: RuntimeStorageWriter): ServiceStore {
  return store as ServiceStore;
}

export function functionName(ref: FunctionReference): string {
  return typeof ref === "string" ? ref : getFunctionName(ref);
}
