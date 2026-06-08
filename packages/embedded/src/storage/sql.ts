import type { Bound, CountSpec, Param, ScanSpec, TableDef } from "./types";

export type CompileResult =
  | { kind: "sql"; sql: string; columns: string[] }
  | { kind: "miss" }
  | { kind: "unsatisfiable"; reason: string };

export const SCAN_CAP = 32_768;
const SELECT_COLS = "id, creation_time_ms, data";

export function compileScan(spec: ScanSpec, table: TableDef): CompileResult {
  const cols = planColumns(spec.index, table);
  if (cols === "miss") return { kind: "miss" };
  if (spec.seek) return { kind: "miss" };

  const w = boundsClause(spec.bounds ?? [], cols);
  if (w.kind === "unsatisfiable") return w;

  const orderCols = cols.length ? [...cols, "creation_time_ms", "id"] : ["creation_time_ms", "id"];
  const dir = spec.order === "desc" ? " DESC" : "";
  const orderBy = orderCols.map((c) => `${c}${dir}`).join(", ");

  const sql =
    `SELECT ${SELECT_COLS} FROM doc__${table.name} ` +
    `WHERE identity_key = ?${w.clause} ORDER BY ${orderBy} LIMIT ?`;
  return { kind: "sql", sql, columns: orderCols };
}

export function compileCount(spec: CountSpec, table: TableDef): CompileResult {
  const cols = planColumns(spec.index, table);
  if (cols === "miss") return { kind: "miss" };

  const w = boundsClause(spec.bounds ?? [], cols);
  if (w.kind === "unsatisfiable") return w;

  const sql = `SELECT COUNT(*) AS n FROM doc__${table.name} WHERE identity_key = ?${w.clause}`;
  return { kind: "sql", sql, columns: ["n"] };
}

// Params are value-derived, so they are bound fresh per call — never cached with the SQL template.
// The order mirrors boundsClause's placeholders exactly.
export function scanParams(spec: ScanSpec): Param[] {
  // An unbounded scan fetches one past the cap so the store can detect (and loudly reject) overflow.
  return [...boundsParams(spec.bounds ?? []), spec.limit ?? SCAN_CAP + 1];
}

export function countParams(spec: CountSpec): Param[] {
  return boundsParams(spec.bounds ?? []);
}

export function scanKey(spec: ScanSpec): string {
  return `s|${spec.table}|${spec.index ?? "@pk"}|${boundsShape(spec.bounds)}|${spec.order}|${spec.seek ? "k" : ""}|${spec.limit !== undefined ? "l" : ""}`;
}

export function countKey(spec: CountSpec): string {
  return `c|${spec.table}|${spec.index ?? "@pk"}|${boundsShape(spec.bounds)}`;
}

function planColumns(index: string | undefined, table: TableDef): string[] | "miss" {
  if (!index) return [];
  const def = table.indexes.find((i) => i.name === index);
  return def ? def.fields : "miss";
}

type ClauseResult = { kind: "ok"; clause: string } | { kind: "unsatisfiable"; reason: string };

function boundsClause(bounds: Bound[], cols: string[]): ClauseResult {
  const target = cols.length ? cols : ["id"];
  if (bounds.length > target.length) {
    return { kind: "unsatisfiable", reason: "more bounds than indexed columns" };
  }
  const clauses: string[] = [];
  let seenRange = false;
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i]!;
    if (seenRange) return { kind: "unsatisfiable", reason: "bound follows a range bound" };
    const col = target[i]!;
    if (b.kind === "eq") {
      clauses.push(`${col} = ?`);
    } else {
      seenRange = true;
      if (b.lower !== undefined) clauses.push(`${col} ${b.lowerInclusive ? ">=" : ">"} ?`);
      if (b.upper !== undefined) clauses.push(`${col} ${b.upperInclusive ? "<=" : "<"} ?`);
    }
  }
  return { kind: "ok", clause: clauses.length ? ` AND ${clauses.join(" AND ")}` : "" };
}

function boundsParams(bounds: Bound[]): Param[] {
  const params: Param[] = [];
  for (const b of bounds) {
    if (b.kind === "eq") {
      params.push(b.value);
    } else {
      if (b.lower !== undefined) params.push(b.lower);
      if (b.upper !== undefined) params.push(b.upper);
    }
  }
  return params;
}

function boundsShape(bounds?: Bound[]): string {
  if (!bounds) return "";
  return bounds
    .map((b) => {
      if (b.kind === "eq") return "eq";
      const lo = b.lower !== undefined ? (b.lowerInclusive ? "L" : "l") : "";
      const hi = b.upper !== undefined ? (b.upperInclusive ? "U" : "u") : "";
      return `r${lo}${hi}`;
    })
    .join(",");
}
