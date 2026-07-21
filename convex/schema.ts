import { defineEmbeddedSchema, embeddedTable } from "@convex-dev/embedded/schema";
import { v } from "convex/values";
import { e } from "@convex-dev/embedded/values";

export default defineEmbeddedSchema({
  attachments: embeddedTable({
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
  documents: embeddedTable({
    body: e.text(),
    slug: v.string(),
    title: v.string(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_title", ["title"])
    .index("by_updatedAt", ["updatedAt"]),
});
