import { v } from "convex/values";
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
  base: v.optional(v.string()),
  delete: v.number(),
  index: v.number(),
  insert: v.string(),
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

export const read = embedded.replicated.query({
  args: {
    id: v.optional(v.id("documents")),
    slug: v.optional(v.string()),
    limit: v.optional(v.number()),
    prefix: v.optional(v.string()),
  },
  returns: v.array(documentValidator),
  handler: async (ctx, args) => {
    if (args.id !== undefined) {
      const document = await ctx.db.get(args.id);
      return document ? [document] : [];
    }
    if (args.slug !== undefined) {
      const slug = args.slug;
      const document = await ctx.db
        .query("documents")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      return document ? [document] : [];
    }
    const limit = documentLimit(args.limit);
    if (args.prefix !== undefined) {
      const prefix = args.prefix;
      return await ctx.db
        .query("documents")
        .withIndex("by_title", (q) => q.gte("title", prefix).lt("title", `${prefix}\uffff`))
        .take(limit);
    }
    return await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(limit);
  },
});

function documentLimit(value: number | undefined): number {
  if (value === undefined) return 40;
  if (!Number.isFinite(value)) throw new Error("limit must be a finite number.");
  return Math.min(MAX_DOCUMENTS, Math.max(1, Math.trunc(value)));
}

/**
 * Persist a document. Without `id`, inserts a new document. With `id`, the arguments must carry
 * exactly one write intent: a body edit (`splices`, optionally alongside a `title`), a `slug`
 * change (which must stand alone), or a `title`/`updatedAt` patch. Combining intents throws
 * rather than silently dropping the extra fields, and an `id` that names no intent throws too —
 * a deliberate timestamp bump is a `title`/`updatedAt` patch, not a bare `id`.
 */
export const write = embedded.replicated.mutation({
  args: {
    id: v.optional(v.id("documents")),
    body: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    splices: v.optional(v.array(textSpliceValidator)),
  },
  returns: documentValidator,
  handler: async (ctx, args) => {
    if (args.id === undefined) {
      const id = await ctx.db.insert("documents", {
        body: args.body ?? emptyBody,
        slug: args.slug ?? "untitled",
        title: args.title ?? "Untitled",
        updatedAt: args.updatedAt ?? readTime(),
      });
      const created = await ctx.db.get(id);
      if (!created) throw new Error("Document was not created.");
      return created;
    }
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Document not found.");
    if (
      args.slug !== undefined &&
      (args.splices !== undefined || args.title !== undefined || args.updatedAt !== undefined)
    ) {
      throw new Error(
        "A slug change must be the only edit; do not combine slug with splices, title, or updatedAt.",
      );
    }
    if (args.splices !== undefined && args.updatedAt !== undefined) {
      throw new Error(
        "A body edit and an updatedAt patch are separate edits; do not send updatedAt with splices.",
      );
    }
    if (args.splices !== undefined) {
      for (const s of args.splices) {
        await ctx.db.text.splice("documents", args.id, "body", {
          index: s.index,
          delete: s.delete,
          insert: s.insert,
          base: s.base,
        });
      }
      if (args.title !== undefined && existing.title !== args.title) {
        await ctx.db.patch(args.id, { title: args.title, updatedAt: readTime() });
      }
    } else if (args.slug !== undefined) {
      await ctx.db.patch(args.id, { slug: args.slug });
    } else if (args.title !== undefined || args.updatedAt !== undefined) {
      await ctx.db.patch(args.id, {
        ...(args.title === undefined ? {} : { title: args.title }),
        updatedAt: args.updatedAt ?? readTime(),
      });
    } else {
      throw new Error("An update requires splices, slug, title, or updatedAt.");
    }
    const updated = await ctx.db.get(args.id);
    if (!updated) throw new Error("Document not found.");
    return updated;
  },
});

export const del = embedded.replicated.mutation({
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
