import { describe, expect, test } from "vite-plus/test";

import {
  mutationIdentityMatches,
  mutationReplayMatches,
  mutationReplaySettlement,
} from "../../src/component/compatibility";
import { namespaceBatch } from "../../src/runtime/components";
import type { ScheduledJob, WriteBatch } from "../../src/storage/types";

const schedule: ScheduledJob = {
  jobId: "job_1",
  kind: "mutation",
  name: "documents:notify",
  args: "{}",
  dueTime: 100,
  createdTime: 50,
  updatedTime: 50,
  state: "pending",
};

const batch: WriteBatch = {
  docWrites: [{ table: "documents", id: "documents:1", data: {}, cols: {}, creationTime: 1 }],
  deletes: [],
  schedules: [schedule],
};

describe("namespaceBatch", () => {
  test("carries schedules through a namespaced instance while mapping row tables", () => {
    const namespaced = namespaceBatch("embedded", batch);
    expect(namespaced.docWrites[0]!.table).toBe("__e_documents");
    expect(namespaced.schedules).toEqual([schedule]);
  });

  test("returns the batch unchanged for the root instance", () => {
    expect(namespaceBatch("", batch).schedules).toEqual([schedule]);
  });
});

describe("mutationIdentityMatches", () => {
  const current = {
    fingerprint: "prepared-v2",
    logicalFingerprint: "logical",
    mutationId: "mutation",
    replayId: "replay:replacement",
  };

  test("uses the durable logical fingerprint for modern settlements", () => {
    expect(
      mutationIdentityMatches(
        {
          fingerprint: "prepared-v1",
          logicalFingerprint: "logical",
          replayId: "replay:original",
          outcome: "rejected",
        },
        current,
      ),
    ).toBe(true);
    expect(
      mutationIdentityMatches(
        {
          fingerprint: current.fingerprint,
          logicalFingerprint: "different",
          replayId: "replay:original",
          outcome: "rejected",
        },
        current,
      ),
    ).toBe(false);
  });

  test("accepts an exact legacy fingerprint without replay metadata", () => {
    expect(
      mutationIdentityMatches({ fingerprint: current.fingerprint, outcome: "rejected" }, current),
    ).toBe(true);
  });

  test("upgrades only a rotated non-applied legacy settlement", () => {
    expect(
      mutationIdentityMatches({ fingerprint: "prepared-v1", outcome: "rejected" }, current),
    ).toBe(true);
    expect(
      mutationIdentityMatches({ fingerprint: "prepared-v1", outcome: "applied" }, current),
    ).toBe(false);
    expect(
      mutationIdentityMatches(
        { fingerprint: "prepared-v1", outcome: "rejected" },
        { ...current, replayId: current.mutationId },
      ),
    ).toBe(false);
    expect(
      mutationIdentityMatches(
        { fingerprint: "prepared-v1", replayId: "replay:old", outcome: "rejected" },
        current,
      ),
    ).toBe(false);
  });
});

describe("mutationReplayMatches", () => {
  const current = {
    fingerprint: "prepared-v2",
    logicalFingerprint: "logical",
    mutationId: "mutation",
    replayId: "mutation",
  };

  test("accepts a re-prepared applied mutation with the same durable identity", () => {
    expect(
      mutationReplayMatches(
        {
          fingerprint: "prepared-v1",
          logicalFingerprint: current.logicalFingerprint,
          replayId: current.replayId,
          outcome: "applied",
        },
        current,
      ),
    ).toBe(true);
  });

  test("still rejects a different logical mutation and non-applied re-preparation", () => {
    expect(
      mutationReplayMatches(
        {
          fingerprint: "prepared-v1",
          logicalFingerprint: "different",
          replayId: current.replayId,
          outcome: "applied",
        },
        current,
      ),
    ).toBe(false);
    expect(
      mutationReplayMatches(
        {
          fingerprint: "prepared-v1",
          logicalFingerprint: current.logicalFingerprint,
          replayId: current.replayId,
          outcome: "conflict",
        },
        current,
      ),
    ).toBe(false);
  });

  test("requires the exact hosted fingerprint for legacy settlements", () => {
    expect(
      mutationReplayMatches({ fingerprint: current.fingerprint, outcome: "applied" }, current),
    ).toBe(true);
    expect(mutationReplayMatches({ fingerprint: "prepared-v1", outcome: "applied" }, current)).toBe(
      false,
    );
  });
});

describe("mutationReplaySettlement", () => {
  const current = [
    {
      table: "documents",
      rowId: "documents|local",
      field: "body",
      kind: "text" as const,
      baseSeq: 0,
      projectionHash: "projection",
    },
  ];
  const settlement = {
    mutationId: "mutation",
    outcome: "applied" as const,
    crdt: [
      {
        table: "documents",
        rowId: "j57hosted",
        field: "body",
        kind: "text" as const,
        headSeq: 1,
        projectionHash: "projection",
      },
    ],
  };

  test("rebinds a cached applied acknowledgement to the current prepared row", () => {
    expect(mutationReplaySettlement(settlement, current).crdt[0]?.rowId).toBe("documents|local");
  });

  test("rebinds an acknowledgement whose accepted head was already pulled", () => {
    expect(
      mutationReplaySettlement(settlement, [{ ...current[0]!, baseSeq: 1 }]).crdt[0]?.rowId,
    ).toBe("documents|local");
  });

  test("does not rewrite an acknowledgement with a different CRDT identity", () => {
    expect(
      mutationReplaySettlement(
        { ...settlement, crdt: [{ ...settlement.crdt[0]!, projectionHash: "different" }] },
        current,
      ),
    ).toEqual({
      ...settlement,
      crdt: [{ ...settlement.crdt[0]!, projectionHash: "different" }],
    });
  });

  test("does not rewrite non-applied settlements", () => {
    expect(mutationReplaySettlement({ ...settlement, outcome: "conflict" }, current)).toEqual({
      ...settlement,
      outcome: "conflict",
    });
  });
});
