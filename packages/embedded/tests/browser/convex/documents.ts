import { v, type GenericId, type Infer } from "convex/values";

import { replicated } from "./embedded";
import {
  del as documentsDel,
  documentValidator,
  read as documentsRead,
  write as documentsWrite,
} from "../../../../../convex/documents";

type DocumentRow = Infer<typeof documentValidator>;

/**
 * The static bundler manifest lists only inline `replicated.<builder>` registrations and never
 * follows `export *`, yet the packaged browser worker gates every root call on that manifest.
 * Re-declare the demo's `read`/`write`/`del` as canonical registrations that delegate to the demo's
 * own handlers, so the browser build carries first-class `documents:read`/`documents:write`/
 * `documents:del` manifest entries while exercising the demo's real behavior rather than a copy.
 */
export function delegate<Ctx, Args, Result>(registration: unknown, ctx: Ctx, args: Args): Result {
  const handler = (registration as { __embeddedHandler?: (ctx: Ctx, args: Args) => Result })
    .__embeddedHandler;
  if (handler === undefined) {
    throw new Error("Embedded registration is missing its captured handler.");
  }
  return handler(ctx, args);
}

const textSpliceValidator = v.object({
  base: v.optional(v.string()),
  delete: v.number(),
  index: v.number(),
  insert: v.string(),
});

export const read = replicated.query({
  args: {
    id: v.optional(v.id("documents")),
    slug: v.optional(v.string()),
    limit: v.optional(v.number()),
    prefix: v.optional(v.string()),
  },
  returns: v.array(documentValidator),
  handler: (ctx, args): Promise<DocumentRow[]> => delegate(documentsRead, ctx, args),
});

export const write = replicated.mutation({
  args: {
    id: v.optional(v.id("documents")),
    body: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    splices: v.optional(v.array(textSpliceValidator)),
  },
  returns: documentValidator,
  handler: (ctx, args): Promise<DocumentRow> => delegate(documentsWrite, ctx, args),
});

export const del = replicated.mutation({
  args: { id: v.id("documents") },
  returns: v.null(),
  handler: (ctx, args): Promise<null> => delegate(documentsDel, ctx, args),
});

const summaryValidator = v.object({
  _id: v.id("documents"),
  title: v.string(),
  updatedAt: v.number(),
});

/**
 * Bench-owned body-omitting projection over `documents` (`{_id, title, updatedAt}`). The demo folded
 * its list into `documents:read`, so the browser remote benchmark keeps this partial list in its own
 * fixture to exercise the engine's retained-result cache: a body edit leaves the projection
 * byte-identical and is cache-served, while a title edit rewrites it.
 */
export const summaries = replicated.query({
  args: {
    limit: v.optional(v.number()),
    prefix: v.optional(v.string()),
  },
  returns: v.array(summaryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(1_024, Math.max(1, Math.trunc(args.limit ?? 40)));
    const prefix = args.prefix;
    const rows =
      prefix === undefined
        ? await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(limit)
        : await ctx.db
            .query("documents")
            .withIndex("by_title", (q) => q.gte("title", prefix).lt("title", `${prefix}\uffff`))
            .take(limit);
    return rows.map((row: { [key: string]: unknown; _id: GenericId<string> }) => ({
      _id: row._id as GenericId<"documents">,
      title: row.title as string,
      updatedAt: row.updatedAt as number,
    }));
  },
});
