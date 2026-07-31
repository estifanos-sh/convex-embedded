import { convexToJson, type GenericValidator, type ValidatorJSON } from "convex/values";

import { decode, encode } from "./runtime/codec";
import { extractColEntries } from "./runtime/doc";
import { sha256Text } from "./sha";
import type {
  ColValue,
  MigrationDefinition,
  QuarantinePage,
  QuarantineRecord,
  StoreSchema,
} from "./storage/types";

export type DeviceQuarantinePage = QuarantinePage;
export type DeviceQuarantineRecord = QuarantineRecord;

type ValidatorValue<V extends GenericValidator> = V["type"];

export interface CarryDocument<V extends GenericValidator = GenericValidator> {
  readonly kind: "document";
  readonly recordKind: 2;
  readonly table: string;
  readonly value: V;
  readonly quarantined?: boolean;
}

export interface CarryRecord<V extends GenericValidator = GenericValidator> {
  readonly kind: "record";
  readonly recordKind: number;
  readonly value: V;
  readonly quarantined?: boolean;
}

export type CarrySelector<V extends GenericValidator = GenericValidator> =
  | CarryDocument<V>
  | CarryRecord<V>;

export interface DeviceMigrationRecord<T = unknown> {
  readonly identityKey: string;
  /** Opaque source token passed back as the first argument to `migration.write`. */
  readonly key: Uint8Array;
  /** The record's semantic key, used when a `carry.record` successor keeps or changes it. */
  readonly recordKey: Uint8Array;
  readonly kind: number;
  readonly table?: string;
  readonly id?: string;
  readonly creationTime?: number;
  readonly quarantine?: {
    readonly migrationId: string;
    readonly reason: string;
  };
  readonly value: T;
}

export interface DeviceMigrationSuccessor<T = unknown> {
  id: string;
  table: string;
  value: T;
  creationTime?: number;
}

export interface DeviceMigrationRecordSuccessor<T = unknown> {
  key: Uint8Array;
  value: T;
}

export interface DeviceMigrationContext<T = unknown> {
  readonly migration: {
    write(
      key: Uint8Array,
      successor: DeviceMigrationSuccessor<T> | DeviceMigrationRecordSuccessor<T>,
    ): Promise<void>;
    quarantine(record: DeviceMigrationRecord, reason: string): Promise<void>;
    discard(record: DeviceMigrationRecord, reason: string): Promise<void>;
  };
}

export interface DeviceMigrationOptions<
  Source extends GenericValidator,
  Target extends GenericValidator,
> {
  id: string;
  source: CarrySelector<Source>;
  target: CarrySelector<Target>;
  batchSize?: number;
  handler(
    ctx: DeviceMigrationContext<ValidatorValue<Target>>,
    records: DeviceMigrationRecord<ValidatorValue<Source>>[],
  ): Promise<void> | void;
}

export interface DeviceMigration<
  Source extends GenericValidator = GenericValidator,
  Target extends GenericValidator = GenericValidator,
> extends DeviceMigrationOptions<Source, Target> {
  readonly definitionHash: string;
}

export interface DeviceMigrationManifest {
  readonly migrations: readonly DeviceMigration[];
  readonly definitions: readonly MigrationDefinition[];
  readonly codeHash: string;
}

/** Payload-free summary of one store-contract upgrade. */
export interface DeviceMigrationReport {
  readonly activeGeneration: number;
  readonly candidateGeneration: number;
  readonly sourceContractHash: string;
  readonly targetContractHash: string;
  readonly created: boolean;
  readonly resumed: boolean;
  readonly required: boolean;
  readonly scanned: number;
  readonly migrated: number;
  readonly quarantined: number;
  readonly discarded: number;
  readonly reasons: Readonly<Record<string, number>>;
}

export const carry = {
  document<V extends GenericValidator>(options: {
    table: string;
    value: V;
    quarantined?: boolean;
  }): CarryDocument<V> {
    if (!options.table) throw new Error("carry.document requires a table");
    return Object.freeze({ kind: "document", recordKind: 2, ...options });
  },
  record<V extends GenericValidator>(options: {
    kind: number;
    value: V;
    quarantined?: boolean;
  }): CarryRecord<V> {
    if (!Number.isSafeInteger(options.kind) || options.kind <= 0) {
      throw new Error("carry.record requires a positive integer kind");
    }
    return Object.freeze({
      kind: "record",
      recordKind: options.kind,
      value: options.value,
      quarantined: options.quarantined,
    });
  },
} as const;

export function deviceMigration<Source extends GenericValidator, Target extends GenericValidator>(
  options: DeviceMigrationOptions<Source, Target>,
): DeviceMigration<Source, Target> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.id)) {
    throw new Error(`Invalid device migration id ${JSON.stringify(options.id)}`);
  }
  const batchSize = options.batchSize ?? 128;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_024) {
    throw new Error(`Device migration ${options.id} batchSize must be between 1 and 1024`);
  }
  const definitionHash = sha256Text(
    canonicalJson({
      id: options.id,
      source: selectorDefinition(options.source),
      target: selectorDefinition(options.target),
      batchSize,
    }),
  );
  return Object.freeze({ ...options, batchSize, definitionHash });
}

const manifests = new Map<string, DeviceMigrationManifest>();

export function defineDeviceMigrations(
  migrations: readonly DeviceMigration[],
): DeviceMigrationManifest {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (!ids.add(migration.id)) throw new Error(`Duplicate device migration id ${migration.id}`);
  }
  const definitions = migrations.map(({ id, definitionHash }) => ({ id, definitionHash }));
  const codeHash = sha256Text(
    canonicalJson({
      definitions,
      handlers: migrations.map((migration) => migration.handler.toString()),
    }),
  );
  const manifest = Object.freeze({
    migrations: Object.freeze([...migrations]),
    definitions: Object.freeze(definitions),
    codeHash,
  });
  manifests.set(codeHash, manifest);
  return manifest;
}

export function withDeviceMigrations(
  schema: StoreSchema,
  manifest: DeviceMigrationManifest,
): StoreSchema {
  return {
    ...schema,
    migrations: [...manifest.definitions],
    migrationCodeHash: manifest.codeHash,
  };
}

interface MigrationBinding {
  migrationBegin(schema: StoreSchema): Promise<string> | string;
  originPageRead(
    generation: bigint | number,
    cursorJson: string | undefined,
    pageSize: number,
    upperJson?: string,
  ): Promise<string> | string;
  migrationStepBegin(generation: bigint | number, migrationId: string): Promise<string> | string;
  migrationRecordWrite(generation: bigint | number, recordJson: string): Promise<void> | void;
  migrationRecordDelete(
    generation: bigint | number,
    identityKey: string,
    kind: bigint | number,
    recordKey: Uint8Array,
  ): Promise<void> | void;
  migrationRecordDispositionWrite(
    generation: bigint | number,
    identityKey: string,
    kind: bigint | number,
    recordKey: Uint8Array,
    migrationId: string,
    reason: string,
    discard: boolean,
  ): Promise<void> | void;
  migrationPageWrite(
    generation: bigint | number,
    migrationId: string,
    pageJson: string,
  ): Promise<void> | void;
  migrationStepComplete(
    generation: bigint | number,
    appliedMigrations: number,
  ): Promise<void> | void;
  migrationCommit(schema: StoreSchema, generation: bigint | number): Promise<void> | void;
  migrationRetire(generation: bigint | number): Promise<void> | void;
}

interface Candidate {
  activeGeneration: number;
  candidateGeneration: number;
  sourceContractHash: string;
  targetContractHash: string;
  retiredGenerations: number[];
  appliedMigrations: number;
  required: boolean;
  resumed: boolean;
  progressMigrationId?: string;
  progressCursor?: OriginPage["cursor"];
}

interface EncodedOriginRecord {
  identityKey: string;
  kind: number;
  recordKey: string;
  codec: number;
  flags: number;
  payload: string;
  payloadHash: string;
}

const sourceRecordKey = Symbol("deviceMigrationSourceRecordKey");
type InternalMigrationRecord = DeviceMigrationRecord & {
  readonly [sourceRecordKey]: Uint8Array;
};

interface OriginPage {
  records: EncodedOriginRecord[];
  cursor?: { identityKey: string; kind: number; recordKey: string };
}

/** Runs before the normal function runner or remote replication is started. @internal */
export async function setupWithDeviceMigrations(
  binding: MigrationBinding,
  schema: StoreSchema,
): Promise<{ report: DeviceMigrationReport; retiredGenerations: number[] }> {
  const candidate = parseJson<Candidate>(await binding.migrationBegin(schema));
  const report: MutableDeviceMigrationReport = {
    activeGeneration: candidate.activeGeneration,
    candidateGeneration: candidate.candidateGeneration,
    sourceContractHash: candidate.sourceContractHash,
    targetContractHash: candidate.targetContractHash,
    created: candidate.required && !candidate.resumed,
    resumed: candidate.resumed,
    required: candidate.required,
    scanned: 0,
    migrated: 0,
    quarantined: 0,
    discarded: 0,
    reasons: {},
  };
  if (!candidate.required) {
    return { report: freezeReport(report), retiredGenerations: candidate.retiredGenerations ?? [] };
  }
  const manifest = manifestForSchema(schema);
  const suffix = manifest.migrations.slice(candidate.appliedMigrations);
  for (const [offset, migration] of suffix.entries()) {
    await runMigration(
      binding,
      candidate.candidateGeneration,
      migration,
      schema,
      candidate.appliedMigrations + offset,
      report,
      candidate.progressMigrationId === migration.id ? candidate.progressCursor : undefined,
    );
  }
  await validateCandidateRecords(binding, candidate.candidateGeneration, schema, report);
  await binding.migrationCommit(schema, candidate.candidateGeneration);
  return {
    report: freezeReport(report),
    retiredGenerations: [
      ...new Set([...(candidate.retiredGenerations ?? []), candidate.activeGeneration]),
    ],
  };
}

async function runMigration(
  binding: MigrationBinding,
  generation: number,
  migration: DeviceMigration,
  schema: StoreSchema,
  migrationIndex: number,
  report: MutableDeviceMigrationReport,
  resumeCursor?: OriginPage["cursor"],
): Promise<void> {
  const progress = parseJson<{
    cursor?: OriginPage["cursor"];
    upperBound?: OriginPage["cursor"];
  }>(await binding.migrationStepBegin(generation, migration.id));
  let cursor = progress.cursor ?? resumeCursor;
  const upperBound = progress.upperBound;
  for (;;) {
    const page = parseJson<OriginPage>(
      await binding.originPageRead(
        generation,
        cursor === undefined ? undefined : JSON.stringify(cursor),
        migration.batchSize ?? 128,
        upperBound === undefined ? undefined : JSON.stringify(upperBound),
      ),
    );
    const records = page.records
      .filter(
        (record) =>
          (record.flags === 0 || (migration.source.quarantined === true && record.flags === 1)) &&
          selectorMatches(migration.source, record),
      )
      .map((record) => decodeRecord(migration.source, record));
    report.scanned += page.records.length;
    if (records.length > 0) {
      const pending = emptyMigrationPage();
      const context = migrationContext(migration, schema, records, pending, report);
      await migration.handler(context, records);
      if (!page.cursor) throw new Error("Non-empty originated page has no resume cursor");
      await binding.migrationPageWrite(
        generation,
        migration.id,
        JSON.stringify({ cursor: page.cursor, ...pending }),
      );
    } else if (page.records.length > 0) {
      if (!page.cursor) throw new Error("Non-empty originated page has no resume cursor");
      await binding.migrationPageWrite(
        generation,
        migration.id,
        JSON.stringify({ cursor: page.cursor, ...emptyMigrationPage() }),
      );
    }
    if (page.records.length === 0) break;
    cursor = page.cursor;
  }
  await binding.migrationStepComplete(generation, migrationIndex + 1);
}

interface PendingMigrationPage {
  writes: Record<string, unknown>[];
  deletes: Record<string, unknown>[];
  dispositions: Record<string, unknown>[];
}

function emptyMigrationPage(): PendingMigrationPage {
  return { writes: [], deletes: [], dispositions: [] };
}

function migrationContext(
  migration: DeviceMigration,
  schema: StoreSchema,
  page: readonly DeviceMigrationRecord[],
  pending: PendingMigrationPage,
  report: MutableDeviceMigrationReport,
): DeviceMigrationContext {
  return {
    migration: {
      write: async (key, successor) => {
        const source = page.find((record) => equalBytes(record.key, key)) as
          | InternalMigrationRecord
          | undefined;
        if (!source) throw new Error(`Migration ${migration.id} wrote an unknown page key`);
        assertValidator(
          validatorJson(migration.target.value),
          successor.value,
          `${migration.id} target`,
        );
        if (migration.target.kind === "record") {
          if (!("key" in successor) || !(successor.key instanceof Uint8Array)) {
            throw new Error(`Migration ${migration.id} record successor requires a key`);
          }
          const payload = JSON.stringify(successor.value);
          if (payload === undefined) {
            throw new Error(`Migration ${migration.id} record successor is not JSON encodable`);
          }
          pending.writes.push({
            identityKey: source.identityKey,
            kind: migration.target.recordKind,
            recordKey: bytesToBase64(successor.key),
            codec: 1,
            flags: 0,
            payload: bytesToBase64(new TextEncoder().encode(payload)),
          });
          report.migrated += 1;
          return;
        }
        if (!("table" in successor) || successor.table !== migration.target.table) {
          const actual = "table" in successor ? successor.table : undefined;
          throw new Error(
            `Migration ${migration.id} successor targets ${actual}, expected ${migration.target.table}`,
          );
        }
        const table = schema.tables.find((candidate) => candidate.name === successor.table);
        if (!table) throw new Error(`Migration target table ${successor.table} is absent`);
        const value = successor.value as Record<string, unknown>;
        const columns = extractColEntries(table, value).map(([name, column]) => [
          name,
          bytesToBase64(encodeColKey(column)),
        ]);
        const recordKey = originKey([successor.table, successor.id]);
        pending.writes.push({
          identityKey: source.identityKey,
          kind: 2,
          recordKey: bytesToBase64(recordKey),
          codec: 1,
          flags: 0,
          payload: bytesToBase64(
            new TextEncoder().encode(
              JSON.stringify({
                table: successor.table,
                id: successor.id,
                data: encode(value),
                columns,
                creationTime: successor.creationTime ?? source.creationTime ?? 0,
              }),
            ),
          ),
        });
        report.migrated += 1;
      },
      quarantine: async (record, reason) => {
        const source = record as InternalMigrationRecord;
        pending.dispositions.push({
          identityKey: record.identityKey,
          kind: record.kind,
          recordKey: bytesToBase64(source[sourceRecordKey]),
          reason,
          discard: false,
        });
        report.quarantined += 1;
        countReason(report, reason);
      },
      discard: async (record, reason) => {
        const source = record as InternalMigrationRecord;
        pending.dispositions.push({
          identityKey: record.identityKey,
          kind: record.kind,
          recordKey: bytesToBase64(source[sourceRecordKey]),
          reason,
          discard: true,
        });
        report.discarded += 1;
        countReason(report, reason);
      },
    },
  };
}

async function validateCandidateRecords(
  binding: MigrationBinding,
  generation: number,
  schema: StoreSchema,
  report: MutableDeviceMigrationReport,
): Promise<void> {
  let cursor: OriginPage["cursor"];
  do {
    const page = parseJson<OriginPage>(
      await binding.originPageRead(
        generation,
        cursor === undefined ? undefined : JSON.stringify(cursor),
        256,
      ),
    );
    report.scanned += page.records.length;
    for (const record of page.records) {
      if (record.flags !== 0 || ![2, 3, 11].includes(record.kind)) continue;
      try {
        const payload = JSON.parse(
          new TextDecoder().decode(base64ToBytes(record.payload)),
        ) as Record<string, unknown>;
        if (typeof payload.table !== "string") throw new Error("target table is absent");
        const table = schema.tables.find((candidate) => candidate.name === payload.table);
        if (record.kind === 2) {
          if (!table?.document || typeof payload.data !== "string") {
            throw new Error("target table or validator is absent");
          }
          assertValidator(table.document, decode(payload.data), `${payload.table} document`);
        } else if (record.kind === 3) {
          if (typeof payload.field !== "string") throw new Error("local field name is absent");
          const field = table?.localFields?.find((candidate) => candidate.field === payload.field);
          if (!field) throw new Error("target local field validator is absent");
          assertValidator(
            field.validator,
            decode(JSON.stringify(payload.value)),
            `${payload.table}.${payload.field} local field`,
          );
        } else {
          if (typeof payload.field !== "string" || typeof payload.kind !== "string") {
            throw new Error("CRDT field identity is absent");
          }
          const field = table?.crdtFields?.find((candidate) => candidate.field === payload.field);
          if (!field || field.kind !== payload.kind) {
            throw new Error("target CRDT field or kind is absent");
          }
        }
      } catch {
        await binding.migrationRecordDispositionWrite(
          generation,
          record.identityKey,
          record.kind,
          base64ToBytes(record.recordKey),
          "__finalize__",
          "unclaimed",
          false,
        );
        report.quarantined += 1;
        countReason(report, "unclaimed");
      }
    }
    cursor = page.cursor;
    if (page.records.length === 0) cursor = undefined;
  } while (cursor !== undefined);
}

interface MutableDeviceMigrationReport {
  activeGeneration: number;
  candidateGeneration: number;
  sourceContractHash: string;
  targetContractHash: string;
  created: boolean;
  resumed: boolean;
  required: boolean;
  scanned: number;
  migrated: number;
  quarantined: number;
  discarded: number;
  reasons: Record<string, number>;
}

function countReason(report: MutableDeviceMigrationReport, reason: string): void {
  report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
}

function freezeReport(report: MutableDeviceMigrationReport): DeviceMigrationReport {
  return Object.freeze({
    ...report,
    reasons: Object.freeze({ ...report.reasons }),
  });
}

function manifestForSchema(schema: StoreSchema): DeviceMigrationManifest {
  const definitions = schema.migrations ?? [];
  if (definitions.length === 0) {
    return { migrations: [], definitions: [], codeHash: schema.migrationCodeHash ?? "" };
  }
  const manifest = manifests.get(schema.migrationCodeHash ?? "");
  if (!manifest) {
    throw new Error("Device migration handlers are not loaded for this store contract");
  }
  if (canonicalJson(manifest.definitions) !== canonicalJson(definitions)) {
    throw new Error("Loaded device migration definitions do not match the store contract");
  }
  return manifest;
}

function selectorMatches(selector: CarrySelector, record: EncodedOriginRecord): boolean {
  if (record.kind !== selector.recordKind) return false;
  if (selector.kind === "record") return true;
  try {
    const payload = decodedRecordPayload(record).payload;
    return payload.table === selector.table;
  } catch {
    return false;
  }
}

function decodeRecord(selector: CarrySelector, record: EncodedOriginRecord): DeviceMigrationRecord {
  const { payload, quarantine } = decodedRecordPayload(record);
  const rawKey = base64ToBytes(record.recordKey);
  const value =
    selector.kind === "document" && typeof payload.data === "string"
      ? decode(payload.data)
      : payload;
  assertValidator(validatorJson(selector.value), value, "device migration source");
  const decoded: InternalMigrationRecord = {
    identityKey: record.identityKey,
    key: migrationRecordKey(record.identityKey, record.kind, rawKey),
    recordKey: rawKey,
    kind: record.kind,
    table: typeof payload.table === "string" ? payload.table : undefined,
    id: typeof payload.id === "string" ? payload.id : undefined,
    creationTime: typeof payload.creationTime === "number" ? payload.creationTime : undefined,
    quarantine,
    value,
    [sourceRecordKey]: rawKey,
  };
  return decoded;
}

function migrationRecordKey(identityKey: string, kind: number, recordKey: Uint8Array): Uint8Array {
  const identity = new TextEncoder().encode(identityKey);
  const key = new Uint8Array(4 + identity.length + 8 + recordKey.length);
  const view = new DataView(key.buffer);
  view.setUint32(0, identity.length);
  key.set(identity, 4);
  view.setBigInt64(4 + identity.length, BigInt(kind));
  key.set(recordKey, 4 + identity.length + 8);
  return key;
}

function decodedRecordPayload(record: EncodedOriginRecord): {
  payload: Record<string, unknown>;
  quarantine?: { migrationId: string; reason: string };
} {
  let bytes = base64ToBytes(record.payload);
  if (record.flags !== 1) {
    return {
      payload: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
    };
  }
  const disposition = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (
    typeof disposition.priorPayload !== "string" ||
    typeof disposition.migrationId !== "string" ||
    typeof disposition.reason !== "string"
  ) {
    throw new Error("Quarantined originated record has an invalid retained payload");
  }
  bytes = base64ToBytes(disposition.priorPayload);
  return {
    payload: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
    quarantine: {
      migrationId: disposition.migrationId,
      reason: disposition.reason,
    },
  };
}

function selectorDefinition(selector: CarrySelector): unknown {
  return selector.kind === "document"
    ? {
        kind: selector.kind,
        table: selector.table,
        value: validatorJson(selector.value),
        quarantined: selector.quarantined === true,
      }
    : {
        kind: selector.kind,
        recordKind: selector.recordKind,
        value: validatorJson(selector.value),
        quarantined: selector.quarantined === true,
      };
}

function validatorJson(validator: GenericValidator): ValidatorJSON {
  return (validator as GenericValidator & { json: ValidatorJSON }).json;
}

function assertValidator(validator: ValidatorJSON, value: unknown, path: string): void {
  if (matchesValidator(validator, value)) return;
  throw new Error(`${path} does not match its retained validator`);
}

function matchesValidator(validator: ValidatorJSON, value: unknown): boolean {
  switch (validator.type) {
    case "any":
      return true;
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "bigint":
      return typeof value === "bigint";
    case "boolean":
      return typeof value === "boolean";
    case "string":
    case "id":
      return typeof value === "string";
    case "bytes":
      return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    case "literal":
      return canonicalJson(convexToJson(value as never)) === canonicalJson(validator.value);
    case "array":
      return (
        Array.isArray(value) && value.every((entry) => matchesValidator(validator.value, entry))
      );
    case "union":
      return validator.value.some((member) => matchesValidator(member, value));
    case "object": {
      if (!isPlainObject(value)) return false;
      for (const [field, definition] of Object.entries(validator.value)) {
        if (!(field in value)) {
          if (!definition.optional) return false;
          continue;
        }
        if (!matchesValidator(definition.fieldType, value[field])) return false;
      }
      return Object.keys(value).every((field) => field in validator.value);
    }
    case "record": {
      if (!isPlainObject(value)) return false;
      return Object.entries(value).every(
        ([key, entry]) =>
          matchesValidator(validator.keys, key) &&
          matchesValidator(validator.values.fieldType, entry),
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function originKey(parts: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  const size = encoded.reduce((total, part) => total + 8 + part.length, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setBigUint64(offset, BigInt(part.length), false);
    offset += 8;
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const SIGN_BIT = 1n << 63n;
const U64_MASK = (1n << 64n) - 1n;

function encodeColKey(value: ColValue): Uint8Array {
  if (value === undefined) return new Uint8Array([0]);
  if (value === null) return new Uint8Array([1]);
  if (typeof value === "bigint") {
    const output = new Uint8Array(9);
    output[0] = 2;
    new DataView(output.buffer).setBigUint64(1, BigInt.asUintN(64, value) ^ SIGN_BIT, false);
    return output;
  }
  if (typeof value === "number") {
    const scratch = new ArrayBuffer(8);
    const view = new DataView(scratch);
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const key = (bits & SIGN_BIT) !== 0n ? ~bits & U64_MASK : bits ^ SIGN_BIT;
    const output = new Uint8Array(9);
    output[0] = 3;
    new DataView(output.buffer).setBigUint64(1, key, false);
    return output;
  }
  if (typeof value === "boolean") return new Uint8Array([4, value ? 1 : 0]);
  const text = new TextEncoder().encode(value);
  const output = new Uint8Array(text.length + 1);
  output[0] = 5;
  output.set(text, 1);
  return output;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
