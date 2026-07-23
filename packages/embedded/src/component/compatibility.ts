export type PriorMutationIdentity = {
  fingerprint: string;
  logicalFingerprint: string;
  replayId: string;
  outcome: "applied" | "conflict" | "rejected" | "rebase";
};

export type CurrentMutationIdentity = {
  fingerprint: string;
  logicalFingerprint: string;
  mutationId: string;
  replayId: string;
};

type ReplayCrdtIdentity = {
  table: string;
  rowId: string;
  field: string;
  kind: "text" | "count" | "set";
  baseSeq: number;
  projectionHash: string;
};

type SettledCrdtIdentity = {
  table: string;
  rowId: string;
  field: string;
  kind: "text" | "count" | "set";
  headSeq: number;
  projectionHash: string;
};

/** Whether a current attempt is the same logical mutation as an older settlement. */
export function mutationIdentityMatches(
  prior: PriorMutationIdentity,
  current: CurrentMutationIdentity,
): boolean {
  return prior.logicalFingerprint === current.logicalFingerprint;
}

/** Whether an exact replay attempt may reuse an older settlement. */
export function mutationReplayMatches(
  prior: PriorMutationIdentity,
  current: CurrentMutationIdentity,
): boolean {
  if (prior.logicalFingerprint !== current.logicalFingerprint) return false;
  return prior.fingerprint === current.fingerprint || prior.outcome === "applied";
}

/** Rebind a cached applied acknowledgement to the current prepared row identities. */
export function mutationReplaySettlement<
  Settlement extends { outcome: string; crdt: SettledCrdtIdentity[] },
>(settlement: Settlement, current: readonly ReplayCrdtIdentity[]): Settlement {
  if (
    settlement.outcome !== "applied" ||
    settlement.crdt.length !== current.length ||
    !settlement.crdt.every((acknowledgement, index) => {
      const effect = current[index];
      return (
        effect !== undefined &&
        acknowledgement.table === effect.table &&
        acknowledgement.field === effect.field &&
        acknowledgement.kind === effect.kind &&
        (acknowledgement.headSeq === effect.baseSeq + 1 ||
          acknowledgement.headSeq === effect.baseSeq) &&
        acknowledgement.projectionHash === effect.projectionHash
      );
    })
  ) {
    return settlement;
  }
  return {
    ...settlement,
    crdt: settlement.crdt.map((acknowledgement, index) => ({
      ...acknowledgement,
      rowId: current[index]!.rowId,
    })),
  };
}
