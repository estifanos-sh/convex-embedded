import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { text } from "@convex-dev/embedded/values";

export default defineSchema({
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
