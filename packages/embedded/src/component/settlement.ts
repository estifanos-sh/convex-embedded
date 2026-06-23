interface MutationPosition {
  _creationTime: number;
  clientId: string;
}

interface ClientFence {
  acknowledgedThrough?: number;
  retired: boolean;
}

export function isAcknowledged(
  mutation: MutationPosition,
  client: ClientFence | null | undefined,
): boolean {
  return (
    mutation.clientId === "hosted" ||
    client?.retired === true ||
    (client?.acknowledgedThrough !== undefined &&
      mutation._creationTime <= client.acknowledgedThrough)
  );
}
