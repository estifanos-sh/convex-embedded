import type { DataModelFromSchemaDefinition, GenericMutationCtx } from "convex/server";

import schema from "../schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationCtx = GenericMutationCtx<DataModel>;
type Checkpoint = DataModel["crdtCheckpoints"]["document"];

// A checkpoint pull is a bounded sequence of independently retried queries. Keep the immediate
// predecessor readable long enough for a pull already using it to finish or restart.
const RETAIN_MS = 30 * 60_000;

export async function write(
  ctx: MutationCtx,
  fieldId: Checkpoint["fieldId"],
  epoch: number,
  throughSeq: number,
  at: number,
): Promise<void> {
  const [previous] = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_seq", (q) =>
      q.eq("fieldId", fieldId).eq("epoch", epoch).eq("state", "ready").lt("throughSeq", throughSeq),
    )
    .order("desc")
    .take(1);
  if (!previous) return;
  const retainUntil = at + RETAIN_MS;
  if ((previous.retainUntil ?? 0) >= retainUntil) return;
  await ctx.db.patch("crdtCheckpoints", previous._id, { retainUntil, updatedAt: at });
}

export async function read(ctx: MutationCtx, checkpoint: Checkpoint, at: number): Promise<number> {
  const [previous] = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_seq", (q) =>
      q
        .eq("fieldId", checkpoint.fieldId)
        .eq("epoch", checkpoint.epoch)
        .eq("state", "ready")
        .lt("throughSeq", checkpoint.throughSeq),
    )
    .order("desc")
    .take(1);
  const [retained] = await ctx.db
    .query("crdtCheckpoints")
    .withIndex("by_field_epoch_state_retain_seq", (q) =>
      q
        .eq("fieldId", checkpoint.fieldId)
        .eq("epoch", checkpoint.epoch)
        .eq("state", "ready")
        .gt("retainUntil", at),
    )
    .order("asc")
    .take(1);
  return Math.min(
    checkpoint.throughSeq,
    previous?.throughSeq ?? checkpoint.throughSeq,
    retained?.throughSeq ?? checkpoint.throughSeq,
  );
}
