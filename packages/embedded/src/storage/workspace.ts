import { sha256Text } from "../sha";
import type { StoreSchema, TableDef } from "./types";

/**
 * The private schema used while an `open(setup)` action runs. It deliberately contains tables
 * that have been removed from the target so skipped releases can move their remaining data. It
 * never becomes the published schema: finalization validates and cuts over using the target.
 *
 * @internal
 */
export function setupWorkspaceSchema(source: StoreSchema, target: StoreSchema): StoreSchema {
  const tables = new Map<string, TableDef>();
  // The source remains bound only while setup runs, so ctx.ledger can read data from tables which
  // the target has removed. The target remains authoritative for every published name at cutover.
  for (const schema of [source, target]) {
    for (const table of schema.tables) {
      const prior = tables.get(table.name);
      tables.set(table.name, prior === undefined ? cloneTable(table) : mergeTable(prior, table));
    }
  }
  const materialized = [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return {
    ...target,
    hash: sha256Text(JSON.stringify(materialized)),
    tables: materialized,
  };
}

function sameIndex(left: TableDef["indexes"][number], right: TableDef["indexes"][number]): boolean {
  return (
    JSON.stringify([left.fields, left.columns ?? []]) ===
    JSON.stringify([right.fields, right.columns ?? []])
  );
}

function cloneTable(table: TableDef): TableDef {
  return {
    ...table,
    columns: [...table.columns],
    crdtFields: table.crdtFields === undefined ? undefined : [...table.crdtFields],
    localFields: table.localFields === undefined ? undefined : [...table.localFields],
    indexes: [...table.indexes],
  };
}

function mergeTable(left: TableDef, right: TableDef): TableDef {
  if (left.placement !== right.placement) {
    throw new Error(
      `Setup workspace table conflict for ${left.name}: ${left.placement} and ${right.placement}`,
    );
  }
  // The second schema is authoritative for this merge. Callers merge historical schemas first
  // and the target last, so source-only projection pieces become private aliases while target
  // public names always win.
  const targetColumns = new Map(right.columns.map((column) => [column.name, column]));
  const renamedColumns = new Map<string, string>();
  const columnNames = new Set([...left.columns, ...right.columns].map((column) => column.name));
  const legacyColumns = left.columns.flatMap((column) => {
    const target = targetColumns.get(column.name);
    if (
      target !== undefined &&
      JSON.stringify([target.field ?? target.name]) !==
        JSON.stringify([column.field ?? column.name])
    ) {
      const name = workspaceName("column", column.name, column, columnNames);
      renamedColumns.set(column.name, name);
      return [{ ...column, name }];
    }
    return target === undefined ? [column] : [];
  });
  const columns = [...legacyColumns, ...right.columns];
  const targetIndexes = new Map(right.indexes.map((index) => [index.name, index]));
  const indexNames = new Set([...left.indexes, ...right.indexes].map((index) => index.name));
  const indexes = [
    ...left.indexes.flatMap((index) => {
      const target = targetIndexes.get(index.name);
      const legacy = {
        ...index,
        columns: (index.columns ?? index.fields).map(
          (column) => renamedColumns.get(column) ?? column,
        ),
      };
      if (target === undefined) return [legacy];
      if (sameIndex(target, index)) {
        return [];
      }
      return [{ ...legacy, name: workspaceName("index", index.name, legacy, indexNames) }];
    }),
    ...right.indexes,
  ];
  return {
    ...left,
    ...right,
    document: right.document ?? left.document,
    columns,
    crdtFields: targetAuthority(
      left.name,
      "CRDT field",
      left.crdtFields ?? [],
      right.crdtFields ?? [],
    ),
    localFields: targetAuthority(
      left.name,
      "local field",
      left.localFields ?? [],
      right.localFields ?? [],
    ),
    indexes,
  };
}

function targetAuthority<T extends { name?: string; field?: string }>(
  table: string,
  kind: string,
  left: readonly T[],
  right: readonly T[],
): T[] {
  const entries = new Map<string, T>();
  for (const value of left) {
    const name = value.name ?? value.field;
    if (name === undefined) throw new Error(`Setup workspace ${kind} has no name in ${table}`);
    entries.set(name, value);
  }
  for (const value of right) {
    const name = value.name ?? value.field;
    if (name === undefined) throw new Error(`Setup workspace ${kind} has no name in ${table}`);
    entries.set(name, value);
  }
  return [...entries.values()];
}

function workspaceName(
  kind: "column" | "index",
  name: string,
  definition: unknown,
  reserved: Set<string>,
): string {
  // Authored identifiers may already consume the obvious prefix, and skipped releases can carry
  // several incompatible definitions under the same public name. A content-derived private name
  // is deterministic across retries, unique within this workspace, and stays below Rust's 64-byte
  // identifier limit regardless of the authored name length.
  let attempt = 0;
  while (true) {
    const hash = sha256Text(JSON.stringify([kind, name, definition, attempt])).slice(0, 40);
    const candidate = `setup_${kind === "column" ? "c" : "i"}_${hash}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
    attempt += 1;
  }
}
