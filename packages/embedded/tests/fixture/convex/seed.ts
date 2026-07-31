import { v } from "convex/values";

import { components } from "./_generated/api";
import { remote } from "./embedded";
import { read as readTime } from "./time";
import { EMBEDDED_PROTOCOL_VERSION } from "../../../src/protocol";

const revisionValidator = v.union(
  v.object({
    content: v.literal("value"),
    table: v.string(),
    rowId: v.string(),
    value: v.any(),
  }),
  v.object({ content: v.literal("deleted"), table: v.string(), rowId: v.string() }),
);

export const commit = remote.mutation({
  args: {
    identityKey: v.string(),
    clientId: v.string(),
    mutationId: v.string(),
    outcome: v.union(
      v.literal("applied"),
      v.literal("conflict"),
      v.literal("rejected"),
      v.literal("rebase"),
    ),
    files: v.array(v.object({ storageId: v.string(), delta: v.number() })),
    revisions: v.array(revisionValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const common = {
      mutationId: args.mutationId,
      inserts: [],
      schedules: [],
      uploads: [],
      revisions: [],
    };
    const identity = {
      identity: args.identityKey,
      clientId: args.clientId,
      replayId: args.mutationId,
      fingerprint: args.mutationId,
      logicalFingerprint: args.mutationId,
      runtime: {
        schemaHash: "fixture",
        moduleGraphHash: "fixture",
        protocolVersion: EMBEDDED_PROTOCOL_VERSION,
      },
    };
    if (args.outcome === "applied") {
      return await ctx.runMutation(components.embedded.protocol.commit, {
        request: {
          ...identity,
          kind: "apply",
          verification: { kind: "ready", witnesses: [] },
          settlement: { ...common, outcome: args.outcome, result: null },
          changes: [],
          crdt: [],
          files: args.files,
        },
      });
    }
    if (args.files.length > 0) {
      await ctx.runMutation(components.embedded.protocol.commit, {
        request: {
          ...identity,
          replayId: `${args.mutationId}:files`,
          fingerprint: `${args.mutationId}:files`,
          logicalFingerprint: `${args.mutationId}:files`,
          kind: "apply",
          verification: { kind: "ready", witnesses: [] },
          settlement: {
            ...common,
            mutationId: `${args.mutationId}:files`,
            outcome: "applied",
            result: null,
          },
          changes: [],
          crdt: [],
          files: args.files,
        },
      });
    }
    return await ctx.runMutation(components.embedded.protocol.commit, {
      request: {
        ...identity,
        kind: "failure",
        settlement: { ...common, outcome: args.outcome, error: { code: "CUT4_SEED" } },
        changes: [],
        revisions: args.revisions,
      },
    });
  },
});

export const client = remote.mutation({
  args: {
    identityKey: v.string(),
    clientId: v.string(),
    schemaHash: v.string(),
    moduleGraphHash: v.string(),
    protocolVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const mutationId = crypto.randomUUID();
    const functionName = "cut4:seed";
    const requestId = crypto.randomUUID();
    await ctx.runMutation(components.embedded.protocol.replayWrite, {
      tokenHash: crypto.randomUUID(),
      kind: "push",
      clientId: args.clientId,
      requestId,
      functionName,
      mutationId,
      replayId: mutationId,
      fingerprint: mutationId,
      logicalFingerprint: mutationId,
      resultHash: mutationId,
      mutationTime: readTime(),
      randomSeed: mutationId,
      reads: [],
      inserts: [],
      schedules: [],
      uploads: [],
      crdt: [],
      revisionCheckpoints: [],
      runtime: {
        schemaHash: args.schemaHash,
        moduleGraphHash: args.moduleGraphHash,
        protocolVersion: args.protocolVersion,
      },
      expiresAt: readTime() + 60_000,
    });
    await ctx.runMutation(components.embedded.protocol.replayConsume, {
      requestId,
      functionName,
    });
    await ctx.runMutation(components.embedded.protocol.commit, {
      request: {
        identity: args.identityKey,
        clientId: args.clientId,
        replayId: mutationId,
        fingerprint: mutationId,
        logicalFingerprint: mutationId,
        runtime: {
          schemaHash: args.schemaHash,
          moduleGraphHash: args.moduleGraphHash,
          protocolVersion: args.protocolVersion,
        },
        kind: "apply",
        verification: { kind: "ready", witnesses: [] },
        settlement: {
          mutationId,
          inserts: [],
          schedules: [],
          uploads: [],
          revisions: [],
          outcome: "applied",
          result: null,
        },
        changes: [],
        crdt: [],
        files: [],
      },
    });
    return null;
  },
});
