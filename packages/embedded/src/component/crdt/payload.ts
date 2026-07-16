import type { DataModelFromSchemaDefinition, MutationBuilder } from "convex/server";
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

import { deleteResult, deleteResultValidator } from "../model";
import schema from "../schema";
import { read as readTime } from "../time";
import { read as retentionRead } from "./retention";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const MAX_DELETE = 1_024;

const deletion = mutation({
  args: { checkpointId: v.id("crdtCheckpoints"), numItems: v.number() },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    const checkpoint = await ctx.db.get("crdtCheckpoints", args.checkpointId);
    if (!checkpoint || checkpoint.state !== "ready") {
      throw new Error("Payload deletion requires a ready checkpoint.");
    }
    const limit = clamp(args.numItems);
    const throughSeq = await retentionRead(ctx, checkpoint, readTime());
    const rows = await ctx.db
      .query("crdtPayloads")
      .withIndex("by_fieldid_and_epoch_and_seq", (q) =>
        q.eq("fieldId", checkpoint.fieldId).eq("epoch", checkpoint.epoch).lte("seq", throughSeq),
      )
      .take(limit + 1);
    const page = rows.slice(0, limit);
    let bytes = 0;
    for (const row of page) {
      bytes += row.bytes.byteLength;
      await ctx.db.delete("crdtPayloads", row._id);
    }
    const field = await ctx.db.get("crdtFields", checkpoint.fieldId);
    if (field && page.length > 0) {
      await ctx.db.patch("crdtFields", field._id, {
        payloads: Math.max(0, field.payloads - page.length),
        payloadBytes: Math.max(0, field.payloadBytes - bytes),
        updatedAt: readTime(),
      });
    }
    return deleteResult(page.length, rows.length <= limit);
  },
});

export { deletion as delete };

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("numItems must be a positive integer.");
  }
  return Math.min(value, MAX_DELETE);
}
