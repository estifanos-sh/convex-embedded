import { type Infer, v } from "convex/values";
import { components } from "./_generated/api";
import { replicated } from "./embedded";

export const revisionValidator = v.object({
  revId: v.string(),
  groupId: v.string(),
  table: v.string(),
  rowId: v.id("documents"),
  origin: v.union(
    v.literal("savepoint"),
    v.literal("conflict"),
    v.literal("rejected"),
    v.literal("displaced"),
    v.literal("delete"),
  ),
  status: v.union(v.literal("active"), v.literal("retained")),
  parentRevId: v.optional(v.string()),
  createdAt: v.number(),
  deleted: v.boolean(),
  value: v.optional(v.any()),
  crdt: v.array(
    v.object({
      field: v.string(),
      kind: v.union(v.literal("text"), v.literal("count"), v.literal("set")),
      projectionHash: v.string(),
    }),
  ),
});

export const savepoint = replicated.mutation({
  args: { id: v.id("documents") },
  returns: revisionValidator,
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) throw new Error("Document not found.");
    const { _id, _creationTime, ...value } = document;
    return (await ctx.runMutation(components.embedded.rev.create, {
      table: "documents",
      rowId: args.id,
      value,
      deleted: false,
    })) as Infer<typeof revisionValidator>;
  },
});
