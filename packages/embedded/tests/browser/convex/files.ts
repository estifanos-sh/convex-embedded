import { v } from "convex/values";

import { embedded } from "./embedded";

const metadataValidator = v.object({
  contentType: v.optional(v.string()),
  size: v.number(),
});

type StorageMetadata = {
  contentType?: string;
  size: number;
};

export const generateUploadUrl = embedded.remote.mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const metadata = embedded.remote.query({
  args: { storageId: v.string() },
  returns: v.union(v.null(), metadataValidator),
  handler: async (ctx, args) => {
    const row = (await ctx.db.system.get(
      "_storage",
      args.storageId as never,
    )) as StorageMetadata | null;
    return row === null
      ? null
      : {
          contentType: row.contentType,
          size: row.size,
        };
  },
});

export const url = embedded.remote.query({
  args: { storageId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId as never);
  },
});
