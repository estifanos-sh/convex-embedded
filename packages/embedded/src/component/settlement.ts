import type { CommitTsPlaceholder } from "convex/values";

interface MutationPosition {
  acknowledgedAt?: bigint | CommitTsPlaceholder;
  clientId: string;
}

interface ClientFence {
  retired: boolean;
}

export function isAcknowledged(
  mutation: MutationPosition,
  client: ClientFence | null | undefined,
): boolean {
  return (
    mutation.clientId === "hosted" ||
    client?.retired === true ||
    mutation.acknowledgedAt !== undefined
  );
}
