import { PlanCache } from "./cache";
import { type Clock, createClock } from "./clock";
import { decode, encode } from "../runtime/codec";
import {
  type CompileResult,
  SCAN_CAP,
  compileCount,
  compileScan,
  countKey,
  countParams,
  scanKey,
  scanParams,
} from "./sql";
import type {
  BoundParam,
  Connection,
  CountSpec,
  EmbeddedStoreBackend,
  IdentityKey,
  Param,
  Row,
  ScanSpec,
  StoredDocData,
  Statement,
  StoreSchema,
  StoredDoc,
  TableDef,
  WriteBatch,
} from "./types";

const SELECT_DOC = "id, creation_time_ms, data";
const RESERVED = new Set(["id", "identity_key", "creation_time_ms", "data"]);

export class EmbeddedStore implements EmbeddedStoreBackend {
  private readonly tables = new Map<string, TableDef>();
  private readonly plans = new PlanCache<CompileResult>();
  private readonly stmts = new Map<string, Promise<Statement>>();
  private readonly clock: Clock = createClock();

  private constructor(
    private readonly db: Connection,
    private readonly identityKey: IdentityKey,
  ) {}

  static open(db: Connection, identityKey: IdentityKey = ""): EmbeddedStore {
    return new EmbeddedStore(db, identityKey);
  }

  async setup(schema: StoreSchema): Promise<void> {
    for (const table of schema.tables) {
      validateIdent(table.name);
      const extra = table.columns
        .map((c) => {
          validateIdent(c.name);
          if (RESERVED.has(c.name)) throw new Error(`reserved column name: ${c.name}`);
          return `, ${c.name} ${c.affinity}`;
        })
        .join("");
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS doc__${table.name} ` +
          `(id TEXT NOT NULL, identity_key TEXT NOT NULL, creation_time_ms REAL NOT NULL, ` +
          `data json NOT NULL${extra}, PRIMARY KEY (identity_key, id)) STRICT`,
      );
      for (const index of table.indexes) {
        validateIdent(index.name);
        for (const field of index.fields) validateIdent(field);
        await this.db.exec(
          `CREATE INDEX IF NOT EXISTS ix__${table.name}__${index.name} ` +
            `ON doc__${table.name} (identity_key, ${index.fields.join(", ")}, creation_time_ms, id)`,
        );
      }
      this.tables.set(table.name, table);
    }
    this.plans.clear();
    this.clock.observe(await this.maxCreationTime());
  }

  nextCreationTime(): number {
    return this.clock.now();
  }

  private async maxCreationTime(): Promise<number> {
    let max = 0;
    for (const name of this.tables.keys()) {
      const rows = await this.all(
        `SELECT MAX(creation_time_ms) AS m FROM doc__${name} WHERE identity_key = ?`,
        [this.identityKey],
      );
      const m = rows[0]?.m;
      if (typeof m === "number" && m > max) max = m;
    }
    return max;
  }

  async clear(): Promise<void> {
    for (const name of this.tables.keys()) {
      await this.run(`DELETE FROM doc__${name} WHERE identity_key = ?`, [this.identityKey]);
    }
  }

  async get(table: string, id: string): Promise<StoredDoc | undefined> {
    this.def(table);
    const rows = await this.all(
      `SELECT ${SELECT_DOC} FROM doc__${table} WHERE identity_key = ? AND id = ?`,
      [this.identityKey, id],
    );
    return rows[0] ? rowToDoc(rows[0]) : undefined;
  }

  async scan(spec: ScanSpec): Promise<StoredDoc[] | null> {
    const table = this.def(spec.table);
    if (spec.limit !== undefined && spec.limit > SCAN_CAP) {
      throw new Error(`unsatisfiable scan: limit ${spec.limit} exceeds ${SCAN_CAP}`);
    }
    const compiled = this.compile(scanKey(spec), () => compileScan(spec, table));
    if (compiled.kind === "miss") return null;
    if (compiled.kind === "unsatisfiable")
      throw new Error(`unsatisfiable scan: ${compiled.reason}`);
    const rows = await this.all(compiled.sql, [this.identityKey, ...scanParams(spec)]);
    if (spec.limit === undefined && rows.length > SCAN_CAP) {
      throw new Error(`scan exceeded ${SCAN_CAP} documents; add an index bound or a limit`);
    }
    return rows.map(rowToDoc);
  }

  async count(spec: CountSpec): Promise<number | null> {
    const table = this.def(spec.table);
    const compiled = this.compile(countKey(spec), () => compileCount(spec, table));
    if (compiled.kind === "miss") return null;
    if (compiled.kind === "unsatisfiable")
      throw new Error(`unsatisfiable count: ${compiled.reason}`);
    const rows = await this.all(compiled.sql, [this.identityKey, ...countParams(spec)]);
    return Number(rows[0]?.n ?? 0);
  }

  async commit(batch: WriteBatch): Promise<void> {
    await this.transaction(async () => {
      for (const up of batch.upserts) {
        const def = this.def(up.table);
        const cols = def.columns.map((c) => c.name);
        const colValues = cols.map((c) => up.cols[c] ?? null);
        await this.run(
          `INSERT OR REPLACE INTO doc__${up.table} ` +
            `(id, identity_key, creation_time_ms, data${cols.length ? ", " + cols.join(", ") : ""}) ` +
            `VALUES (?, ?, ?, ?${cols.map(() => ", ?").join("")})`,
          [up.id, this.identityKey, up.creationTime, encodeData(up.data), ...colValues],
        );
      }
      for (const del of batch.deletes) {
        this.def(del.table);
        await this.run(`DELETE FROM doc__${del.table} WHERE identity_key = ? AND id = ?`, [
          this.identityKey,
          del.id,
        ]);
      }
    });
  }

  async close(): Promise<void> {
    this.stmts.clear();
    await this.db.close();
  }

  private def(table: string): TableDef {
    const def = this.tables.get(table);
    if (!def) throw new Error(`unknown table (not set up): ${table}`);
    return def;
  }

  private compile(key: string, build: () => CompileResult): CompileResult {
    let compiled = this.plans.get(key);
    if (compiled === undefined) {
      compiled = build();
      this.plans.set(key, compiled);
    }
    return compiled;
  }

  private stmt(sql: string): Promise<Statement> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private async run(sql: string, params: Param[]): Promise<void> {
    await (await this.stmt(sql)).run(...bind(params));
  }

  private async all(sql: string, params: Param[]): Promise<Row[]> {
    return (await (await this.stmt(sql)).all(...bind(params))) as Row[];
  }

  private async transaction(fn: () => Promise<void>): Promise<void> {
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      await fn();
      await this.db.exec("COMMIT");
    } catch (e) {
      await this.db.exec("ROLLBACK").catch(() => {});
      throw e;
    }
  }
}

function validateIdent(name: string): void {
  const ok =
    name.length > 0 && name.length <= 64 && !/^[0-9]/.test(name) && /^[A-Za-z0-9_]+$/.test(name);
  if (!ok) throw new Error(`invalid identifier: ${JSON.stringify(name)}`);
}

function encodeData(value: StoredDocData): string {
  return encode(value);
}

function rowToDoc(row: Row): StoredDoc {
  const data = decode(row.data as string);
  if (!isRecord(data)) throw new Error("stored document data must be an object");
  return {
    _id: row.id as string,
    _creationTime: row.creation_time_ms as number,
    data,
  };
}

function bind(params: Param[]): BoundParam[] {
  return params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
}

function isRecord(value: unknown): value is StoredDocData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
