import { validateJson } from "./runtime/validate";
import { normalizeStorageError } from "./error";
import type { RuntimeStorage, StoreSchema, StoredDoc, TableDef } from "./storage/types";

interface MigrationBinding {
  migrationBegin(schema: StoreSchema): Promise<string> | string;
  migrationCommit(schema: StoreSchema, generation: bigint | number): Promise<void> | void;
  originPageRead(
    generation: bigint | number,
    cursorJson: string | undefined,
    pageSize: number,
  ): Promise<string> | string;
  migrationRecordDispositionWrite(
    generation: bigint | number,
    identityKey: string,
    kind: bigint | number,
    recordKey: Uint8Array,
    migrationId: string,
    reason: string,
    discard: boolean,
  ): Promise<void> | void;
  migrationQueuePolicyWrite?(
    generation: bigint | number,
    policyJson: string,
  ): Promise<boolean> | boolean;
  migrationQueuePolicyStateRead?(generation: bigint | number): Promise<string> | string;
}

interface Candidate {
  activeGeneration: number;
  candidateGeneration: number;
  cleanupGeneration?: number | null;
  retiredGenerations: number[];
  required: boolean;
  resumed: boolean;
  setupComplete: boolean;
  sourceSchema: StoreSchema;
}

/** Prepared, unpublished store generation used by candidate setup. @internal */
export interface StoreSetupCandidate {
  readonly activeGeneration: number;
  readonly generation: number;
  /** Stale unpublished generation that must be retired before preparing this target. */
  readonly cleanupGeneration?: number;
  readonly required: boolean;
  readonly resumed: boolean;
  readonly setupComplete: boolean;
  /** Contract currently published before this setup attempt. */
  readonly sourceSchema: StoreSchema;
  /** Generations already retired before this open; cleanup is restartable. */
  readonly retiredGenerations: readonly number[];
}

/** Create or resume an unpublished generation without exposing raw records to application code. */
export async function prepareStoreSetup(
  binding: MigrationBinding,
  schema: StoreSchema,
): Promise<StoreSetupCandidate> {
  let encoded: string;
  try {
    encoded = await binding.migrationBegin(schema);
  } catch (error) {
    throw normalizeStorageError(error);
  }
  const candidate = JSON.parse(encoded) as Candidate;
  return {
    activeGeneration: candidate.activeGeneration,
    generation: candidate.candidateGeneration,
    cleanupGeneration: candidate.cleanupGeneration ?? undefined,
    required: candidate.required,
    resumed: candidate.resumed,
    setupComplete: candidate.setupComplete,
    sourceSchema: candidate.sourceSchema,
    retiredGenerations: candidate.retiredGenerations,
  };
}

/** Atomically publish a prepared candidate using the target schema, never the setup workspace. */
export async function finalizeStoreSetup(
  binding: MigrationBinding,
  schema: StoreSchema,
  generation: number,
): Promise<void> {
  try {
    await binding.migrationCommit(schema, generation);
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

/**
 * Validate every application record while the unpublished generation is bound to the target
 * schema. Storage codecs establish that a record is readable; this phase establishes that its
 * application payload is valid for the release that is about to become active.
 *
 * @internal
 */
export async function validateStoreSetup(
  store: RuntimeStorage,
  schema: StoreSchema,
  binding?: MigrationBinding,
  generation?: bigint | number,
): Promise<void> {
  for (const table of schema.tables) {
    let cursor: string | undefined;
    do {
      const page = await store.doc.page.read({
        cursor,
        order: "asc",
        pageSize: 512,
        table: table.name,
      });
      for (const doc of page.docs) validateTargetDoc(table, doc, page.deviceFields?.[doc._id]);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
  }
  if (binding !== undefined && generation !== undefined) {
    await validateOriginatedLocalFields(store, schema, binding, generation);
  }
}

const LOCAL_FIELD_ORIGIN = 3;
const PUSH_ENVELOPE_ORIGIN = 5;
const ORIGIN_QUARANTINED_OR_DISCARDED = 3;

interface OriginPageJson {
  records: Array<{
    identityKey: string;
    kind: number;
    recordKey: string;
    flags: number;
    payload: string;
  }>;
  cursor?: { identityKey: string; kind: number; recordKey: string } | null;
}

type LocalFieldOrigin = { table: string; id: string; field: string; value: unknown };

/**
 * Decide queue compatibility with the complete TypeScript validators before Rust materializes the
 * target generation. Threshold collection and Rust disposition both advance in durable bounded
 * pages, including the package-owned records derived from each causal suffix.
 *
 * @internal
 */
export async function applyQueuedMutationPolicy(
  binding: MigrationBinding,
  schema: StoreSchema,
  generation: bigint | number,
): Promise<void> {
  for (;;) {
    const step = await applyQueuedMutationPolicyStep(binding, schema, generation);
    if (step.done) return;
  }
}

/** Advance one durable, bounded validator/policy page. @internal */
export async function applyQueuedMutationPolicyStep(
  binding: MigrationBinding,
  schema: StoreSchema,
  generation: bigint | number,
): Promise<{ done: boolean; records: number }> {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  if (
    binding.migrationQueuePolicyWrite === undefined ||
    binding.migrationQueuePolicyStateRead === undefined
  ) {
    throw new Error("This storage binding does not support queued-mutation candidate policy.");
  }
  const state = JSON.parse(await binding.migrationQueuePolicyStateRead(generation)) as {
    cursor?: OriginPageJson["cursor"];
    done: boolean;
    state: string;
  };
  if (state.done) return { done: true, records: 0 };
  if (state.state === "collecting") {
    const thresholds = new Map<string, number>();
    const page = JSON.parse(
      await binding.originPageRead(
        generation,
        state.cursor === undefined || state.cursor === null
          ? undefined
          : JSON.stringify(state.cursor),
        256,
      ),
    ) as OriginPageJson;
    for (const record of page.records) {
      if (
        record.kind !== PUSH_ENVELOPE_ORIGIN ||
        (record.flags & ORIGIN_QUARANTINED_OR_DISCARDED) !== 0
      ) {
        continue;
      }
      const envelope = JSON.parse(decodeBase64Text(record.payload)) as Record<string, unknown>;
      const commitSeq = envelope.commitSeq;
      if (typeof commitSeq !== "number" || !Number.isSafeInteger(commitSeq)) {
        throw new Error("Queued mutation has no valid durable commit sequence.");
      }
      if (!isQueuedEnvelopeCompatible(envelope, tables)) {
        const previous = thresholds.get(record.identityKey);
        thresholds.set(
          record.identityKey,
          previous === undefined ? commitSeq : Math.min(previous, commitSeq),
        );
      }
    }
    const done = await binding.migrationQueuePolicyWrite(
      generation,
      JSON.stringify({
        collectComplete: page.cursor === undefined || page.cursor === null,
        cursor: page.cursor,
        thresholds: [...thresholds].map(([identityKey, commitSeq]) => ({
          commitSeq,
          identityKey,
        })),
      }),
    );
    return { done, records: page.records.length };
  }
  const done = await binding.migrationQueuePolicyWrite(
    generation,
    JSON.stringify({ collectComplete: true, cursor: null, thresholds: [] }),
  );
  return { done, records: 0 };
}

function isQueuedEnvelopeCompatible(
  envelope: Record<string, unknown>,
  tables: ReadonlyMap<string, TableDef>,
): boolean {
  const targetTable = (value: unknown): TableDef | undefined =>
    typeof value === "string" ? tables.get(value) : undefined;
  const replicated = (value: unknown): TableDef | undefined => {
    const table = targetTable(value);
    return table?.placement === "replicated" ? table : undefined;
  };

  for (const candidate of arrayObjects(envelope.afterImages)) {
    const table = replicated(candidate.table);
    if (table === undefined) return false;
    if (candidate.content === "value") {
      if (!("value" in candidate)) return false;
      if (table.document === undefined) continue;
      try {
        validateJson(candidate.value, table.document, table.name);
      } catch {
        return false;
      }
    } else if (candidate.content !== "deleted") {
      return false;
    }
  }
  for (const effect of arrayObjects(envelope.crdt)) {
    const table = replicated(effect.table);
    if (
      table === undefined ||
      typeof effect.field !== "string" ||
      typeof effect.kind !== "string" ||
      !table.crdtFields?.some((field) => field.field === effect.field && field.kind === effect.kind)
    ) {
      return false;
    }
  }
  for (const checkpoint of arrayObjects(envelope.revisionCheckpoints)) {
    const table = replicated(checkpoint.table);
    if (table === undefined) return false;
    for (const snapshot of arrayObjects(checkpoint.snapshots)) {
      if (
        typeof snapshot.field !== "string" ||
        typeof snapshot.kind !== "string" ||
        !table.crdtFields?.some(
          (field) => field.field === snapshot.field && field.kind === snapshot.kind,
        )
      ) {
        return false;
      }
    }
  }
  for (const insert of arrayObjects(envelope.inserts)) {
    if (replicated(insert.table) === undefined) return false;
  }
  for (const read of arrayObjects(envelope.reads)) {
    if (replicated(read.table) === undefined) return false;
  }
  return true;
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{}];
  return value.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {},
  );
}

/**
 * Validate local-field origins independently of document pages. A clean replicated projection can
 * be absent while its device overlay remains authoritative; page sidecars therefore cannot be the
 * only validation source. Removed fields and invalid orphan overlays are retained dormant rather
 * than discarded or allowed to surface under an incompatible target contract.
 */
async function validateOriginatedLocalFields(
  store: RuntimeStorage,
  schema: StoreSchema,
  binding: MigrationBinding,
  generation: bigint | number,
): Promise<void> {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  let cursor: OriginPageJson["cursor"];
  do {
    const page = JSON.parse(
      await binding.originPageRead(
        generation,
        cursor === undefined || cursor === null ? undefined : JSON.stringify(cursor),
        512,
      ),
    ) as OriginPageJson;
    for (const record of page.records) {
      if (
        record.kind !== LOCAL_FIELD_ORIGIN ||
        (record.flags & ORIGIN_QUARANTINED_OR_DISCARDED) !== 0
      ) {
        continue;
      }
      const origin = JSON.parse(decodeBase64Text(record.payload)) as LocalFieldOrigin;
      const table = tables.get(origin.table);
      const field = table?.localFields?.find((candidate) => candidate.field === origin.field);
      const reason = `target contract does not accept ${origin.table}.${origin.field}`;
      if (table?.placement !== "replicated" || field === undefined) {
        await quarantineOrigin(binding, generation, record, reason);
        continue;
      }

      const doc = await store.doc.read(origin.table, origin.id);
      if (doc !== undefined) {
        // The page-sidecar pass above already validated this materialized overlay and gives the app
        // a normal ctx.db migration path if it is incompatible.
        continue;
      }
      try {
        validateJson(origin.value, field.validator, `${origin.table}.${origin.field}`);
      } catch {
        await quarantineOrigin(binding, generation, record, `${reason} without a base document`);
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined && cursor !== null);
}

async function quarantineOrigin(
  binding: MigrationBinding,
  generation: bigint | number,
  record: OriginPageJson["records"][number],
  reason: string,
): Promise<void> {
  await binding.migrationRecordDispositionWrite(
    generation,
    record.identityKey,
    record.kind,
    decodeBase64(record.recordKey),
    "__embedded_target_contract__",
    reason,
    false,
  );
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64(value));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateTargetDoc(
  table: TableDef,
  doc: StoredDoc,
  localFields: Record<string, unknown> | undefined,
): void {
  if (table.document !== undefined) {
    const data: Record<string, unknown> = { ...doc };
    delete data._creationTime;
    delete data._id;
    validateJson(data, table.document, table.name);
  }
  if (localFields === undefined) return;
  const validators = new Map(
    (table.localFields ?? []).map((field) => [field.field, field.validator]),
  );
  for (const [field, value] of Object.entries(localFields)) {
    const validator = validators.get(field);
    if (validator === undefined) {
      throw new Error(`${table.name}.${field} is not a declared local field`);
    }
    validateJson(value, validator, `${table.name}.${field}`);
  }
}
