import type { DataModelFromSchemaDefinition, MutationBuilder } from "convex/server";
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

import { deleteProgress, deleteProgressValidator } from "./model";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const MAX_DELETE = 1_024;

export const clear = mutation({
  args: {
    fieldId: v.id("crdtFields"),
    expectedEpoch: v.number(),
    numItems: v.number(),
  },
  returns: deleteProgressValidator,
  handler: async (ctx, args) => {
    const field = await ctx.db.get("crdtFields", args.fieldId);
    if (!field) return deleteProgress(0, true);
    if (!field.detached || field.epoch !== args.expectedEpoch) {
      throw new Error("Only the expected detached CRDT epoch can be cleared.");
    }
    const limit = clamp(args.numItems);
    const payloads = await ctx.db
      .query("crdtPayloads")
      .withIndex("by_fieldid_and_epoch_and_seq", (q) =>
        q.eq("fieldId", field._id).eq("epoch", field.epoch),
      )
      .take(limit + 1);
    const payloadPage = payloads.slice(0, limit);
    for (const payload of payloadPage) await ctx.db.delete("crdtPayloads", payload._id);
    if (payloadPage.length === limit) return deleteProgress(payloadPage.length, false);

    const remaining = limit - payloadPage.length;
    const checkpoints = await ctx.db
      .query("crdtCheckpoints")
      .withIndex("by_fieldid_and_epoch_and_throughseq", (q) =>
        q.eq("fieldId", field._id).eq("epoch", field.epoch),
      )
      .take(remaining + 1);
    const checkpointPage = checkpoints.slice(0, remaining);
    for (const checkpoint of checkpointPage) {
      const [reference] = await ctx.db
        .query("revisionCrdt")
        .withIndex("by_checkpointid", (q) => q.eq("checkpointId", checkpoint._id))
        .take(1);
      if (reference) {
        throw new Error("Cannot clear a CRDT checkpoint referenced by a retained revision.");
      }
      await ctx.db.delete("crdtCheckpoints", checkpoint._id);
    }
    const deleted = payloadPage.length + checkpointPage.length;
    if (checkpointPage.length === remaining) return deleteProgress(deleted, false);
    await ctx.db.delete("crdtFields", field._id);
    return deleteProgress(deleted + 1, true);
  },
});

function clamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("numItems must be a positive integer.");
  }
  return Math.min(value, MAX_DELETE);
}
