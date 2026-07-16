import { type GenericId, type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./embedded";
import { read as readTime } from "./time";

const documentValidator = v.object({
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

const revisionValidator = v.object({
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

export const list = query({
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

export const summaries = query({
  args: { limit: v.optional(v.number()), prefix: v.optional(v.string()) },
  returns: v.array(summaryValidator),
  handler: async (ctx, args) => {
    const limit = documentLimit(args.limit);
    const documents = await ctx.db.query("documents").collect();
    const matched =
      args.prefix === undefined
        ? documents
        : documents.filter(
            (document) =>
              document.title >= (args.prefix as string) && document.title < `${args.prefix}\uffff`,
          );
    matched.sort((left, right) => right.updatedAt - left.updatedAt);
    return matched.slice(0, limit).map((document) => ({
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

export const get = query({
  args: { id: v.id("documents") },
  returns: v.union(v.null(), documentValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  returns: v.union(v.null(), documentValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("documents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const create = mutation({
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

export const update = mutation({
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

export const writeBody = mutation({
  args: {
    id: v.id("documents"),
    splices: v.array(textSpliceValidator),
    title: v.optional(v.string()),
  },
  returns: documentValidator,
  handler: async (ctx, args) => {
    for (const splice of args.splices) {
      await ctx.db.text.splice("documents", args.id, "body", splice);
    }
    if (args.title !== undefined) {
      const document = await ctx.db.get(args.id);
      if (!document) throw new Error("Document not found.");
      if (document.title !== args.title) {
        await ctx.db.patch(args.id, { title: args.title });
      }
    }
    const updated = await ctx.db.get(args.id);
    if (!updated) throw new Error("Document not found.");
    return updated;
  },
});

export const writeSlug = mutation({
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

export const savepoint = mutation({
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

export const history = query({
  local: false,
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

export const revision = query({
  local: false,
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

export const restore = mutation({
  local: false,
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

export const remove = mutation({
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

export const scheduleAppend = mutation({
  args: { id: v.id("documents") },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(0, internal.documents.scheduledAppend, { id: args.id });
  },
});

export const scheduleAppendAfter = mutation({
  args: { id: v.id("documents"), delayMs: v.number() },
  returns: v.id("_scheduled_functions"),
  handler: async (ctx, args): Promise<GenericId<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(args.delayMs, internal.documents.scheduledAppend, {
      id: args.id,
    });
  },
});

export const cancelAppend = mutation({
  args: { scheduleId: v.id("_scheduled_functions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.cancel(args.scheduleId);
    return null;
  },
});

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const scheduledAppend = internalMutation({
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
