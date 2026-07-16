import { describe, expect, test } from "vite-plus/test";

import { read as retentionRead, write as retentionWrite } from "../../src/component/crdt/retention";

type Checkpoint = Parameters<typeof retentionRead>[1];

function checkpoint(seq: number): Checkpoint {
  return {
    _id: `checkpoint:${seq}`,
    _creationTime: seq,
    fieldId: "field:1",
    epoch: 1,
    throughSeq: seq,
    projectionHash: `hash:${seq}`,
    responseToken: `token:${seq}`,
    state: "ready",
    createdAt: seq,
    updatedAt: seq,
  } as unknown as Checkpoint;
}

function context(results: Record<string, Checkpoint[][]>) {
  const patches: Array<{ id: string; value: Record<string, unknown> }> = [];
  const db = {
    patch: async (_table: string, id: string, value: Record<string, unknown>) => {
      patches.push({ id, value });
    },
    query: (_table: string) => ({
      withIndex: (index: string, _range: unknown) => {
        const rows = results[index]?.shift() ?? [];
        const page = {
          order: (_direction: string) => page,
          take: async (_limit: number) => rows,
        };
        return page;
      },
    }),
  };
  return { ctx: { db } as never, patches };
}

describe("CRDT checkpoint retention", () => {
  test("keeps checkpoint A's tail while checkpoint B is pulled", async () => {
    const a = checkpoint(1);
    const b = checkpoint(3);
    const { ctx } = context({
      by_field_epoch_state_seq: [[a]],
      by_field_epoch_state_retain_seq: [[a]],
    });

    expect(await retentionRead(ctx, b, 1_000)).toBe(1);
  });

  test("keeps A across a rapid A to B to C rotation", async () => {
    const a = checkpoint(1);
    const b = checkpoint(3);
    const c = checkpoint(5);
    const { ctx } = context({
      by_field_epoch_state_seq: [[b]],
      by_field_epoch_state_retain_seq: [[a]],
    });

    expect(await retentionRead(ctx, c, 1_000)).toBe(1);
  });

  test("allows A's retention deadline to expire when C supersedes B", async () => {
    const a = checkpoint(1);
    const b = checkpoint(3);
    const c = checkpoint(5);
    a.retainUntil = 1_801_000;
    const { ctx } = context({
      by_field_epoch_state_seq: [[b]],
      by_field_epoch_state_retain_seq: [[]],
    });

    expect(await retentionRead(ctx, c, a.retainUntil + 1)).toBe(3);
  });

  test("retains the predecessor when a checkpoint becomes ready", async () => {
    const a = checkpoint(1);
    const { ctx, patches } = context({ by_field_epoch_state_seq: [[a]] });

    await retentionWrite(ctx, a.fieldId, a.epoch, 3, 1_000);

    expect(patches).toEqual([
      {
        id: a._id,
        value: {
          retainUntil: 1_801_000,
          updatedAt: 1_000,
        },
      },
    ]);
  });
});
