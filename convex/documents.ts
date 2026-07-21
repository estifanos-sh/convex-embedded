import { type GenericId, type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { embedded } from "./embedded";
import { read as readTime } from "./time";

export const documentValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("documents"),
  body: v.string(),
  slug: v.string(),
  title: v.string(),
  updatedAt: v.number(),
});

const textSpliceValidator = v.object({
  delete: v.number(),
  index: v.number(),
  insert: v.string(),
});

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

const emptyBody = JSON.stringify([
  {
    type: "heading",
    props: { level: 1 },
    content: "Untitled",
  },
  {
    type: "paragraph",
    content: "",
  },
]);
const MAX_DOCUMENTS = 1_024;

export const list = embedded.replicated.query({
  args: { limit: v.optional(v.number()), prefix: v.optional(v.string()) },
  returns: v.array(documentValidator),
  handler: async (ctx, args) => {
    const limit = documentLimit(args.limit);
    if (args.prefix !== undefined) {
      const prefix = args.prefix;
      const documents = await ctx.db
        .query("documents")
        .withIndex("by_title", (q) => q.gte("title", prefix).lt("title", `${prefix}\uffff`))
        .take(limit);
      return documents;
    }
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(limit);
    return documents;
  },
});

const summaryValidator = v.object({
  _id: v.id("documents"),
  title: v.string(),
  updatedAt: v.number(),
});

export const summaries = embedded.replicated.query({
  args: { limit: v.optional(v.number()), prefix: v.optional(v.string()) },
  returns: v.array(summaryValidator),
  handler: async (ctx, args) => {
    const limit = documentLimit(args.limit);
    const prefix = args.prefix;
    const documents =
      prefix === undefined
        ? await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(limit)
        : await (async () => {
            const matches = await ctx.db
              .query("documents")
              .withIndex("by_title", (query) =>
                query.gte("title", prefix).lt("title", `${prefix}\uffff`),
              )
              .take(MAX_DOCUMENTS + 1);
            if (matches.length > MAX_DOCUMENTS) {
              throw new Error("The document prefix is too broad; use a more specific prefix.");
            }
            return matches
              .slice()
              .sort((left, right) => right.updatedAt - left.updatedAt)
              .slice(0, limit);
          })();
    return documents.map((document) => ({
      _id: document._id,
      title: document.title,
      updatedAt: document.updatedAt,
    }));
  },
});

function documentLimit(value: number | undefined): number {
  if (value === undefined) return 40;
  if (!Number.isFinite(value)) throw new Error("limit must be a finite number.");
  return Math.min(MAX_DOCUMENTS, Math.max(1, Math.trunc(value)));
}

export const get = embedded.replicated.query({
  args: { id: v.id("documents") },
  returns: v.union(v.null(), documentValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySlug = embedded.replicated.query({
  args: { slug: v.string() },
  returns: v.union(v.null(), documentValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("documents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const create = embedded.replicated.mutation({
  args: {
    body: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
  },
  returns: documentValidator,
  handler: async (ctx, args) => {
    const title = args.title ?? "Untitled";
    const updatedAt = args.updatedAt ?? readTime();
    const id = await ctx.db.insert("documents", {
      body: args.body ?? emptyBody,
      slug: args.slug ?? "untitled",
      title,
      updatedAt,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("Document was not created.");
    return created;
  },
});

export const update = embedded.replicated.mutation({
  args: {
    id: v.id("documents"),
    title: v.optional(v.string()),
    updatedAt: v.number(),
  },
  returns: documentValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Document not found.");
    await ctx.db.patch(args.id, {
      ...(args.title === undefined ? {} : { title: args.title }),
      updatedAt: args.updatedAt,
    });
    const updated = await ctx.db.get(args.id);
    if (!updated) throw new Error("Document not found.");
    return updated;
  },
});

export const writeBody = embedded.replicated.mutation({
  args: {
    id: v.id("documents"),
    splices: v.array(textSpliceValidator),
    title: v.optional(v.string()),
  },
  returns: documentValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Document not found.");
    for (const splice of args.splices) {
      await ctx.db.text.splice("documents", args.id, "body", splice);
    }
    const titleChanged = args.title !== undefined && existing.title !== args.title;
    if (titleChanged) {
      await ctx.db.patch(args.id, {
        title: args.title,
        updatedAt: readTime(),
      });
    }
    const updated = await ctx.db.get(args.id);
    if (!updated) throw new Error("Document not found.");
    return updated;
  },
});

export const writeSlug = embedded.replicated.mutation({
  args: { id: v.id("documents"), slug: v.string() },
  returns: documentValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Document not found.");
    await ctx.db.patch(args.id, { slug: args.slug });
    const updated = await ctx.db.get(args.id);
    if (!updated) throw new Error("Document not found.");
    return updated;
  },
});

export const savepoint = embedded.replicated.mutation({
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

export const remove = embedded.replicated.mutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.id))
      .take(512);
    if (attachments.length === 512) {
      throw new Error("Delete attachments before deleting this document.");
    }
    for (const attachment of attachments) {
      await ctx.db.delete(attachment._id);
    }
    await ctx.db.delete(args.id);
    return null;
  },
});

export const scheduleAppend = embedded.replicated.mutation({
  args: { id: v.id("documents") },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(0, internal.documents.scheduledAppend, { id: args.id });
  },
});

export const scheduleAppendAfter = embedded.replicated.mutation({
  args: { id: v.id("documents"), delayMs: v.number() },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(args.delayMs, internal.documents.scheduledAppend, {
      id: args.id,
    });
  },
});

export const cancelAppend = embedded.replicated.mutation({
  args: { scheduleId: v.id("_scheduled_functions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.cancel(args.scheduleId);
    return null;
  },
});

export const generateUploadUrl = embedded.replicated.mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const scheduledAppend = embedded.replicated.internalMutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) return null;
    const title = `${document.title}!`;
    const updatedAt = readTime();
    await ctx.db.patch(args.id, { title, updatedAt });
    return null;
  },
});
