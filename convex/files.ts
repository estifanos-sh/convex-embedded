import { v } from "convex/values";
import { embedded } from "./embedded";

export const generateUploadUrl = embedded.replicated.mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const attach = embedded.replicated.mutation({
  args: {
    contentType: v.string(),
    documentId: v.id("documents"),
    name: v.string(),
    size: v.number(),
    storageId: v.id("_storage"),
    token: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.documentId))) throw new Error("Document not found.");
    if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > 8 * 1024 * 1024) {
      throw new Error("Attachments must be 8 MB or smaller.");
    }
    const file = await ctx.db.system.get(args.storageId);
    if (!file) throw new Error("The uploaded file is unavailable.");
    if (file.size !== args.size) throw new Error("The uploaded file size does not match.");
    if (file.contentType !== undefined && file.contentType !== args.contentType) {
      throw new Error("The uploaded file type does not match.");
    }
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (existing) {
      if (
        existing.documentId === args.documentId &&
        existing.storageId === args.storageId &&
        existing.name === args.name &&
        existing.size === args.size &&
        existing.contentType === args.contentType
      ) {
        return existing.token;
      }
      throw new Error("Attachment token is already in use.");
    }
    const storageAttachment = await ctx.db
      .query("attachments")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (storageAttachment) throw new Error("The file is already attached.");
    await ctx.db.insert("attachments", args);
    return args.token;
  },
});

export const resolve = embedded.replicated.query({
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

export const metadata = embedded.replicated.query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.object({ contentType: v.optional(v.string()), size: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const file = await ctx.db.system.get(args.storageId);
    return file ? { contentType: file.contentType, size: file.size } : null;
  },
});

export const url = embedded.replicated.query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await ctx.storage.getUrl(args.storageId),
});
