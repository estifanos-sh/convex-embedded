import { v } from "convex/values";

export const crdtKindValidator = v.union(v.literal("text"), v.literal("count"), v.literal("set"));

export const deleteProgressValidator = v.union(
  v.object({ progress: v.literal("continue"), deleted: v.number() }),
  v.object({ progress: v.literal("complete"), deleted: v.number() }),
);

export function deleteProgress(deleted: number, complete: boolean) {
  return complete
    ? ({ progress: "complete", deleted } as const)
    : ({ progress: "continue", deleted } as const);
}

const settlementInputFields = {
  mutationId: v.string(),
  inserts: v.array(
    v.object({
      ordinal: v.number(),
      table: v.string(),
      id: v.string(),
    }),
  ),
  schedules: v.array(v.object({ ordinal: v.number(), id: v.string() })),
  uploads: v.array(v.object({ ordinal: v.number(), url: v.string() })),
  revisions: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      revId: v.string(),
    }),
  ),
};

export const appliedSettlementInputValidator = v.object({
  ...settlementInputFields,
  outcome: v.literal("applied"),
  result: v.any(),
});

export const failureSettlementInputValidator = v.union(
  v.object({ ...settlementInputFields, outcome: v.literal("conflict"), error: v.any() }),
  v.object({ ...settlementInputFields, outcome: v.literal("rejected"), error: v.any() }),
  v.object({ ...settlementInputFields, outcome: v.literal("rebase"), error: v.any() }),
);

const settlementFields = {
  ...settlementInputFields,
  crdt: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      field: v.string(),
      kind: crdtKindValidator,
      headSeq: v.number(),
      projectionHash: v.string(),
    }),
  ),
  authoritative: v.array(
    v.union(
      v.object({
        op: v.literal("put"),
        table: v.string(),
        rowId: v.string(),
        fields: v.any(),
        plainHash: v.string(),
      }),
      v.object({
        op: v.literal("del"),
        table: v.string(),
        rowId: v.string(),
        plainHash: v.string(),
      }),
    ),
  ),
};

export const settlementValidator = v.union(
  v.object({ ...settlementFields, outcome: v.literal("applied"), result: v.any() }),
  v.object({ ...settlementFields, outcome: v.literal("conflict"), error: v.any() }),
  v.object({ ...settlementFields, outcome: v.literal("rejected"), error: v.any() }),
  v.object({ ...settlementFields, outcome: v.literal("rebase"), error: v.any() }),
);

export const rowInputValidator = v.object({
  table: v.string(),
  rowId: v.string(),
  fields: v.any(),
  crdtFields: v.array(v.string()),
});

export const changeInputValidator = v.union(
  v.object({
    op: v.literal("put"),
    table: v.string(),
    rowId: v.string(),
    fields: v.any(),
    contentHash: v.string(),
  }),
  v.object({
    op: v.literal("del"),
    table: v.string(),
    rowId: v.string(),
    contentHash: v.string(),
  }),
);

export const pullChangeValidator = v.union(
  v.object({
    op: v.literal("put"),
    plainHash: v.string(),
    table: v.string(),
    rowId: v.string(),
    fields: v.any(),
  }),
  v.object({
    op: v.literal("del"),
    plainHash: v.string(),
    table: v.string(),
    rowId: v.string(),
  }),
);

export const resultRowValidator = v.object({
  path: v.string(),
  table: v.string(),
  rowId: v.string(),
});

export const pullCrdtValidator = v.object({
  table: v.string(),
  rowId: v.string(),
  field: v.string(),
  kind: crdtKindValidator,
  epoch: v.number(),
  checkpoint: v.object({
    id: v.string(),
    seq: v.number(),
    bytes: v.number(),
    hash: v.string(),
  }),
  headSeq: v.number(),
  projectionHash: v.string(),
  checkpointRequest: v.optional(
    v.object({
      checkpointId: v.string(),
      responseToken: v.string(),
      throughSeq: v.number(),
      projectionHash: v.string(),
    }),
  ),
  payload: v.optional(v.object({ seq: v.number(), bytes: v.bytes(), hash: v.string() })),
});

export const opaqueBytesValidator = v.union(
  v.object({ kind: v.literal("inline"), bytes: v.bytes(), hash: v.string() }),
  v.object({
    kind: v.literal("staged"),
    blobId: v.string(),
    bytes: v.number(),
    hash: v.string(),
  }),
);

export const crdtEffectValidator = v.object({
  table: v.string(),
  rowId: v.string(),
  field: v.string(),
  kind: crdtKindValidator,
  baseSeq: v.number(),
  projection: v.any(),
  projectionHash: v.string(),
  payload: v.bytes(),
  checkpoint: v.optional(
    v.object({
      throughSeq: v.number(),
      content: opaqueBytesValidator,
    }),
  ),
});

export const revisionCheckpointValidator = v.object({
  ordinal: v.number(),
  operation: v.union(v.literal("create"), v.literal("retain")),
  table: v.string(),
  snapshots: v.array(
    v.object({
      field: v.string(),
      kind: crdtKindValidator,
      headSeq: v.number(),
      projectionHash: v.string(),
      bytes: v.bytes(),
      hash: v.string(),
    }),
  ),
});

export const revisionInputValidator = v.union(
  v.object({
    content: v.literal("value"),
    table: v.string(),
    rowId: v.string(),
    value: v.any(),
  }),
  v.object({
    content: v.literal("deleted"),
    table: v.string(),
    rowId: v.string(),
  }),
);

export const fileInputValidator = v.object({
  storageId: v.string(),
  delta: v.number(),
});

export const insertRefValidator = v.object({
  mutationId: v.string(),
  ordinal: v.number(),
  table: v.string(),
});

const readBoundValidator = v.object({
  field: v.string(),
  value: v.any(),
  inclusive: v.boolean(),
});

export const readWitnessValidator = v.union(
  v.object({
    kind: v.literal("point"),
    table: v.string(),
    rowId: v.string(),
    plainHash: v.string(),
    crdt: v.array(
      v.object({
        field: v.string(),
        epoch: v.number(),
        headSeq: v.number(),
        projectionHash: v.string(),
      }),
    ),
  }),
  v.object({
    kind: v.literal("range"),
    table: v.string(),
    index: v.optional(v.string()),
    equality: v.array(v.object({ field: v.string(), value: v.any() })),
    limit: v.optional(v.number()),
    lower: v.optional(readBoundValidator),
    upper: v.optional(readBoundValidator),
    order: v.union(v.literal("asc"), v.literal("desc")),
    membersHash: v.string(),
  }),
);
