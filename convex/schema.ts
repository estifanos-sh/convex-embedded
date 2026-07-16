import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { text } from "@convex-dev/embedded/values";

export default defineSchema({
  attachments: defineTable({
    contentType: v.string(),
    documentId: v.id("documents"),
    name: v.string(),
    size: v.number(),
    storageId: v.id("_storage"),
    token: v.string(),
  })
    .index("by_documentId", ["documentId"])
    .index("by_storageId", ["storageId"])
    .index("by_token", ["token"]),
  documents: defineTable({
    body: text(),
    slug: v.string(),
    title: v.string(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_title", ["title"])
    .index("by_updatedAt", ["updatedAt"]),
});
