import { pointerPart } from "./id/path";

export type ResultInsert = {
  ordinal: number;
  table: string;
  id: string;
};

export type ResultIdReference = { path: string; table: string };
export type ResultArgumentId = ResultIdReference & { id: string };

export function normalizeMutationResult(
  value: unknown,
  mutationId: string,
  inserts: readonly ResultInsert[],
  schedules: readonly string[],
  uploads: readonly string[],
  idReferences: readonly ResultIdReference[],
  hostedIds: Readonly<Record<string, string>> = {},
  crdtFields: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  argumentIds: readonly ResultArgumentId[] = [],
): unknown {
  const byId = new Map(inserts.map((insert) => [insert.id, insert]));
  const scheduleOrdinals = new Map(schedules.map((id, ordinal) => [id, ordinal]));
  const uploadOrdinals = new Map(uploads.map((url, ordinal) => [url, ordinal]));
  const argumentIdsById = new Map<string, ResultArgumentId>();
  for (const argument of argumentIds) {
    if (!argumentIdsById.has(argument.id)) argumentIdsById.set(argument.id, argument);
  }
  return normalize(
    value,
    mutationId,
    byId,
    scheduleOrdinals,
    uploadOrdinals,
    new Map(idReferences.map((reference) => [reference.path, reference.table])),
    hostedIds,
    crdtFields,
    argumentIdsById,
    "",
    undefined,
  );
}

type ResultDocument = { table: string; path: string };

function normalize(
  value: unknown,
  mutationId: string,
  byId: ReadonlyMap<string, ResultInsert>,
  scheduleOrdinals: ReadonlyMap<string, number>,
  uploadOrdinals: ReadonlyMap<string, number>,
  idReferences: ReadonlyMap<string, string>,
  hostedIds: Readonly<Record<string, string>>,
  crdtFields: ReadonlyMap<string, ReadonlySet<string>>,
  argumentIds: ReadonlyMap<string, ResultArgumentId>,
  path: string,
  document: ResultDocument | undefined,
): unknown {
  if (document !== undefined) {
    const field = documentField(document.path, path);
    if (field !== undefined && crdtFields.get(document.table)?.has(field)) {
      return { kind: "crdt", table: document.table, field };
    }
  }
  if (typeof value === "string") {
    const uploadOrdinal = uploadOrdinals.get(value);
    if (uploadOrdinal !== undefined) {
      return { kind: "upload", mutationId, ordinal: uploadOrdinal };
    }
    const table = idReferences.get(path);
    if (table === undefined) {
      return hostedIds[path] ?? value;
    }
    const insert = byId.get(value);
    const scheduleOrdinal = scheduleOrdinals.get(value);
    if (table === "_scheduled_functions" && scheduleOrdinal !== undefined) {
      return { kind: "schedule", mutationId, ordinal: scheduleOrdinal };
    }
    const argument = argumentIds.get(value);
    if (argument?.table === table) {
      return { kind: "argument", table, path: argument.path };
    }
    return insert === undefined
      ? { kind: "hosted", table, id: hostedIds[path] ?? value }
      : insertMarker(mutationId, insert);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalize(
        item,
        mutationId,
        byId,
        scheduleOrdinals,
        uploadOrdinals,
        idReferences,
        hostedIds,
        crdtFields,
        argumentIds,
        `${path}/${index}`,
        document,
      ),
    );
  }
  if (value === null || typeof value !== "object" || value instanceof ArrayBuffer) return value;

  const object = value as Record<string, unknown>;
  const table = idReferences.get(`${path}/_id`);
  const currentDocument = table === undefined ? document : { table, path };
  const documentInsert =
    typeof object._id === "string" && idReferences.has(`${path}/_id`)
      ? byId.get(object._id)
      : undefined;
  const documentArgument =
    typeof object._id === "string" && table !== undefined ? argumentIds.get(object._id) : undefined;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      key === "_creationTime" && documentInsert !== undefined
        ? { kind: "insertCreationTime", mutationId, ordinal: documentInsert.ordinal }
        : key === "_creationTime" && table !== undefined && typeof object._id === "string"
          ? documentArgument?.table === table
            ? { kind: "argumentCreationTime", table, path: documentArgument.path }
            : {
                kind: "documentCreationTime",
                table,
                id: hostedIds[`${path}/_id`] ?? object._id,
              }
          : normalize(
              child,
              mutationId,
              byId,
              scheduleOrdinals,
              uploadOrdinals,
              idReferences,
              hostedIds,
              crdtFields,
              argumentIds,
              `${path}/${pointerPart(key)}`,
              currentDocument,
            ),
    ]),
  );
}

function documentField(root: string, path: string): string | undefined {
  if (path === root || !path.startsWith(`${root}/`)) return undefined;
  return path
    .slice(root.length + 1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function insertMarker(mutationId: string, insert: ResultInsert): unknown {
  return {
    kind: "insert",
    mutationId,
    ordinal: insert.ordinal,
    table: insert.table,
  };
}
