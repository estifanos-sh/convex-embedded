import type { WorkerCommand, WorkerRequest } from "./protocol";

export function remoteConfigKey(
  remote: NonNullable<Extract<WorkerRequest, { op: typeof WorkerCommand.Init }>["remote"]>,
): string {
  return JSON.stringify({
    authFetchToken: remote.authFetchToken,
    moduleGraphHash: remote.moduleGraphHash,
    operationTimeoutMs: remote.operationTimeoutMs ?? null,
    protocolVersion: remote.protocolVersion,
    receiveTimeoutMs: remote.receiveTimeoutMs ?? null,
    schemaHash: remote.schemaHash,
    url: remote.url,
  });
}
