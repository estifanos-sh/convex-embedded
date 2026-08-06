import type { ComponentApi } from "../component/_generated/component";
import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  GenericDataModel,
  GenericDatabaseWriter,
  GenericMutationCtx,
  GenericQueryCtx,
  FunctionReference,
  MutationBuilder,
  QueryBuilder,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
  Scheduler,
  SchemaDefinition,
} from "convex/server";
import {
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { asObjectValidator, ConvexError, v } from "convex/values";
import type { GenericValidator, PropertyValidators, Validator, VObject } from "convex/values";

import { embeddedFieldMeta } from "../meta";
import {
  assertFiniteDelta,
  assertIntentField,
  assertTextBase,
  validateCountAdd,
  validateSetField,
  validateTextSplice,
} from "../crdt/intent";
import { canonicalJson, hashDocument, hashValue } from "../hash";
import { validatorIdReferences, validatorIdValues } from "../id/path";
import {
  EMBEDDED_PROTOCOL_LEGACY_VERSION,
  EMBEDDED_PROTOCOL_MISMATCH,
  EMBEDDED_PROTOCOL_VERSION,
  isEmbeddedProtocolVersion,
  selectEmbeddedProtocolVersion,
  type EmbeddedProtocolVersion,
} from "../protocol";
import { withEntropy } from "../entropy";
import { read as readTime } from "../component/time";
import { pullChangeValidator, pullCrdtValidator, resultRowValidator } from "../component/model";
import {
  analyzeEmbeddedSchema,
  embeddedSchemaMeta,
  fieldPlacements,
  projectWireDoc,
  type ConvexEmbeddedSchema,
  type EmbeddedSchemaDefinition,
  type EmbeddedSchemaPlacements,
  type ReplicatedDataModel,
  type ServerDataModel,
} from "../schema";
import { normalizeMutationResult } from "../result";
import {
  assertReplicatedReference,
  assertReplicatedTarget,
  buildQueryBuilder,
  completeQueryRows,
  invokeQueryCapture,
  isEmbeddedComponentReference,
  projectComponentQueryResult,
  projectRevision,
  type FunctionManifest,
} from "./query";
import {
  compileStorageIdPaths,
  diffStorageIds,
  readStorageIds,
  type CompiledStorageIdPaths,
} from "../storage/id/path";

const MAX_TRACKED_ROWS = 1_024;
const MAX_TRACKED_RANGES = 1_024;
const REPLAY_TTL_MS = 60_000;

type EmbeddedRegisteredFunction = {
  __embeddedHandler?: (ctx: unknown, args: Record<string, unknown>) => unknown;
  __embeddedPlacement?: "replicated" | "remote";
};

type EmbeddedComponent = ComponentApi<string | undefined>;
type CrdtKind = "text" | "count" | "set";

type CrdtEffect = {
  table: string;
  rowId: string;
  field: string;
  kind: CrdtKind;
  baseSeq: number;
  projection: unknown;
  projectionHash: string;
  payload: ArrayBuffer;
  checkpoint?: {
    throughSeq: number;
    content:
      | { kind: "inline"; bytes: ArrayBuffer; hash: string }
      | { kind: "staged"; blobId: string; bytes: number; hash: string };
  };
};

type RevisionCheckpoint = {
  ordinal: number;
  operation: "create" | "retain";
  table: string;
  snapshots: Array<{
    field: string;
    kind: CrdtKind;
    headSeq: number;
    projectionHash: string;
    bytes: ArrayBuffer;
    hash: string;
  }>;
};

type ReplayEnvelope = {
  clientId: string;
  mutationId: string;
  replayId: string;
  fingerprint: string;
  logicalFingerprint: string;
  acknowledgeReplayId?: string;
  runtime: { schemaHash: string; moduleGraphHash: string; protocolVersion: number };
  resultHash: string;
  mutationTime: number;
  randomSeed: string;
  reads: ReadWitness[];
  inserts: InsertRef[];
  schedules: ScheduleRef[];
  uploads: UploadRef[];
  crdt: CrdtEffect[];
  revisionCheckpoints: RevisionCheckpoint[];
};

type RevisionCandidate =
  | { content: "value"; table: string; rowId: string; value: unknown }
  | { content: "deleted"; table: string; rowId: string };

type InsertRef = { mutationId: string; ordinal: number; table: string };
type ScheduleRef = { mutationId: string; ordinal: number };
type UploadRef = { mutationId: string; ordinal: number };
type ArgRef = { path: string; insert: InsertRef } | { path: string; schedule: ScheduleRef };
type MutationStorage = GenericMutationCtx<any>["storage"];

type ReadWitness =
  | {
      kind: "point";
      table: string;
      rowId: string;
      plainHash: string;
      crdt: Array<{
        field: string;
        epoch: number;
        headSeq: number;
        projectionHash: string;
      }>;
    }
  | {
      kind: "range";
      table: string;
      index: string;
      equality: Array<{ field: string; value: unknown; commitTs?: true }>;
      limit?: number;
      lower?: { field: string; value: unknown; inclusive: boolean; commitTs?: true };
      upper?: { field: string; value: unknown; inclusive: boolean; commitTs?: true };
      order: "asc" | "desc";
      membersHash: string;
    };

type SettlementBase = {
  mutationId: string;
  inserts: Array<{ ordinal: number; table: string; id: string }>;
  schedules: Array<{ ordinal: number; id: string }>;
  uploads: Array<{ ordinal: number; url: string }>;
  revisions: Array<{ table: string; rowId: string; revId: string }>;
};

type ConflictSettlementError = { code: "EMBEDDED_CONFLICT" };
type RejectedSettlementError = { code: "EMBEDDED_REJECTED" | "EMBEDDED_DIVERGENCE" };
type RebaseSettlementError = { code: "EMBEDDED_REBASE" };

type SettlementInput = SettlementBase &
  (
    | { outcome: "applied"; result: unknown }
    | { outcome: "conflict"; error: ConflictSettlementError }
    | { outcome: "rejected"; error: RejectedSettlementError }
    | { outcome: "rebase"; error: RebaseSettlementError }
  );

type FailureSettlementInput = Exclude<SettlementInput, { outcome: "applied" }>;

type Settlement = SettlementInput & {
  crdt: Array<{
    table: string;
    rowId: string;
    field: string;
    kind: CrdtKind;
    headSeq: number;
    projectionHash: string;
  }>;
  authoritative: Array<
    | {
        op: "put";
        table: string;
        rowId: string;
        fields: unknown;
        plainHash: string;
      }
    | { op: "del"; table: string; rowId: string; plainHash: string }
  >;
};

type WireSettlementBase = SettlementBase & {
  crdt: Settlement["crdt"];
  authoritative: Settlement["authoritative"];
};

/** A settlement after selecting the caller's response adapter. */
type WireSettlement =
  | (WireSettlementBase & { outcome: "applied"; result: unknown })
  | (WireSettlementBase & { outcome: "conflict"; error: unknown })
  | (WireSettlementBase & { outcome: "rejected"; error: unknown })
  | (WireSettlementBase & { outcome: "rebase"; error: unknown });

type CrdtIntentWriter = {
  text: {
    splice(
      table: string,
      id: string,
      field: string,
      change: { index: number; delete: number; insert: string; base?: string },
    ): Promise<void>;
  };
  count: {
    add(table: string, id: string, field: string, value: number): Promise<void>;
  };
  set: {
    add(table: string, id: string, field: string, value: unknown): Promise<void>;
    delete(table: string, id: string, field: string, value: unknown): Promise<void>;
  };
};

type EmbeddedMutationCtx<DataModel extends GenericDataModel> = Omit<
  GenericMutationCtx<DataModel>,
  "db"
> & {
  db: GenericDatabaseWriter<DataModel> & CrdtIntentWriter;
};

type EmbeddedQueryBuilder<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
> = (<
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(func: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: GenericQueryCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredQuery<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>) &
  QueryBuilder<DataModel, Visibility>;

type EmbeddedMutationBuilder<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
> = (<
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(func: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: EmbeddedMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredMutation<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>) &
  MutationBuilder<DataModel, Visibility>;

type RemoteMutationBuilder<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
> = (<
  ArgsValidator extends PropertyValidators | void | Validator<any, any, any>,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(func: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (ctx: GenericMutationCtx<DataModel>, ...args: OneOrZeroArgs) => ReturnValue;
}) => RegisteredMutation<Visibility, ArgsArrayToObject<OneOrZeroArgs>, ReturnValue>) &
  MutationBuilder<DataModel, Visibility>;

export type DefineEmbeddedOptions<Schema extends EmbeddedSchemaDefinition> = {
  component: EmbeddedComponent;
  /** Trusted generated placement metadata used for nested server calls. */
  manifest?: FunctionManifest;
  schema: Schema;
};

/** Placement-specific function builders and protocol endpoints for an Embedded schema. */
export type DefinedEmbedded<Schema extends EmbeddedSchemaDefinition> = {
  replicated: {
    query: EmbeddedQueryBuilder<ReplicatedDataModel<Schema>, "public">;
    mutation: EmbeddedMutationBuilder<ReplicatedDataModel<Schema>, "public">;
    internalQuery: EmbeddedQueryBuilder<ReplicatedDataModel<Schema>, "internal">;
    internalMutation: EmbeddedMutationBuilder<ReplicatedDataModel<Schema>, "internal">;
  };
  remote: {
    query: EmbeddedQueryBuilder<ServerDataModel<Schema>, "public">;
    mutation: RemoteMutationBuilder<ServerDataModel<Schema>, "public">;
    internalQuery: EmbeddedQueryBuilder<ServerDataModel<Schema>, "internal">;
    internalMutation: RemoteMutationBuilder<ServerDataModel<Schema>, "internal">;
  };
  upload: ReturnType<typeof buildUpload>;
  pull: ReturnType<typeof buildPull>;
  push: ReturnType<typeof buildPush>;
};

export function defineEmbedded<Schema extends EmbeddedSchemaDefinition>(
  options: DefineEmbeddedOptions<Schema>,
): DefinedEmbedded<Schema> {
  type Replicated = ReplicatedDataModel<Schema>;
  type Server = ServerDataModel<Schema>;
  const placements = embeddedSchemaMeta(options.schema as ConvexEmbeddedSchema);
  const tableNames = placements.replicatedTables;
  const crdtFields = schemaCrdtFields(options.schema);
  const analysis = analyzeEmbeddedSchema(options.schema as ConvexEmbeddedSchema);
  const storageIdPaths = new Map(
    Object.entries(analysis.storageIdPaths).map(([table, paths]) => [
      table,
      compileStorageIdPaths(paths),
    ]),
  );

  return {
    replicated: {
      query: buildQueryBuilder(
        queryGeneric,
        options.component,
        tableNames,
        crdtFields,
        placements,
        options.manifest,
      ) as EmbeddedQueryBuilder<Replicated, "public">,
      mutation: buildMutationBuilder(
        mutationGeneric,
        options.component,
        tableNames,
        crdtFields,
        storageIdPaths,
        placements,
        options.manifest,
      ) as EmbeddedMutationBuilder<Replicated, "public">,
      internalQuery: buildQueryBuilder(
        internalQueryGeneric,
        options.component,
        tableNames,
        crdtFields,
        placements,
        options.manifest,
      ) as EmbeddedQueryBuilder<Replicated, "internal">,
      internalMutation: buildMutationBuilder(
        internalMutationGeneric,
        options.component,
        tableNames,
        crdtFields,
        storageIdPaths,
        placements,
        options.manifest,
      ) as EmbeddedMutationBuilder<Replicated, "internal">,
    },
    remote: {
      query: buildRemoteBuilder(queryGeneric) as EmbeddedQueryBuilder<Server, "public">,
      mutation: buildRemoteBuilder(mutationGeneric) as RemoteMutationBuilder<Server, "public">,
      internalQuery: buildRemoteBuilder(internalQueryGeneric) as EmbeddedQueryBuilder<
        Server,
        "internal"
      >,
      internalMutation: buildRemoteBuilder(internalMutationGeneric) as RemoteMutationBuilder<
        Server,
        "internal"
      >,
    },
    upload: buildUpload(),
    pull: buildPull(options.component, options.manifest),
    push: buildPush(options.component, tableNames, crdtFields, placements, options.manifest),
  };
}

function buildRemoteBuilder(base: QueryBuilder<any, any> | MutationBuilder<any, any>) {
  return (definition: {
    args?: PropertyValidators | GenericValidator;
    returns?: PropertyValidators | GenericValidator;
    handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
  }) => {
    const registered = base(definition as never) as unknown as EmbeddedRegisteredFunction;
    registered.__embeddedHandler = definition.handler;
    registered.__embeddedPlacement = "remote";
    return registered;
  };
}

function buildUpload() {
  return mutationGeneric({
    args: {
      localStorageId: v.string(),
      sha256: v.string(),
      size: v.number(),
    },
    returns: v.object({ uploadUrl: v.string() }),
    handler: async (ctx, args) => {
      if (args.localStorageId.length === 0) throw new Error("localStorageId must not be empty.");
      if (!/^[0-9a-f]{64}$/.test(args.sha256)) throw new Error("sha256 must be lowercase hex.");
      if (!Number.isSafeInteger(args.size) || args.size < 0) {
        throw new Error("size must be a non-negative safe integer.");
      }
      return { uploadUrl: await ctx.storage.generateUploadUrl() };
    },
  });
}

function buildMutationBuilder(
  base: MutationBuilder<any, "public" | "internal">,
  component: EmbeddedComponent,
  tableNames: string[],
  crdtFields: Map<string, Map<string, CrdtKind>>,
  storageIdPaths: Map<string, CompiledStorageIdPaths>,
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
) {
  return (definition: {
    args?: PropertyValidators | GenericValidator;
    returns?: PropertyValidators | GenericValidator;
    handler: (ctx: EmbeddedMutationCtx<any>, args: Record<string, unknown>) => unknown;
  }) => {
    const args = asObjectValidator(definition.args ?? {}) as VObject<
      Record<string, unknown>,
      Record<string, GenericValidator>
    >;
    const registered = base({
      args,
      returns: mutationReturnsValidator(definition.returns) as never,
      handler: async (ctx: GenericMutationCtx<any>, received: Record<string, unknown>) => {
        const capture = new WriteCapture(
          ctx.db,
          tableNames,
          crdtFields,
          storageIdPaths,
          placements,
        );
        const metadata = await ctx.meta.getFunctionMetadata();
        const functionName = metadata.name;
        if (metadata.visibility !== "public") {
          return await definition.handler(
            hostedIntentCtx(ctx, capture.db, tableNames, placements, manifest),
            received,
          );
        }
        const identity = await identityAttributeOf(ctx);
        const { requestId } = await ctx.meta.getRequestMetadata();
        const replay = (await ctx.runMutation(component.protocol.replayConsume, {
          requestId,
          functionName,
        })) as ReplayEnvelope | null;
        if (!replay) {
          return await definition.handler(
            hostedIntentCtx(ctx, capture.db, tableNames, placements, manifest),
            received,
          );
        }

        assertRuntimeVersion(replay.runtime);
        const authoredArgs = received;
        const fingerprint = replay.fingerprint;
        const witnessState = await inspectWitnesses(
          ctx,
          tableNames,
          crdtFields,
          replay.reads,
          placements,
        );
        const mutationId = replay.mutationId;
        const clientId = replay.clientId;
        const effects = new EffectCursor(capture, replay.crdt, crdtFields);
        const schedules = new ScheduleCapture(ctx.scheduler, mutationId, replay.schedules);
        const uploads = new UploadCapture(ctx.storage, mutationId, replay.uploads);
        const db = effects.writer();
        const revisions = new RevisionCapture(
          capture,
          ctx.runMutation.bind(ctx) as RevisionRunMutation,
          ctx.runQuery.bind(ctx) as RevisionRunQuery,
          component,
          replay,
          tableNames,
          placements,
          manifest,
        );
        const appCtx = {
          ...ctx,
          db,
          runQuery: replicatedMutationQuery(ctx, tableNames, placements, manifest),
          runMutation: revisions.runMutation,
          scheduler: schedules.writer(),
          storage: uploads.writer(),
        } as EmbeddedMutationCtx<any>;
        let result: unknown;
        try {
          result = await withEntropy(replay.mutationTime, replay.randomSeed, () =>
            definition.handler(appCtx, authoredArgs),
          );
        } catch (error) {
          if (embeddedFailure(error) !== null) throw error;
          throw replayFailure(
            "EMBEDDED_REJECTED",
            [],
            error instanceof Error ? error.message : String(error),
          );
        }
        effects.finish();
        schedules.finish();
        uploads.finish();
        await revisions.finish();
        const changes = await capture.changes();
        const changedTargets = changes.map(({ table, rowId }) => ({ table, rowId }));
        const crdtOnlyRows = capture.crdtOnlyRows();
        const authoritative = changes.filter(
          (change) => !crdtOnlyRows.has(`${change.table}\u0000${change.rowId}`),
        );
        if (replay) {
          const normalizedResult = normalizeMutationResult(
            result ?? null,
            mutationId,
            capture.inserts(),
            schedules.ids(),
            uploads.urls(),
            validatorIdReferences(definition.returns, result),
            {},
            new Map(Array.from(crdtFields, ([table, fields]) => [table, new Set(fields.keys())])),
            validatorIdValues(definition.args, authoredArgs),
          );
          const authoritativeResultHash = await hashValue(normalizedResult);
          if (authoritativeResultHash !== replay.resultHash) {
            throw replayFailure(
              witnessState.conflict ? "EMBEDDED_CONFLICT" : "EMBEDDED_DIVERGENCE",
              changes,
            );
          }
        }
        assertExpectedInserts(replay.mutationId, replay.inserts, capture.inserts());
        const settlement = {
          mutationId,
          outcome: "applied" as const,
          result: result ?? null,
          inserts: capture.inserts(),
          schedules: schedules.settled(),
          uploads: uploads.settled(),
          revisions: [],
        };
        const committed = (await ctx
          .runMutation(component.protocol.commit, {
            request: {
              kind: "apply",
              clientId,
              replayId: replay.replayId,
              fingerprint,
              logicalFingerprint: replay.logicalFingerprint,
              runtime: replay.runtime,
              ...(identity === null ? {} : { identity }),
              acknowledgeReplayId: replay.acknowledgeReplayId,
              verification: witnessState.unsupported
                ? { kind: "unsupported" }
                : witnessState.conflict
                  ? { kind: "conflict", targets: changedTargets }
                  : {
                      kind: "ready",
                      witnesses: witnessState.crdt.filter(
                        ({ table, rowId }) => !revisions.hasRestore(table, rowId),
                      ),
                    },
              settlement,
              changes: authoritative,
              crdt: effects.all(),
              files: await capture.files(),
            },
          })
          .catch(async (error: unknown) => {
            const failure = componentFailure(error);
            if (!failure) throw error;
            throw replayFailure(failure.code, failure.targets);
          })) as Settlement;
        return { kind: "embeddedReplay", result: result ?? null, settlement: committed };
      },
    } as never) as RegisteredMutation<any, any, any> & EmbeddedRegisteredFunction;
    registered.__embeddedHandler =
      definition.handler as EmbeddedRegisteredFunction["__embeddedHandler"];
    registered.__embeddedPlacement = "replicated";
    return registered;
  };
}

const opaqueBytesValidator = v.union(
  v.object({ kind: v.literal("inline"), bytes: v.bytes(), hash: v.string() }),
  v.object({
    kind: v.literal("staged"),
    blobId: v.string(),
    bytes: v.number(),
    hash: v.string(),
  }),
);

const insertRefValidator = v.object({
  mutationId: v.string(),
  ordinal: v.number(),
  table: v.string(),
});

const scheduleRefValidator = v.object({
  mutationId: v.string(),
  ordinal: v.number(),
});

const argRefValidator = v.union(
  v.object({ path: v.string(), insert: insertRefValidator }),
  v.object({ path: v.string(), schedule: scheduleRefValidator }),
);

const readBoundValidator = v.object({
  field: v.string(),
  value: v.any(),
  inclusive: v.boolean(),
  commitTs: v.optional(v.literal(true)),
});
const readWitnessValidator = v.union(
  v.object({
    kind: v.literal("point"),
    table: v.string(),
    rowId: v.string(),
    plainHash: v.string(),
    crdt: v.array(
      v.object({
        field: v.string(),
        epoch: v.number(),
        headSeq: v.number(),
        projectionHash: v.string(),
      }),
    ),
  }),
  v.object({
    kind: v.literal("range"),
    table: v.string(),
    index: v.string(),
    equality: v.array(
      v.object({ field: v.string(), value: v.any(), commitTs: v.optional(v.literal(true)) }),
    ),
    limit: v.optional(v.number()),
    lower: v.optional(readBoundValidator),
    upper: v.optional(readBoundValidator),
    order: v.union(v.literal("asc"), v.literal("desc")),
    membersHash: v.string(),
  }),
);

const replayValidator = v.object({
  clientId: v.string(),
  mutationId: v.string(),
  replayId: v.string(),
  logicalFingerprint: v.string(),
  acknowledgeReplayId: v.optional(v.string()),
  runtime: v.object({
    schemaHash: v.string(),
    moduleGraphHash: v.string(),
    protocolVersion: v.number(),
  }),
  resultHash: v.string(),
  mutationTime: v.number(),
  randomSeed: v.string(),
  argRefs: v.array(argRefValidator),
  inserts: v.array(insertRefValidator),
  reads: v.array(readWitnessValidator),
  schedules: v.array(scheduleRefValidator),
  uploads: v.array(v.object({ mutationId: v.string(), ordinal: v.number() })),
  crdt: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      field: v.string(),
      kind: v.union(v.literal("text"), v.literal("count"), v.literal("set")),
      baseSeq: v.number(),
      projection: v.any(),
      projectionHash: v.string(),
      payload: v.bytes(),
      checkpoint: v.optional(v.object({ throughSeq: v.number(), content: opaqueBytesValidator })),
    }),
  ),
  revisionCheckpoints: v.array(
    v.object({
      ordinal: v.number(),
      operation: v.union(v.literal("create"), v.literal("retain")),
      table: v.string(),
      snapshots: v.array(
        v.object({
          field: v.string(),
          kind: v.union(v.literal("text"), v.literal("count"), v.literal("set")),
          headSeq: v.number(),
          projectionHash: v.string(),
          bytes: v.bytes(),
          hash: v.string(),
        }),
      ),
    }),
  ),
});

const settlementFields = {
  mutationId: v.string(),
  inserts: v.array(v.object({ ordinal: v.number(), table: v.string(), id: v.string() })),
  schedules: v.array(v.object({ ordinal: v.number(), id: v.string() })),
  uploads: v.array(v.object({ ordinal: v.number(), url: v.string() })),
  revisions: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      revId: v.string(),
    }),
  ),
  crdt: v.array(
    v.object({
      table: v.string(),
      rowId: v.string(),
      field: v.string(),
      kind: v.union(v.literal("text"), v.literal("count"), v.literal("set")),
      headSeq: v.number(),
      projectionHash: v.string(),
    }),
  ),
  authoritative: v.array(
    v.union(
      v.object({
        op: v.literal("put"),
        table: v.string(),
        rowId: v.string(),
        fields: v.any(),
        plainHash: v.string(),
      }),
      v.object({
        op: v.literal("del"),
        table: v.string(),
        rowId: v.string(),
        plainHash: v.string(),
      }),
    ),
  ),
};

const conflictSettlementErrorValidator = v.object({ code: v.literal("EMBEDDED_CONFLICT") });
const rejectedSettlementErrorValidator = v.object({
  code: v.union(v.literal("EMBEDDED_REJECTED"), v.literal("EMBEDDED_DIVERGENCE")),
});
const rebaseSettlementErrorValidator = v.object({ code: v.literal("EMBEDDED_REBASE") });

const settlementValidator = v.union(
  v.object({ ...settlementFields, outcome: v.literal("applied"), result: v.any() }),
  v.object({
    ...settlementFields,
    outcome: v.literal("conflict"),
    error: conflictSettlementErrorValidator,
  }),
  v.object({
    ...settlementFields,
    outcome: v.literal("rejected"),
    error: rejectedSettlementErrorValidator,
  }),
  v.object({
    ...settlementFields,
    outcome: v.literal("rebase"),
    error: rebaseSettlementErrorValidator,
  }),
);

// Wire 26 treated a failed settlement's `error` field as opaque. Its Rust decoder checks only the
// terminal outcome, while v27 requires the closed code above. Keep this adapter-only validator at
// the public response boundary; component records remain canonicalized before they are returned.
const legacySettlementValidator = v.union(
  v.object({ ...settlementFields, outcome: v.literal("conflict"), error: v.any() }),
  v.object({ ...settlementFields, outcome: v.literal("rejected"), error: v.any() }),
  v.object({ ...settlementFields, outcome: v.literal("rebase"), error: v.any() }),
);

const wireSettlementValidator = v.union(settlementValidator, legacySettlementValidator);

type RevisionRunMutation = (
  ref: FunctionReference<
    "mutation",
    "public" | "internal",
    Record<string, unknown>,
    unknown,
    string | undefined
  >,
  args: Record<string, unknown>,
) => Promise<unknown>;

type RevisionRunQuery = (
  ref: FunctionReference<
    "query",
    "public" | "internal",
    Record<string, unknown>,
    unknown,
    string | undefined
  >,
  args: Record<string, unknown>,
) => Promise<unknown>;

type RevisionExpectation = {
  table: string;
  rowId: string;
  deleted: boolean;
  value?: Record<string, unknown>;
};

class RevisionCapture {
  private readonly expectations: RevisionExpectation[] = [];
  private readonly createReplay: Parameters<RevisionRunMutation>[0];
  private readonly checkpointWrite: Parameters<RevisionRunMutation>[0];
  private readonly checkpoints = new Map<number, RevisionCheckpoint>();
  private nextCheckpointOrdinal = 0;
  private nextOrdinal = 0;
  private readonly prefix: string;
  private readonly get: Parameters<RevisionRunQuery>[0];
  private readonly retain: Parameters<RevisionRunMutation>[0];

  constructor(
    private readonly capture: WriteCapture,
    private readonly invoke: RevisionRunMutation,
    private readonly inspect: RevisionRunQuery,
    component: EmbeddedComponent,
    private readonly replay: ReplayEnvelope | null,
    private readonly tableNames: string[],
    private readonly placements: EmbeddedSchemaPlacements,
    private readonly manifest?: FunctionManifest,
  ) {
    const create = component.rev.create as Parameters<RevisionRunMutation>[0];
    const path = referencePath(create);
    if (!path?.endsWith("/rev/create")) {
      throw new Error("Embedded revision component reference is malformed.");
    }
    this.prefix = path.slice(0, -"/rev/create".length);
    this.get = component.rev.get as Parameters<RevisionRunQuery>[0];
    this.createReplay = (
      component.rev as unknown as Record<string, Parameters<RevisionRunMutation>[0]>
    ).createReplay;
    this.checkpointWrite = (
      component.rev as unknown as Record<string, Parameters<RevisionRunMutation>[0]>
    ).checkpointWrite;
    this.retain = (
      component.rev as unknown as Record<string, Parameters<RevisionRunMutation>[0]>
    ).retain;
    for (const checkpoint of replay?.revisionCheckpoints ?? []) {
      if (this.checkpoints.has(checkpoint.ordinal)) {
        throw new Error(`Duplicate revision checkpoint ordinal ${checkpoint.ordinal}.`);
      }
      this.checkpoints.set(checkpoint.ordinal, checkpoint);
    }
  }

  readonly runMutation: RevisionRunMutation = async (ref, args) => {
    const operation = this.operation(ref);
    if (operation === "create") {
      const current = await this.current(args);
      const requested = this.project(revisionExpectation(args));
      if (!sameRevisionValue(current, requested)) {
        throw new Error("rev.create must match the document visible in the current transaction.");
      }
      const ordinal = this.nextOrdinal;
      const replay = this.replay
        ? {
            createdAt: this.replay.mutationTime,
            mutationId: this.replay.mutationId,
            ordinal,
          }
        : undefined;
      this.nextOrdinal += 1;
      await this.stage("create", requested);
      const result = await this.invoke(replay ? this.createReplay : ref, {
        ...revisionArgs(args, requested),
        ...(replay ? { replay } : {}),
      });
      return this.projectResult(result);
    }
    if (operation === "retain") {
      const requested = this.project(revisionExpectation(args));
      await this.stage("retain", requested);
      return this.projectResult(await this.invoke(ref, revisionArgs(args, requested)));
    }
    if (operation === undefined) {
      if (!isEmbeddedComponentReference(ref)) {
        assertReplicatedReference(this.manifest, ref, "mutation");
        throw new Error(
          "Embedded replicated mutations cannot call nested app mutations until their writes can join the parent replay capture.",
        );
      }
      return await this.invoke(ref, args);
    }
    if (operation !== "restore") return await this.invoke(ref, args);

    const displaced = await this.current(args);
    const selected = this.projectResult(await this.inspect(this.get, args));
    if (selected === null) throw new Error("Revision not found.");
    const target = revisionExpectation(selected as Record<string, unknown>);
    if (!sameRevisionValue(displaced, target)) {
      await this.stage("retain", displaced);
      await this.invoke(this.retain, { ...displaced, origin: "displaced" });
    }
    const result = this.projectResult(await this.invoke(ref, args));
    this.capture.revisionRestore(target);
    this.expectations.push(target);
    return result;
  };

  private project(revision: RevisionExpectation): RevisionExpectation {
    if (revision.deleted) return revision;
    if (!this.tableNames.includes(revision.table)) {
      throw new Error(
        `Replicated functions cannot access revisions for non-replicated table ${revision.table}.`,
      );
    }
    return {
      ...revision,
      value: projectWireDoc(this.placements, revision.table, revision.value ?? {}),
    };
  }

  private projectResult(result: unknown): unknown {
    return projectRevision(this.placements, this.tableNames, result);
  }

  async finish(): Promise<void> {
    if (this.checkpoints.size > 0) {
      throw new Error("Mutation carried unconsumed revision checkpoints.");
    }
    for (const expectation of this.expectations) {
      const current = await this.current(expectation);
      if (!sameRevisionValue(current, expectation)) {
        throw new Error(
          expectation.deleted
            ? "rev.restore must be followed by the matching document delete."
            : "rev.restore must be followed by the matching document replace.",
        );
      }
    }
  }

  hasRestore(table: string, rowId: string): boolean {
    return this.expectations.some(
      (expectation) => expectation.table === table && expectation.rowId === rowId,
    );
  }

  private operation(ref: Parameters<RevisionRunMutation>[0]): string | undefined {
    const path = referencePath(ref);
    const prefix = `${this.prefix}/rev/`;
    return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  private async current(args: Record<string, unknown>): Promise<RevisionExpectation> {
    const table = String(args.table);
    const rowId = String(args.rowId);
    const current = (await this.capture.db.get(rowId as never)) as Record<string, unknown> | null;
    return current === null
      ? { table, rowId, deleted: true }
      : { table, rowId, deleted: false, value: withoutSystemFields(current) };
  }

  private async stage(
    operation: RevisionCheckpoint["operation"],
    revision: RevisionExpectation,
  ): Promise<void> {
    if (!this.replay) return;
    const ordinal = this.nextCheckpointOrdinal;
    this.nextCheckpointOrdinal += 1;
    const checkpoint = this.checkpoints.get(ordinal);
    if (!checkpoint) throw new Error(`Missing revision checkpoint ordinal ${ordinal}.`);
    this.checkpoints.delete(ordinal);
    if (checkpoint.operation !== operation) {
      throw new Error(`Revision checkpoint ${ordinal} has the wrong operation.`);
    }
    if (checkpoint.table !== revision.table) {
      throw new Error(`Revision checkpoint ${ordinal} targets the wrong table.`);
    }
    if (revision.deleted && checkpoint.snapshots.length > 0) {
      throw new Error("A deleted revision cannot carry CRDT checkpoints.");
    }
    if (checkpoint.snapshots.length > 1_024) {
      throw new Error("Revision has too many CRDT fields.");
    }
    const fields = new Set<string>();
    for (const snapshot of checkpoint.snapshots) {
      if (fields.has(snapshot.field)) {
        throw new Error(`Duplicate revision checkpoint field ${snapshot.field}.`);
      }
      fields.add(snapshot.field);
      if (
        snapshot.projectionHash !== (await hashValue(valueAtPath(revision.value, snapshot.field)))
      ) {
        throw new Error(`Revision checkpoint projection does not match ${snapshot.field}.`);
      }
    }
    await this.invoke(this.checkpointWrite, {
      table: revision.table,
      rowId: revision.rowId,
      snapshots: checkpoint.snapshots,
    });
  }
}

const TO_REFERENCE_PATH = Symbol.for("toReferencePath");

function referencePath(ref: unknown): string | undefined {
  if (typeof ref !== "object" || ref === null) return undefined;
  const path = (ref as Record<PropertyKey, unknown>)[TO_REFERENCE_PATH];
  return typeof path === "string" ? path : undefined;
}

function revisionExpectation(args: Record<string, unknown>): RevisionExpectation {
  return {
    table: String(args.table),
    rowId: String(args.rowId),
    deleted: args.deleted === true,
    ...(args.deleted === true ? {} : { value: args.value as Record<string, unknown> }),
  };
}

function revisionArgs(
  args: Record<string, unknown>,
  revision: RevisionExpectation,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...args,
    table: revision.table,
    rowId: revision.rowId,
  };
  if (revision.deleted) {
    delete projected.value;
  } else {
    projected.value = revision.value;
  }
  return projected;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function withoutSystemFields(document: Record<string, unknown>): Record<string, unknown> {
  const { _id, _creationTime, ...value } = document;
  return value;
}

function sameRevisionValue(left: RevisionExpectation, right: RevisionExpectation): boolean {
  return (
    left.table === right.table &&
    left.rowId === right.rowId &&
    left.deleted === right.deleted &&
    (left.deleted || canonicalJson(left.value) === canonicalJson(right.value))
  );
}

const runtimeRequestValidator = v.object({
  schemaHash: v.string(),
  moduleGraphHash: v.string(),
  protocolVersion: v.number(),
});

const pullRequestValidator = v.union(
  v.object({
    kind: v.literal("identity"),
    // Omission is the frozen Preview 2 identity request shape and selects wire 26. Current
    // clients advertise their complete discrete set so this deployment can select wire 27.
    protocolVersions: v.optional(v.array(v.number())),
  }),
  v.object({
    kind: v.literal("live"),
    functionName: v.string(),
    args: v.any(),
    runtime: runtimeRequestValidator,
  }),
  v.object({
    kind: v.literal("checkpoint"),
    functionName: v.string(),
    args: v.any(),
    runtime: runtimeRequestValidator,
    table: v.string(),
    rowId: v.string(),
    field: v.string(),
    checkpointId: v.string(),
    epoch: v.number(),
    headSeq: v.number(),
    cursor: v.union(v.string(), v.null()),
  }),
  v.object({
    kind: v.literal("cursor"),
    functionName: v.string(),
    args: v.any(),
    runtime: runtimeRequestValidator,
    path: v.string(),
    boundary: v.object({
      rowId: v.string(),
      values: v.array(
        v.union(
          v.object({ field: v.string(), value: v.any() }),
          v.object({ field: v.string(), missing: v.literal(true) }),
        ),
      ),
    }),
    cursor: v.union(v.string(), v.null()),
  }),
);

const pushRequestValidator = v.union(
  v.object({
    kind: v.literal("mutation"),
    functionName: v.string(),
    args: v.any(),
    afterImages: v.array(
      v.union(
        v.object({
          content: v.literal("value"),
          table: v.string(),
          rowId: v.string(),
          value: v.any(),
        }),
        v.object({
          content: v.literal("deleted"),
          table: v.string(),
          rowId: v.string(),
        }),
      ),
    ),
    ...replayValidator.fields,
  }),
  v.object({
    kind: v.literal("acknowledge"),
    clientId: v.string(),
    replayId: v.string(),
  }),
  v.object({
    kind: v.literal("blob"),
    clientId: v.string(),
    runtime: runtimeRequestValidator,
    hash: v.string(),
    bytes: v.number(),
    chunks: v.number(),
    ordinal: v.number(),
    chunk: v.bytes(),
    chunkHash: v.string(),
  }),
  v.object({
    kind: v.literal("checkpoint"),
    clientId: v.string(),
    runtime: runtimeRequestValidator,
    checkpointId: v.string(),
    responseToken: v.string(),
    throughSeq: v.number(),
    projectionHash: v.string(),
    content: opaqueBytesValidator,
  }),
);

function buildPull(component: EmbeddedComponent, manifest?: FunctionManifest) {
  return queryGeneric({
    args: { request: pullRequestValidator },
    returns: v.union(
      v.object({
        identity: v.any(),
        identityKey: v.optional(v.string()),
        protocolVersion: v.number(),
      }),
      v.object({
        members: v.array(v.object({ table: v.string(), rowId: v.string() })),
        changes: v.array(pullChangeValidator),
        crdt: v.array(pullCrdtValidator),
        result: v.any(),
        resultRows: v.array(resultRowValidator),
      }),
      v.object({
        checkpoint: v.object({
          id: v.string(),
          seq: v.number(),
          bytes: v.number(),
          hash: v.string(),
        }),
        headSeq: v.number(),
        chunks: v.array(v.object({ ordinal: v.number(), bytes: v.bytes(), hash: v.string() })),
        payloads: v.array(v.object({ seq: v.number(), bytes: v.bytes(), hash: v.string() })),
        continueCursor: v.union(v.string(), v.null()),
        isDone: v.boolean(),
      }),
      v.object({ kind: v.literal("stale") }),
      v.object({
        found: v.boolean(),
        cursor: v.union(v.string(), v.null()),
        isDone: v.boolean(),
      }),
    ),
    handler: async (ctx, { request: args }) => {
      if (args.kind === "identity") {
        const protocolVersion = selectEmbeddedProtocolVersion(args.protocolVersions);
        if (protocolVersion === undefined) {
          throw new ConvexError({
            code: EMBEDDED_PROTOCOL_MISMATCH,
            expected: [EMBEDDED_PROTOCOL_LEGACY_VERSION, EMBEDDED_PROTOCOL_VERSION],
            message: "Embedded identity request has no supported protocol version.",
            received: args.protocolVersions,
          });
        }
        const identity = await ctx.auth.getUserIdentity();
        return {
          identity,
          ...(identity ? { identityKey: await hashValue(identity.tokenIdentifier) } : {}),
          protocolVersion,
        };
      }
      assertRuntimeVersion(args.runtime);
      assertReplicatedTarget(manifest, args.functionName, "query");
      if (args.kind === "cursor") {
        const queryArgs = paginationArgs(args.args, args.path, args.cursor);
        const { result, rows } = await invokeQueryCapture(
          ctx,
          component,
          args.functionName,
          queryArgs,
        );
        const page = paginationResult(result);
        const row = page.page[0];
        if (row && !rows.some((member) => member.rowId === row._id)) {
          throw new Error("Embedded cursor result is outside captured query membership.");
        }
        return {
          found: row !== undefined && cursorBoundaryMatches(row, args.boundary),
          cursor: page.continueCursor,
          isDone: page.isDone,
        };
      }
      const { result, rows } = await invokeQueryCapture(
        ctx,
        component,
        args.functionName,
        args.args,
      );
      if (args.kind === "checkpoint") {
        if (!rows.some((row) => row.table === args.table && row.rowId === args.rowId)) {
          throw new Error("Embedded checkpoint row is no longer authorized by the app query.");
        }
        return await ctx.runQuery(component.protocol.checkpointRead, {
          table: args.table,
          rowId: args.rowId,
          field: args.field,
          checkpointId: args.checkpointId as never,
          epoch: args.epoch,
          headSeq: args.headSeq,
          cursor: args.cursor,
        });
      }
      return await completeQueryRows(ctx, component, args.runtime, rows, result);
    },
  });
}

function cursorBoundaryMatches(
  row: { _id: string },
  boundary: {
    rowId: string;
    values: Array<{ field: string; value: unknown } | { field: string; missing: true }>;
  },
): boolean {
  if (row._id !== boundary.rowId) return false;
  return boundary.values.every((expected) => {
    const actual = valueAtPath(row, expected.field);
    return "missing" in expected
      ? actual === undefined
      : canonicalJson(actual) === canonicalJson(expected.value);
  });
}

function paginationArgs(args: unknown, path: string, cursor: string | null) {
  const value = structuredClone(args);
  const segments = jsonPointerSegments(path);
  if (segments.at(-1) !== "cursor") {
    throw new Error("Embedded cursor resolution path must address pagination cursor.");
  }
  let parent: unknown = value;
  for (const segment of segments.slice(0, -1)) {
    if (parent === null || typeof parent !== "object") {
      throw new Error("Embedded cursor resolution path is missing.");
    }
    parent = Array.isArray(parent)
      ? parent[Number(segment)]
      : (parent as Record<string, unknown>)[segment];
  }
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    throw new Error("Embedded cursor resolution target is not pagination options.");
  }
  const pagination = parent as Record<string, unknown>;
  if (typeof pagination.numItems !== "number") {
    throw new Error("Embedded cursor resolution requires standard pagination options.");
  }
  pagination.cursor = cursor;
  pagination.numItems = 1;
  return value;
}

function paginationResult(result: unknown): {
  page: Array<{ _id: string }>;
  continueCursor: string;
  isDone: boolean;
} {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Embedded cursor target must return a pagination result.");
  }
  const value = result as Record<string, unknown>;
  if (
    !Array.isArray(value.page) ||
    value.page.length > 1 ||
    typeof value.continueCursor !== "string" ||
    typeof value.isDone !== "boolean" ||
    value.page.some((row) => row === null || typeof row !== "object" || typeof row._id !== "string")
  ) {
    throw new Error("Embedded cursor target changed the standard pagination result.");
  }
  return value as {
    page: Array<{ _id: string }>;
    continueCursor: string;
    isDone: boolean;
  };
}

function jsonPointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) throw new Error("Invalid Embedded JSON pointer.");
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function buildPush(
  component: EmbeddedComponent,
  tableNames: string[],
  crdtFields: Map<string, Map<string, CrdtKind>>,
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
) {
  return mutationGeneric({
    args: { request: pushRequestValidator },
    returns: v.union(wireSettlementValidator, v.null()),
    handler: async (ctx, { request: args }): Promise<WireSettlement | null> => {
      if (args.kind === "acknowledge") {
        const identity = await identityAttributeOf(ctx);
        await ctx.runMutation(component.protocol.acknowledge, {
          replayId: args.replayId,
          ...(identity === null ? {} : { identity }),
        });
        return null;
      }
      const wire = assertRuntimeVersion(args.runtime);
      if (args.kind === "mutation") {
        const identity = await identityAttributeOf(ctx);
        const { requestId } = await ctx.meta.getRequestMetadata();
        const fingerprint = await hashValue({
          functionName: args.functionName,
          args: args.args,
          resultHash: args.resultHash,
          argRefs: args.argRefs,
          inserts: args.inserts,
          reads: args.reads,
          mutationTime: args.mutationTime,
          randomSeed: args.randomSeed,
          schedules: args.schedules,
          uploads: args.uploads,
          crdt: args.crdt,
          revisionCheckpoints: args.revisionCheckpoints,
          afterImages: args.afterImages,
        });
        const logicalFingerprint = await hashValue({
          functionName: args.functionName,
          args: args.args,
          argRefs: args.argRefs,
        });
        const prior = (await ctx.runMutation(component.protocol.replayWrite, {
          tokenHash: await hashValue({ requestId, functionName: args.functionName }),
          kind: "push",
          clientId: args.clientId,
          ...(identity === null ? {} : { identity }),
          requestId,
          functionName: args.functionName,
          mutationId: args.mutationId,
          replayId: args.replayId,
          fingerprint,
          logicalFingerprint,
          resultHash: args.resultHash,
          mutationTime: args.mutationTime,
          randomSeed: args.randomSeed,
          reads: args.reads,
          inserts: args.inserts,
          schedules: args.schedules,
          uploads: args.uploads,
          crdt: args.crdt,
          revisionCheckpoints: args.revisionCheckpoints,
          runtime: args.runtime,
          acknowledgeReplayId: args.acknowledgeReplayId,
          expiresAt: readTime() + REPLAY_TTL_MS,
        })) as Settlement | null;
        if (prior) {
          return encodeSettlement(
            wire,
            normalizeSettlement(
              await refreshAppliedSettlement(ctx, prior, tableNames, crdtFields, placements),
            ),
          );
        }

        const target = makeFunctionReference<"mutation", Record<string, unknown>, unknown>(
          args.functionName,
        );
        try {
          // Every deterministic per-envelope validation belongs inside the settlement boundary.
          // Otherwise a renamed function or narrowed after-image escapes as a transport error and
          // can poison the device's entire push lane instead of durably rejecting this mutation.
          assertReplicatedTarget(manifest, args.functionName, "mutation");
          assertWireAfterImages(args.afterImages, placements);
          const authoredArgs = (await resolveArgRefs(
            ctx,
            component,
            args.clientId,
            args.args,
            args.argRefs,
          )) as Record<string, unknown>;
          const result = await ctx.runMutation(target, authoredArgs);
          if (!isEmbeddedReplayResult(result)) {
            throw new ConvexError({
              code: "EMBEDDED_INELIGIBLE_FUNCTION",
              message: "Only mutations created by defineEmbedded can be replayed.",
            });
          }
          return encodeSettlement(wire, normalizeSettlement(result.settlement));
        } catch (error) {
          // A function removed or narrowed by a later deployment fails before its embedded wrapper
          // can translate the error. Convex has already retried internal mutation failures before
          // surfacing an error here, so the durable envelope must settle instead of poisoning the
          // device's push lane forever.
          const failure = embeddedFailure(error) ?? {
            code: "EMBEDDED_REJECTED" as const,
            targets: [],
            reason: error instanceof Error ? error.message : String(error),
          };
          const outcome =
            failure.code === "EMBEDDED_CONFLICT"
              ? "conflict"
              : failure.code === "EMBEDDED_REBASE"
                ? "rebase"
                : "rejected";
          const targets = outcome === "rejected" ? [] : uniqueTargets(failure.targets);
          const changes = await authoritativeChanges(
            ctx,
            targets,
            tableNames,
            crdtFields,
            placements,
          );
          const targetKeys = new Set(targets.map(({ table, rowId }) => `${table}\u0000${rowId}`));
          const revisions: RevisionCandidate[] =
            outcome === "rebase"
              ? []
              : await divergentRevisionCandidates(
                  args.afterImages.filter((candidate) =>
                    targetKeys.has(`${candidate.table}\u0000${candidate.rowId}`),
                  ),
                  changes,
                  crdtFields,
                );
          const settlement = failureSettlement(args.mutationId, failure.code);
          return encodeSettlement(
            wire,
            normalizeSettlement(
              (await ctx.runMutation(component.protocol.commit, {
                request: {
                  kind: "failure",
                  clientId: args.clientId,
                  replayId: args.replayId,
                  fingerprint,
                  logicalFingerprint,
                  runtime: args.runtime,
                  ...(identity === null ? {} : { identity }),
                  acknowledgeReplayId: args.acknowledgeReplayId,
                  settlement,
                  changes,
                  revisions,
                },
              })) as Settlement,
            ),
          );
        }
      }
      if (args.kind === "blob") {
        await ctx.runMutation(component.protocol.blobWrite, {
          hash: args.hash,
          bytes: args.bytes,
          chunks: args.chunks,
          ordinal: args.ordinal,
          chunk: args.chunk,
          chunkHash: args.chunkHash,
        });
        return null;
      }
      if (args.kind === "checkpoint") {
        await ctx.runMutation(component.protocol.checkpointWrite, {
          checkpointId: args.checkpointId,
          responseToken: args.responseToken,
          throughSeq: args.throughSeq,
          projectionHash: args.projectionHash,
          content: args.content,
        });
        return null;
      }
      throw new Error("Unknown Embedded protocol push.");
    },
  });
}

/**
 * Normalize a cached v26 failure at the v27 server response boundary.
 *
 * Historic component rows may contain an arbitrary `error` object and reason text. Their exact
 * payload is never forwarded: the outcome determines conflict/rebase, while rejected preserves
 * only the one safe legacy distinction (`EMBEDDED_DIVERGENCE`). New records already use this
 * shape, so the same boundary guarantees every Rust client receives the closed form.
 */
function normalizeSettlement(settlement: Settlement): Settlement {
  switch (settlement.outcome) {
    case "applied":
      return settlement;
    case "conflict":
      return { ...settlement, error: { code: "EMBEDDED_CONFLICT" } };
    case "rebase":
      return { ...settlement, error: { code: "EMBEDDED_REBASE" } };
    case "rejected": {
      const legacyCode = readSettlementErrorCode(settlement.error);
      return {
        ...settlement,
        error: {
          code: legacyCode === "EMBEDDED_DIVERGENCE" ? "EMBEDDED_DIVERGENCE" : "EMBEDDED_REJECTED",
        },
      };
    }
  }
}

/**
 * Encode a canonical settlement at the only v26/v27 response seam.
 *
 * Preview 2's decoder required an `error` field but deliberately treated it as opaque. Sending
 * `null` preserves its terminal outcome without making the v27 closed failure-code contract part
 * of the old wire. Wire 27 receives the normalized structured error above.
 */
function encodeSettlement(wire: EmbeddedProtocolVersion, settlement: Settlement): WireSettlement {
  if (wire === EMBEDDED_PROTOCOL_VERSION) return settlement;
  if (settlement.outcome === "applied") return settlement;
  return { ...settlement, error: null };
}

function failureSettlement(mutationId: string, code: ReplayFailureCode): FailureSettlementInput {
  const base = {
    mutationId,
    inserts: [],
    schedules: [],
    uploads: [],
    revisions: [],
  };
  switch (code) {
    case "EMBEDDED_CONFLICT":
      return { ...base, outcome: "conflict", error: { code } };
    case "EMBEDDED_REBASE":
      return { ...base, outcome: "rebase", error: { code } };
    case "EMBEDDED_DIVERGENCE":
    case "EMBEDDED_REJECTED":
      return { ...base, outcome: "rejected", error: { code } };
  }
}

function readSettlementErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function assertWireAfterImages(
  candidates: RevisionCandidate[],
  placements: EmbeddedSchemaPlacements,
): void {
  const replicated = new Set(placements.replicatedTables);
  for (const candidate of candidates) {
    if (!replicated.has(candidate.table)) {
      throw new ConvexError({
        code: "EMBEDDED_AFTER_IMAGE",
        message: `After-image addresses non-replicated table ${candidate.table}.`,
      });
    }
    if (
      candidate.content === "value" &&
      canonicalJson(
        projectWireDoc(placements, candidate.table, candidate.value as Record<string, unknown>),
      ) !== canonicalJson(candidate.value)
    ) {
      throw new ConvexError({
        code: "EMBEDDED_AFTER_IMAGE",
        message: `After-image contains non-replicated fields for ${candidate.table}.`,
      });
    }
  }
}

function mutationReturnsValidator(returns: PropertyValidators | GenericValidator | undefined) {
  if (returns === undefined) return undefined;
  return v.union(
    asObjectValidator(returns),
    v.object({
      kind: v.literal("embeddedReplay"),
      result: v.any(),
      settlement: settlementValidator,
    }),
  );
}

class WriteCapture {
  private readonly touched = new Map<
    string,
    {
      table: string;
      id: string;
      inserted: boolean;
      before: Record<string, unknown> | null;
      plain: boolean;
    }
  >();
  private readonly insertOrder: Array<{ table: string; id: string }> = [];
  private readonly restoreGrants = new Map<string, RevisionExpectation>();
  readonly db: GenericDatabaseWriter<any>;

  constructor(
    private readonly real: GenericDatabaseWriter<any>,
    private readonly tableNames: string[],
    private readonly crdtFields: Map<string, Map<string, CrdtKind>>,
    private readonly storageIdPaths: Map<string, CompiledStorageIdPaths>,
    private readonly placements: EmbeddedSchemaPlacements,
  ) {
    this.db = this.writer();
  }

  inserts(): Array<{ ordinal: number; table: string; id: string }> {
    return this.insertOrder.map((insert, ordinal) => ({ ordinal, ...insert }));
  }

  revisionRestore(expectation: RevisionExpectation): void {
    this.restoreGrants.set(`${expectation.table}\u0000${expectation.rowId}`, expectation);
  }

  async changes() {
    const changes: Array<
      | { op: "put"; table: string; rowId: string; fields: unknown; contentHash: string }
      | { op: "del"; table: string; rowId: string; contentHash: string }
    > = [];
    for (const touched of this.touched.values()) {
      const row = await (this.real as any).get(touched.table, touched.id);
      if (row === null) {
        if (touched.inserted) continue;
        changes.push({
          op: "del",
          table: touched.table,
          rowId: touched.id,
          contentHash: await hashValue(null),
        });
      } else {
        const wire = projectWireDoc(this.placements, touched.table, row);
        changes.push({
          op: "put",
          table: touched.table,
          rowId: touched.id,
          fields: wire,
          contentHash: await hashDocument(wire, this.crdtFields.get(touched.table)?.keys()),
        });
      }
    }
    return changes;
  }

  crdtOnlyRows(): Set<string> {
    const keys = new Set<string>();
    for (const touched of this.touched.values()) {
      if (!touched.plain) keys.add(`${touched.table}\u0000${touched.id}`);
    }
    return keys;
  }

  async writeCrdt(effect: CrdtEffect): Promise<void> {
    await this.track(effect.table, effect.rowId, false, false);
    await (this.real as any).patch(effect.table, effect.rowId, {
      [effect.field]: effect.projection,
    });
  }

  async files(): Promise<Array<{ storageId: string; delta: number }>> {
    const deltas = new Map<string, number>();
    for (const touched of this.touched.values()) {
      const paths = this.storageIdPaths.get(touched.table);
      if (!paths) continue;
      const after = (await (this.real as any).get(touched.table, touched.id)) as Record<
        string,
        unknown
      > | null;
      const diff = diffStorageIds(
        readStorageIds(touched.before, paths),
        readStorageIds(after, paths),
      );
      for (const storageId of diff.dereferenced) {
        deltas.set(storageId, (deltas.get(storageId) ?? 0) - 1);
      }
      for (const storageId of diff.newlyReferenced) {
        deltas.set(storageId, (deltas.get(storageId) ?? 0) + 1);
      }
    }
    return Array.from(deltas, ([storageId, delta]) => ({ storageId, delta })).filter(
      (change) => change.delta !== 0,
    );
  }

  private writer(): GenericDatabaseWriter<any> {
    return new Proxy(this.real as object, {
      get: (target, property, receiver) => {
        if (property === "insert") {
          return async (table: string, value: unknown) => {
            this.assertReplicatedTable(table);
            this.assertReplicatedWrite(table, value);
            const id = await (this.real as any).insert(table, value);
            this.trackInserted(table, id);
            this.insertOrder.push({ table, id });
            return id;
          };
        }
        if (["patch", "replace", "delete"].includes(String(property))) {
          return (...args: unknown[]) => this.write(String(property), args);
        }
        if (property === "get") {
          return async (...args: unknown[]) => {
            const row = await Reflect.apply(
              Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown,
              target,
              args,
            );
            const table = args.length === 1 ? await this.tableOf(String(args[0])) : String(args[0]);
            return this.project(table, row);
          };
        }
        if (property === "query") {
          return (table: string) => {
            this.assertReplicatedTable(table);
            return this.projectQuery(table, (this.real as any).query(table));
          };
        }
        if (property === "table") {
          return (table: string) => this.scoped(table, (this.real as any).table(table));
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as GenericDatabaseWriter<any>;
  }

  private scoped(table: string, scoped: any): any {
    this.assertReplicatedTable(table);
    return new Proxy(scoped, {
      get: (target, property, receiver) => {
        if (property === "insert") {
          return async (value: unknown) => {
            this.assertReplicatedWrite(table, value);
            const id = await target.insert(value);
            this.trackInserted(table, id);
            this.insertOrder.push({ table, id });
            return id;
          };
        }
        if (["patch", "replace", "delete"].includes(String(property))) {
          return async (...args: unknown[]) => {
            const id = String(args[0]);
            const restore = this.isRevisionRestore(String(property), table, id, args[1]);
            if (property !== "delete" && !restore) {
              this.assertPlain(table, args[1]);
              this.assertReplicatedWrite(table, args[1]);
            }
            await this.track(table, id, false, true);
            if (property === "replace" && !restore) {
              const current = await target.get(id);
              const preserved = Object.fromEntries(
                fieldPlacements(this.placements, table).remote.flatMap((field) =>
                  current && Object.hasOwn(current, field) ? [[field, current[field]]] : [],
                ),
              );
              args[1] = { ...(args[1] as Record<string, unknown>), ...preserved };
            }
            const result = await target[property](...args);
            if (restore) this.restoreGrants.delete(`${table}\u0000${id}`);
            return result;
          };
        }
        if (property === "get") {
          return async (id: string) => this.project(table, await target.get(id));
        }
        if (property === "query") {
          return () => this.projectQuery(table, target.query());
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private async write(kind: string, args: unknown[]): Promise<unknown> {
    const qualified = args.length >= (kind === "delete" ? 2 : 3);
    const table = qualified ? String(args[0]) : await this.tableOf(String(args[0]));
    const id = String(args[qualified ? 1 : 0]);
    const value = args[qualified ? 2 : 1];
    const restore = this.isRevisionRestore(kind, table, id, value);
    if (kind !== "delete" && !restore) {
      this.assertPlain(table, value);
      this.assertReplicatedWrite(table, value);
    }
    await this.track(table, id, false, true);
    if (kind === "replace" && !restore) {
      const current = await (this.real as any).get(table, id);
      const preserved = Object.fromEntries(
        fieldPlacements(this.placements, table).remote.flatMap((field) =>
          current && Object.hasOwn(current, field) ? [[field, current[field]]] : [],
        ),
      );
      args[qualified ? 2 : 1] = { ...(value as Record<string, unknown>), ...preserved };
    }
    const result = await (this.real as any)[kind](...args);
    if (restore) this.restoreGrants.delete(`${table}\u0000${id}`);
    return result;
  }

  private isRevisionRestore(kind: string, table: string, id: string, value: unknown): boolean {
    const grant = this.restoreGrants.get(`${table}\u0000${id}`);
    if (!grant) return false;
    if (kind === "delete") return grant.deleted;
    return (
      kind === "replace" && !grant.deleted && canonicalJson(value) === canonicalJson(grant.value)
    );
  }

  private assertPlain(table: string, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const declared = this.crdtFields.get(table);
    if (!declared) return;
    for (const field of Object.keys(value as Record<string, unknown>)) {
      if (declared.has(field)) {
        throw new ConvexError({
          code: "EMBEDDED_CRDT_WRITE",
          message: `Use ctx.db.${declared.get(field)} intent methods for ${table}.${field}.`,
        });
      }
    }
  }

  private async tableOf(id: string): Promise<string> {
    for (const table of this.tableNames) {
      if ((this.real as any).normalizeId(table, id) !== null) return table;
    }
    throw new Error("Unable to resolve the table for an unqualified document ID.");
  }

  private assertReplicatedTable(table: string): void {
    if (!this.tableNames.includes(table)) {
      throw new Error(`Replicated functions cannot access non-replicated table ${table}.`);
    }
  }

  private assertReplicatedWrite(table: string, value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const forbidden = new Set([
      ...fieldPlacements(this.placements, table).remote,
      ...fieldPlacements(this.placements, table).local,
    ]);
    const field = Object.keys(value as Record<string, unknown>).find((name) => forbidden.has(name));
    if (field !== undefined) {
      throw new Error(`Replicated functions cannot write non-replicated field ${table}.${field}.`);
    }
  }

  private assertReplicatedIndex(table: string, index: unknown): void {
    if (
      typeof index === "string" &&
      this.placements.indexes[table]?.remote.includes(index) === true
    ) {
      throw new Error(`Replicated functions cannot access remote index ${table}.${index}.`);
    }
  }

  private project(table: string, value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    return projectWireDoc(this.placements, table, value as Record<string, unknown>);
  }

  private projectQuery(table: string, query: object): object {
    return new Proxy(query, {
      get: (target, property, receiver) => {
        if (property === Symbol.asyncIterator) {
          const project = (value: unknown) => this.project(table, value);
          return async function* () {
            for await (const row of target as AsyncIterable<unknown>) yield project(row);
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "withIndex") this.assertReplicatedIndex(table, args[0]);
          const next = value.apply(target, args);
          if (property === "collect" || property === "take") {
            return Promise.resolve(next).then((rows: unknown[]) =>
              rows.map((row) => this.project(table, row)),
            );
          }
          if (property === "first" || property === "unique") {
            return Promise.resolve(next).then((row) => this.project(table, row));
          }
          if (property === "paginate") {
            return Promise.resolve(next).then((page: { page: unknown[] }) => ({
              ...page,
              page: page.page.map((row) => this.project(table, row)),
            }));
          }
          return typeof next === "object" && next !== null ? this.projectQuery(table, next) : next;
        };
      },
    });
  }

  private async track(table: string, id: string, inserted: boolean, plain: boolean): Promise<void> {
    const key = `${table}\u0000${id}`;
    const existing = this.touched.get(key);
    if (existing) {
      if (plain) existing.plain = true;
      return;
    }
    const before = inserted ? null : await (this.real as any).get(table, id);
    this.touched.set(key, { table, id, inserted, before, plain });
  }

  private trackInserted(table: string, id: string): void {
    const key = `${table}\u0000${id}`;
    if (this.touched.has(key)) return;
    this.touched.set(key, { table, id, inserted: true, before: null, plain: true });
  }
}

class ScheduleCapture {
  private readonly allocated: string[] = [];

  constructor(
    private readonly real: Scheduler,
    private readonly mutationId: string,
    private readonly expected?: ScheduleRef[],
  ) {}

  writer(): Scheduler {
    return new Proxy(this.real as object, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (property === "runAfter" || property === "runAt") {
          return async (...args: unknown[]) => {
            const id = await Reflect.apply(
              value as (...values: unknown[]) => unknown,
              target,
              args,
            );
            this.allocated.push(String(id));
            return id;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Scheduler;
  }

  finish(): void {
    if (this.expected === undefined) return;
    const valid =
      this.expected.length === this.allocated.length &&
      this.expected.every(
        (reference, ordinal) =>
          reference.mutationId === this.mutationId && reference.ordinal === ordinal,
      );
    if (!valid) {
      throw new ConvexError({
        code: "EMBEDDED_SCHEDULE_EFFECT",
        message: "Mutation produced missing, reordered, or unexpected scheduled functions.",
      });
    }
  }

  ids(): string[] {
    return [...this.allocated];
  }

  settled(): Array<{ ordinal: number; id: string }> {
    return this.allocated.map((id, ordinal) => ({ ordinal, id }));
  }
}

class UploadCapture {
  private readonly allocated: string[] = [];

  constructor(
    private readonly real: MutationStorage,
    private readonly mutationId: string,
    private readonly expected?: UploadRef[],
  ) {}

  writer(): MutationStorage {
    return new Proxy(this.real as object, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (property === "generateUploadUrl") {
          return async (...args: unknown[]) => {
            const url = await Reflect.apply(
              value as (...values: unknown[]) => unknown,
              target,
              args,
            );
            this.allocated.push(String(url));
            return url;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MutationStorage;
  }

  finish(): void {
    if (this.expected === undefined) return;
    const valid =
      this.expected.length === this.allocated.length &&
      this.expected.every(
        (reference, ordinal) =>
          reference.mutationId === this.mutationId && reference.ordinal === ordinal,
      );
    if (!valid) {
      throw new ConvexError({
        code: "EMBEDDED_UPLOAD_EFFECT",
        message: "Mutation produced missing, reordered, or unexpected upload URLs.",
      });
    }
  }

  urls(): string[] {
    return [...this.allocated];
  }

  settled(): Array<{ ordinal: number; url: string }> {
    return this.allocated.map((url, ordinal) => ({ ordinal, url }));
  }
}

function hostedIntentCtx<DataModel extends GenericDataModel>(
  ctx: GenericMutationCtx<DataModel>,
  projectedDb: GenericDatabaseWriter<DataModel>,
  tableNames: string[],
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
): EmbeddedMutationCtx<DataModel> {
  const reject = (): never => {
    throw new ConvexError({
      code: "EMBEDDED_UNSUPPORTED",
      message:
        "A direct hosted call to a mutation that executes a CRDT intent method fails unless it carries an Embedded-generated effect.",
    });
  };
  const db = Object.assign(projectedDb, {
    count: { add: reject },
    set: { add: reject, delete: reject },
    text: { splice: reject },
  }) as GenericDatabaseWriter<DataModel> & CrdtIntentWriter;
  return {
    ...ctx,
    db,
    runQuery: replicatedMutationQuery(ctx, tableNames, placements, manifest),
    runMutation: replicatedMutationCall(ctx, tableNames, placements, manifest),
  } as EmbeddedMutationCtx<DataModel>;
}

function replicatedMutationQuery(
  ctx: GenericMutationCtx<any>,
  tableNames: string[],
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
): GenericMutationCtx<any>["runQuery"] {
  return (async (reference: FunctionReference<"query">, args: Record<string, unknown>) => {
    if (isEmbeddedComponentReference(reference)) {
      return projectComponentQueryResult(
        placements,
        tableNames,
        reference,
        await ctx.runQuery(reference as never, args as never),
      );
    }
    assertReplicatedReference(manifest, reference as never, "query");
    return await ctx.runQuery(reference as never, args as never);
  }) as GenericMutationCtx<any>["runQuery"];
}

function replicatedMutationCall(
  ctx: GenericMutationCtx<any>,
  tableNames: string[],
  placements: EmbeddedSchemaPlacements,
  manifest?: FunctionManifest,
): GenericMutationCtx<any>["runMutation"] {
  return (async (reference: FunctionReference<"mutation">, args: Record<string, unknown>) => {
    if (!isEmbeddedComponentReference(reference)) {
      assertReplicatedReference(manifest, reference as never, "mutation");
      throw new Error(
        "Embedded replicated mutations cannot call nested app mutations until their writes can join the parent replay capture.",
      );
    }
    const path = referencePath(reference);
    let componentArgs = args;
    if (path?.endsWith("/rev/create") || path?.endsWith("/rev/retain")) {
      const revision = projectRevisionExpectation(
        placements,
        tableNames,
        revisionExpectation(args),
      );
      componentArgs = revisionArgs(args, revision);
    }
    const result = await ctx.runMutation(reference as never, componentArgs as never);
    return path?.endsWith("/rev/create") ||
      path?.endsWith("/rev/retain") ||
      path?.endsWith("/rev/restore")
      ? projectRevision(placements, tableNames, result)
      : result;
  }) as GenericMutationCtx<any>["runMutation"];
}

function projectRevisionExpectation(
  placements: EmbeddedSchemaPlacements,
  tableNames: string[],
  revision: RevisionExpectation,
): RevisionExpectation {
  if (revision.deleted) return revision;
  if (!tableNames.includes(revision.table)) {
    throw new Error(
      `Replicated functions cannot access revisions for non-replicated table ${revision.table}.`,
    );
  }
  return {
    ...revision,
    value: projectWireDoc(placements, revision.table, revision.value ?? {}),
  };
}

class EffectCursor {
  private index = 0;

  constructor(
    private readonly capture: WriteCapture,
    private readonly effects: CrdtEffect[],
    private readonly crdtFields: Map<string, Map<string, CrdtKind>>,
  ) {}

  all(): CrdtEffect[] {
    return this.effects;
  }

  finish(): void {
    if (this.index !== this.effects.length) {
      throw new ConvexError({
        code: "EMBEDDED_CRDT_EFFECT",
        message: "Mutation did not consume every carried CRDT effect.",
      });
    }
  }

  private async consume(kind: CrdtKind, table: string, id: string, field: string): Promise<void> {
    const effect = this.effects[this.index++];
    if (
      !effect ||
      effect.kind !== kind ||
      effect.table !== table ||
      effect.rowId !== id ||
      effect.field !== field
    ) {
      throw new ConvexError({
        code: "EMBEDDED_CRDT_EFFECT",
        message: "Missing, reordered, or mismatched CRDT effect.",
      });
    }
    await this.capture.writeCrdt(effect);
  }

  private async current(table: string, id: string): Promise<Record<string, unknown> | null> {
    return (await (this.capture.db as any).get(table, id)) as Record<string, unknown> | null;
  }

  writer(): GenericDatabaseWriter<any> & CrdtIntentWriter {
    return Object.assign(this.capture.db, {
      count: {
        add: async (table: string, id: string, field: string, delta: number) => {
          assertIntentField(table, field, "count", this.crdtFields.get(table)?.get(field));
          assertFiniteDelta(table, field, delta);
          const decision = validateCountAdd(table, id, field, await this.current(table, id), delta);
          if (!decision.consume) return;
          await this.consume("count", table, id, field);
        },
      },
      set: {
        add: async (table: string, id: string, field: string) => {
          assertIntentField(table, field, "set", this.crdtFields.get(table)?.get(field));
          validateSetField("set.add", table, id, field, await this.current(table, id));
          await this.consume("set", table, id, field);
        },
        delete: async (table: string, id: string, field: string) => {
          assertIntentField(table, field, "set", this.crdtFields.get(table)?.get(field));
          validateSetField("set.delete", table, id, field, await this.current(table, id));
          await this.consume("set", table, id, field);
        },
      },
      text: {
        splice: async (
          table: string,
          id: string,
          field: string,
          change: { delete: number; index: number; insert: string; base?: string },
        ) => {
          assertIntentField(table, field, "text", this.crdtFields.get(table)?.get(field));
          const source = validateTextSplice(
            table,
            id,
            field,
            await this.current(table, id),
            change,
          );
          await assertTextBase(table, field, source, change.base);
          await this.consume("text", table, id, field);
        },
      },
    });
  }
}

async function inspectWitnesses(
  ctx: GenericMutationCtx<any>,
  tableNames: string[],
  crdtFields: Map<string, Map<string, CrdtKind>>,
  witnesses: ReadWitness[],
  placements: EmbeddedSchemaPlacements,
): Promise<{
  conflict: boolean;
  conflicts: Array<{ table: string; rowId: string }>;
  crdt: Array<{
    table: string;
    rowId: string;
    field: string;
    epoch: number;
    headSeq: number;
    projectionHash: string;
    genesis: boolean;
  }>;
  unsupported: boolean;
  verifiedPoints: Array<{ table: string; rowId: string }>;
}> {
  const points = witnesses.filter(
    (witness): witness is Extract<ReadWitness, { kind: "point" }> => witness.kind === "point",
  );
  if (points.length > MAX_TRACKED_ROWS) {
    throw new ConvexError({
      code: "EMBEDDED_READ_WITNESS",
      message: `A mutation may carry at most ${MAX_TRACKED_ROWS} point witnesses.`,
    });
  }
  const conflicts: Array<{ table: string; rowId: string }> = [];
  let conflict = false;
  const crdt: Array<{
    table: string;
    rowId: string;
    field: string;
    epoch: number;
    headSeq: number;
    projectionHash: string;
    genesis: boolean;
  }> = [];
  const verifiedPoints: Array<{ table: string; rowId: string }> = [];
  for (const witness of points) {
    if (
      !tableNames.includes(witness.table) ||
      (ctx.db as any).normalizeId(witness.table, witness.rowId) === null
    ) {
      throw new ConvexError({
        code: "EMBEDDED_READ_WITNESS",
        message: "Point witness contains an invalid app-row address.",
      });
    }
    const serverCurrent = await (ctx.db as any).get(witness.table, witness.rowId);
    const current =
      serverCurrent === null ? null : projectWireDoc(placements, witness.table, serverCurrent);
    const currentHash = await hashDocument(current, crdtFields.get(witness.table)?.keys());
    if (witness.plainHash !== currentHash) {
      conflict = true;
      conflicts.push({ table: witness.table, rowId: witness.rowId });
    } else {
      verifiedPoints.push({ table: witness.table, rowId: witness.rowId });
    }
    for (const field of witness.crdt) {
      if (crdtFields.get(witness.table)?.has(field.field) !== true) {
        throw new ConvexError({
          code: "EMBEDDED_READ_WITNESS",
          message: "Point witness addresses an undeclared CRDT field.",
        });
      }
      crdt.push({
        table: witness.table,
        rowId: witness.rowId,
        ...field,
        genesis:
          field.epoch === 0 &&
          field.headSeq === 0 &&
          field.projectionHash === (await hashValue(readField(current, field.field) ?? null)),
      });
    }
  }
  const ranges = witnesses.filter(
    (witness): witness is Extract<ReadWitness, { kind: "range" }> => witness.kind === "range",
  );
  if (ranges.length > MAX_TRACKED_RANGES) {
    throw new ConvexError({
      code: "EMBEDDED_READ_WITNESS",
      message: `A mutation may carry at most ${MAX_TRACKED_RANGES} range witnesses.`,
    });
  }
  let unsupported = false;
  for (const witness of ranges) {
    if (
      !tableNames.includes(witness.table) ||
      witness.index === undefined ||
      !placements.indexes[witness.table]?.replicated.includes(witness.index)
    ) {
      unsupported = true;
      continue;
    }
    try {
      const limit = witness.limit ?? MAX_TRACKED_ROWS + 1;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_TRACKED_ROWS) {
        unsupported = true;
        continue;
      }
      const rows = await (ctx.db as any)
        .query(witness.table)
        .withIndex(witness.index, (builder: any) => {
          let range = builder;
          for (const equality of witness.equality) {
            range = range.eq(
              equality.field,
              equality.commitTs === true ? ctx.db.vars.commitTs : equality.value,
            );
          }
          if (witness.lower) {
            range = witness.lower.inclusive
              ? range.gte(
                  witness.lower.field,
                  witness.lower.commitTs === true ? ctx.db.vars.commitTs : witness.lower.value,
                )
              : range.gt(
                  witness.lower.field,
                  witness.lower.commitTs === true ? ctx.db.vars.commitTs : witness.lower.value,
                );
          }
          if (witness.upper) {
            range = witness.upper.inclusive
              ? range.lte(
                  witness.upper.field,
                  witness.upper.commitTs === true ? ctx.db.vars.commitTs : witness.upper.value,
                )
              : range.lt(
                  witness.upper.field,
                  witness.upper.commitTs === true ? ctx.db.vars.commitTs : witness.upper.value,
                );
          }
          return range;
        })
        .order(witness.order)
        .take(limit);
      if (rows.length > MAX_TRACKED_ROWS) {
        unsupported = true;
      } else {
        const members = await Promise.all(
          rows.map(async (row: any) => {
            const wire = projectWireDoc(placements, witness.table, row);
            return {
              id: wire._id,
              hash: await hashDocument(wire, crdtFields.get(witness.table)?.keys()),
            };
          }),
        );
        if ((await hashValue(members)) !== witness.membersHash) {
          conflict = true;
          conflicts.push(...members.map(({ id }) => ({ table: witness.table, rowId: id })));
        }
      }
    } catch {
      unsupported = true;
    }
  }
  return {
    conflict,
    conflicts,
    crdt,
    unsupported,
    verifiedPoints,
  };
}

function readField(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertExpectedInserts(
  mutationId: string,
  expected: InsertRef[],
  actual: Array<{ ordinal: number; table: string; id: string }>,
): void {
  if (
    expected.length !== actual.length ||
    expected.some(
      (insert, index) =>
        insert.mutationId !== mutationId ||
        insert.ordinal !== index ||
        insert.table !== actual[index]?.table,
    )
  ) {
    throw new ConvexError({
      code: "EMBEDDED_INSERT_REF",
      message: "Carried insert references do not match authoritative insert order.",
    });
  }
}

async function resolveArgRefs(
  ctx: GenericMutationCtx<any>,
  component: EmbeddedComponent,
  clientId: string,
  value: unknown,
  refs: ArgRef[],
): Promise<unknown> {
  const resolved = structuredClone(value);
  for (const ref of refs) {
    const dependency = "insert" in ref ? ref.insert : ref.schedule;
    const settled = await ctx.runQuery(component.protocol.settlementRead, {
      clientId,
      mutationId: dependency.mutationId,
    });
    const settlement = settled?.settlement as Settlement | undefined;
    if (!settlement || settlement.outcome !== "applied") {
      throw new ConvexError({
        code: "EMBEDDED_DEPENDENCY",
        message: "An argument references an effect that has not applied.",
      });
    }
    const id =
      "insert" in ref
        ? settlement.inserts.find(
            (candidate) =>
              candidate.ordinal === ref.insert.ordinal && candidate.table === ref.insert.table,
          )?.id
        : settlement.schedules.find((candidate) => candidate.ordinal === ref.schedule.ordinal)?.id;
    if (!id) {
      throw new ConvexError({
        code: "EMBEDDED_ARG_REF",
        message: "An argument reference does not match its prior settlement.",
      });
    }
    writePointer(resolved, ref.path, id);
  }
  return resolved;
}

function writePointer(root: unknown, path: string, value: string): void {
  if (!path.startsWith("/")) {
    throw new ConvexError({
      code: "EMBEDDED_ARG_REF",
      message: "Argument reference paths must use JSON Pointer syntax.",
    });
  }
  const parts = path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent = root as any;
  for (const part of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== "object" || !(part in parent)) {
      throw new ConvexError({
        code: "EMBEDDED_ARG_REF",
        message: "Argument reference path is missing.",
      });
    }
    parent = parent[part];
  }
  const key = parts.at(-1);
  if (key === undefined || parent === null || typeof parent !== "object" || !(key in parent)) {
    throw new ConvexError({
      code: "EMBEDDED_ARG_REF",
      message: "Argument reference path is missing.",
    });
  }
  parent[key] = value;
}

async function identityAttributeOf(
  ctx: Pick<GenericQueryCtx<any>, "auth">,
): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? await hashValue(identity.tokenIdentifier) : null;
}

function assertRuntimeVersion(runtime: { protocolVersion: number }): EmbeddedProtocolVersion {
  if (isEmbeddedProtocolVersion(runtime.protocolVersion)) return runtime.protocolVersion;
  throw new ConvexError({
    code: EMBEDDED_PROTOCOL_MISMATCH,
    expected: [EMBEDDED_PROTOCOL_LEGACY_VERSION, EMBEDDED_PROTOCOL_VERSION],
    message: `Embedded protocol ${runtime.protocolVersion} is not supported.`,
    received: runtime.protocolVersion,
  });
}

function schemaCrdtFields(
  schema: SchemaDefinition<any, boolean>,
): Map<string, Map<string, CrdtKind>> {
  const result = new Map<string, Map<string, CrdtKind>>();
  const tables = (schema as unknown as { tables?: Record<string, { validator?: unknown }> }).tables;
  for (const [table, definition] of Object.entries(tables ?? {})) {
    const fields = new Map<string, CrdtKind>();
    collectCrdtFields(definition.validator, "", fields);
    if (fields.size > 0) result.set(table, fields);
  }
  return result;
}

function collectCrdtFields(
  validator: unknown,
  prefix: string,
  fields: Map<string, CrdtKind>,
): void {
  const meta = embeddedFieldMeta(validator);
  if (meta?.placement === "replicated" && prefix !== "") {
    fields.set(prefix, meta.crdt.kind);
    return;
  }
  const object = validator as { kind?: unknown; fields?: Record<string, unknown> };
  if (object?.kind !== "object") return;
  for (const [field, child] of Object.entries(object.fields ?? {})) {
    collectCrdtFields(child, prefix === "" ? field : `${prefix}.${field}`, fields);
  }
}

function replayFailure(
  code: "EMBEDDED_CONFLICT" | "EMBEDDED_REJECTED" | "EMBEDDED_REBASE" | "EMBEDDED_DIVERGENCE",
  changes: Array<{ table: string; rowId: string }>,
  reason?: string,
): ConvexError<{
  kind: string;
  code: string;
  message: string;
  targets: Array<{ table: string; rowId: string }>;
}> {
  return new ConvexError({
    kind: "embeddedReplayFailure",
    code,
    message: replayFailureMessage(code),
    targets: changes.map(({ table, rowId }) => ({ table, rowId })),
    ...(reason === undefined ? {} : { reason }),
  });
}

type ReplayFailureCode =
  | "EMBEDDED_CONFLICT"
  | "EMBEDDED_REJECTED"
  | "EMBEDDED_REBASE"
  | "EMBEDDED_DIVERGENCE";

function embeddedFailure(error: unknown): {
  code: ReplayFailureCode;
  targets: Array<{ table: string; rowId: string }>;
  reason?: string;
} | null {
  const data = convexErrorData(error);
  if (data?.kind !== "embeddedReplayFailure") return null;
  return replayFailureData(data);
}

function componentFailure(error: unknown): {
  code: ReplayFailureCode;
  targets: Array<{ table: string; rowId: string }>;
  reason?: string;
} | null {
  const data = convexErrorData(error);
  return data === null ? null : replayFailureData(data);
}

function convexErrorData(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ConvexError)) return null;
  return error.data !== null && typeof error.data === "object" && !Array.isArray(error.data)
    ? (error.data as Record<string, unknown>)
    : null;
}

function replayFailureData(data: Record<string, unknown>): {
  code: ReplayFailureCode;
  targets: Array<{ table: string; rowId: string }>;
  reason?: string;
} | null {
  const code = data.code;
  if (
    code !== "EMBEDDED_CONFLICT" &&
    code !== "EMBEDDED_REJECTED" &&
    code !== "EMBEDDED_REBASE" &&
    code !== "EMBEDDED_DIVERGENCE"
  ) {
    return null;
  }
  const targets = Array.isArray(data.targets)
    ? data.targets.flatMap((target) => {
        if (target === null || typeof target !== "object" || Array.isArray(target)) return [];
        const { table, rowId } = target as Record<string, unknown>;
        return typeof table === "string" && typeof rowId === "string" ? [{ table, rowId }] : [];
      })
    : [];
  return { code, targets, ...(typeof data.reason === "string" ? { reason: data.reason } : {}) };
}

function isEmbeddedReplayResult(
  value: unknown,
): value is { kind: "embeddedReplay"; settlement: Settlement } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "embeddedReplay" &&
    typeof (value as Record<string, unknown>).settlement === "object"
  );
}

function uniqueTargets(
  targets: Array<{ table: string; rowId: string }>,
): Array<{ table: string; rowId: string }> {
  const unique = new Map<string, { table: string; rowId: string }>();
  for (const target of targets) unique.set(`${target.table}\u0000${target.rowId}`, target);
  return Array.from(unique.values());
}

async function authoritativeChanges(
  ctx: GenericMutationCtx<any>,
  targets: Array<{ table: string; rowId: string }>,
  tableNames: string[],
  crdtFields: Map<string, Map<string, CrdtKind>>,
  placements: EmbeddedSchemaPlacements,
) {
  if (targets.length > MAX_TRACKED_ROWS) {
    throw new Error(`Embedded failure settlement accepts at most ${MAX_TRACKED_ROWS} targets.`);
  }
  const allowed = new Set(tableNames);
  const changes: Array<
    | { op: "put"; table: string; rowId: string; fields: unknown; contentHash: string }
    | { op: "del"; table: string; rowId: string; contentHash: string }
  > = [];
  for (const { table, rowId } of targets) {
    if (!allowed.has(table)) throw new Error(`Unknown Embedded table ${table}.`);
    const normalized = (ctx.db as any).normalizeId(table, rowId);
    if (normalized === null) throw new Error(`Invalid Embedded row ID for ${table}.`);
    const row = await (ctx.db as any).get(table, normalized);
    if (row === null) {
      changes.push({ op: "del", table, rowId, contentHash: await hashValue(null) });
    } else {
      const wire = projectWireDoc(placements, table, row);
      changes.push({
        op: "put",
        table,
        rowId,
        fields: wire,
        contentHash: await hashDocument(wire, crdtFields.get(table)?.keys()),
      });
    }
  }
  return changes;
}

/** Refresh a cached applied result so a late replay cannot restore an older server projection. */
async function refreshAppliedSettlement(
  ctx: GenericMutationCtx<any>,
  settlement: Settlement,
  tableNames: string[],
  crdtFields: Map<string, Map<string, CrdtKind>>,
  placements: EmbeddedSchemaPlacements,
): Promise<Settlement> {
  if (settlement.outcome !== "applied") {
    return settlement;
  }
  const originalTargets = new Set(
    settlement.authoritative.map(({ table, rowId }) => `${table}\u0000${rowId}`),
  );
  const targets = uniqueTargets(
    [...settlement.authoritative, ...settlement.crdt].map(({ table, rowId }) => ({ table, rowId })),
  );
  if (targets.length === 0) return settlement;
  const current = await authoritativeChanges(ctx, targets, tableNames, crdtFields, placements);
  return {
    ...settlement,
    authoritative: current
      .filter(
        (change) =>
          change.op === "del" || originalTargets.has(`${change.table}\u0000${change.rowId}`),
      )
      .map((change) =>
        change.op === "put"
          ? {
              op: change.op,
              table: change.table,
              rowId: change.rowId,
              fields: change.fields,
              plainHash: change.contentHash,
            }
          : {
              op: change.op,
              table: change.table,
              rowId: change.rowId,
              plainHash: change.contentHash,
            },
      ),
  };
}

/** A stale witness is a conflict only in ordering; retain an after-image only when content differs. */
async function divergentRevisionCandidates(
  candidates: RevisionCandidate[],
  authoritative: Awaited<ReturnType<typeof authoritativeChanges>>,
  crdtFields: Map<string, Map<string, CrdtKind>>,
): Promise<RevisionCandidate[]> {
  const current = new Map(
    authoritative.map((change) => [`${change.table}\u0000${change.rowId}`, change]),
  );
  const divergent: RevisionCandidate[] = [];
  for (const candidate of candidates) {
    const change = current.get(`${candidate.table}\u0000${candidate.rowId}`);
    if (candidate.content === "deleted") {
      if (change?.op !== "del") divergent.push(candidate);
      continue;
    }
    if (
      change?.op !== "put" ||
      (await hashDocument(candidate.value, crdtFields.get(candidate.table)?.keys())) !==
        change.contentHash
    ) {
      divergent.push(candidate);
    }
  }
  return divergent;
}

function replayFailureMessage(
  code: "EMBEDDED_CONFLICT" | "EMBEDDED_REJECTED" | "EMBEDDED_REBASE" | "EMBEDDED_DIVERGENCE",
): string {
  if (code === "EMBEDDED_CONFLICT") {
    return "An authoritative plain read changed after the local mutation ran.";
  }
  if (code === "EMBEDDED_REBASE") {
    return "An authoritative CRDT dependency advanced after the local mutation ran.";
  }
  if (code === "EMBEDDED_DIVERGENCE") {
    return "The authoritative mutation result diverged from the local mutation result.";
  }
  return "The authoritative mutation rejected the optimistic local write.";
}
