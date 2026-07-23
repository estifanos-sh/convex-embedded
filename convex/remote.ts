import { type Infer, v } from "convex/values";

import { components } from "./_generated/api";
import { documentValidator } from "./documents";
import { embedded } from "./embedded";
import { revisionValidator } from "./rev";

export const history = embedded.remote.query({
  args: {
    id: v.id("documents"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.id))) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.rev.list, {
      table: "documents",
      rowId: args.id,
      paginationOpts: { cursor: args.cursor, numItems: args.numItems },
    });
  },
});

export const revision = embedded.remote.query({
  args: { id: v.id("documents"), revId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.id))) throw new Error("Document not found.");
    return await ctx.runQuery(components.embedded.rev.get, {
      table: "documents",
      rowId: args.id,
      revId: args.revId,
    });
  },
});

export const restore = embedded.remote.mutation({
  args: { id: v.id("documents"), revId: v.string() },
  returns: v.object({
    document: documentValidator,
    revision: revisionValidator,
  }),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.id))) throw new Error("Document not found.");
    const revision = await ctx.runMutation(components.embedded.rev.restore, {
      table: "documents",
      rowId: args.id,
      revId: args.revId,
    });
    if (revision.deleted) throw new Error("Deleted document revisions are not restorable here.");
    await ctx.db.replace(args.id, revision.value as never);
    const document = await ctx.db.get(args.id);
    if (!document) throw new Error("Document not found after restore.");
    return { document, revision: revision as Infer<typeof revisionValidator> };
  },
});

export const hostedUrl = embedded.remote.query({
  args: { token: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const attachment = await ctx.db
      .query("attachments")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    return attachment ? await ctx.storage.getUrl(attachment.storageId) : null;
  },
});

export const serve = embedded.remote.internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.object({
      contentType: v.string(),
      storageId: v.id("_storage"),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const attachment = await ctx.db
      .query("attachments")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    return attachment
      ? { contentType: attachment.contentType, storageId: attachment.storageId }
      : null;
  },
});
