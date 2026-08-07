import type { Validator } from "convex/values";

import { validateValue } from "./validate";
import type { RuntimeStorage, StoredDoc } from "../storage/types";

/** One decoded record from a pre-cutover device table. @public */
export type LedgerDoc<Value extends object> = Readonly<
  Value & {
    _creationTime: number;
    _id: string;
  }
>;

/** One bounded page from a historical device table while `client.open(setup)` is running. @public */
export interface LedgerPage<Value extends object> {
  readonly cursor: string | null;
  readonly docs: readonly LedgerDoc<Value>[];
}

/** Input for one bounded historical device-table read. @public */
export interface LedgerRead<Value extends object> {
  readonly cursor?: string | null;
  readonly pageSize?: number;
  readonly table: string;
  /** The historical document shape expected by this setup step. */
  readonly validator: Validator<Value, any, any>;
}

/**
 * The candidate generation's frozen pre-cutover device records.
 *
 * This capability exists only while a `client.open(setup)` action is executing. It is read-only
 * except for explicit deletion of consumed device records; setup writes transformed records through
 * ordinary current-schema local mutations.
 */
export interface LedgerReader {
  /** Remove one consumed historical record after its replacement has committed. */
  delete(request: { readonly id: string; readonly table: string }): Promise<void>;
  read<Value extends object>(request: LedgerRead<Value>): Promise<LedgerPage<Value>>;
}

/** Create the candidate-only ledger reader over the already-bound setup workspace. @internal */
export function createLedgerReader(
  store: RuntimeStorage,
  isAvailable: () => boolean,
  erase: (table: string, id: string) => Promise<void>,
  isDeviceTable: (table: string) => boolean,
): LedgerReader {
  return {
    async delete(request) {
      if (!isAvailable()) {
        throw new Error("ctx.ledger is available only while client.open(setup) is running.");
      }
      if (!request.table || !request.id) {
        throw new Error("ctx.ledger.delete requires a table name and record id.");
      }
      if (!isDeviceTable(request.table)) {
        throw new Error("ctx.ledger only permits device table records.");
      }
      await erase(request.table, request.id);
    },
    async read<Value extends object>(request: LedgerRead<Value>): Promise<LedgerPage<Value>> {
      if (!isAvailable()) {
        throw new Error("ctx.ledger is available only while client.open(setup) is running.");
      }
      if (!request.table) throw new Error("ctx.ledger.read requires a table name.");
      if (!isDeviceTable(request.table)) {
        throw new Error("ctx.ledger only permits device table records.");
      }
      const pageSize = request.pageSize ?? 256;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 512) {
        throw new RangeError("ctx.ledger.read pageSize must be an integer from 1 through 512.");
      }
      const page = await store.doc.page.read({
        cursor: request.cursor ?? undefined,
        order: "asc",
        pageSize,
        table: request.table,
      });
      return {
        cursor: page.cursor,
        docs: page.docs.map((doc) => decodeLedgerDoc(doc, request)),
      };
    },
  };
}

function decodeLedgerDoc<Value extends object>(
  doc: StoredDoc,
  request: LedgerRead<Value>,
): LedgerDoc<Value> {
  const { _creationTime, _id, ...value } = doc;
  validateValue(value, request.validator, `ledger ${request.table}:${_id}`);
  return { ...value, _creationTime, _id } as LedgerDoc<Value>;
}
