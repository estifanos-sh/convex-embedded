import type { DataModelFromSchemaDefinition, MutationBuilder } from "convex/server";
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import { read as readTime } from "../time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

export const write = mutation({
  args: {
    table: v.string(),
    rowId: v.string(),
    field: v.string(),
  },
  returns: v.object({
    checkpointId: v.string(),
    state: v.union(v.literal("requested"), v.literal("ready")),
  }),
  handler: async (ctx, args) => {
    const field = await ctx.db
      .query("crdtFields")
      .withIndex("by_table_and_rowid_and_field", (q) =>
        q.eq("table", args.table).eq("rowId", args.rowId).eq("field", args.field),
      )
      .unique();
    if (!field) throw new Error("CRDT field not found.");
    const [requested] = await ctx.db
      .query("crdtCheckpoints")
      .withIndex("by_field_epoch_state_seq", (q) =>
        q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("state", "requested"),
      )
      .take(1);
    if (requested) return { checkpointId: requested._id, state: requested.state };
    const throughSeq = field.headSeq;
    const prior = await ctx.db
      .query("crdtCheckpoints")
      .withIndex("by_fieldid_and_epoch_and_throughseq", (q) =>
        q.eq("fieldId", field._id).eq("epoch", field.epoch).eq("throughSeq", throughSeq),
      )
      .unique();
    if (prior) return { checkpointId: prior._id, state: prior.state };
    const checkpointId = await ctx.db.insert("crdtCheckpoints", {
      fieldId: field._id,
      epoch: field.epoch,
      throughSeq,
      projectionHash: field.projectionHash,
      responseToken: crypto.randomUUID(),
      state: "requested",
      createdAt: readTime(),
      updatedAt: readTime(),
    });
    return { checkpointId, state: "requested" as const };
  },
});
