import { defineEmbeddedSchema, localTable, replicatedTable } from "@convex-dev/embedded/schema";
import { v } from "convex/values";
import { e } from "@convex-dev/embedded/values";

const schema = defineEmbeddedSchema({
  attachments: replicatedTable({
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
  documents: replicatedTable({
    expanded: e.local(v.boolean()),
    body: e.text(),
    slug: v.string(),
    title: v.string(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_title", ["title"])
    .index("by_updatedAt", ["updatedAt"]),
  issues: replicatedTable({
    expanded: e.local(v.boolean()),
    body: e.text(),
    title: v.string(),
  }).index("by_title", ["title"]),
  pins: localTable({
    documentId: v.id("documents"),
  }).index("by_documentId", ["documentId"]),
  preferences: localTable({
    theme: v.string(),
  }),
  setupState: localTable({
    version: v.number(),
  }),
});

export default schema;
