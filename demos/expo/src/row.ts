import type { api } from "$convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type DocumentSummary = FunctionReturnType<typeof api.documents.read>[number];

export type DocumentRowProps = {
  document: DocumentSummary;
  expanded: boolean;
  opening: boolean;
  pinned: boolean;
  onOpen: (id: DocumentSummary["_id"]) => void;
  onToggleExpanded: (id: DocumentSummary["_id"]) => void | Promise<void>;
  onTogglePin: (id: DocumentSummary["_id"]) => void | Promise<void>;
};

export type DocumentListItem = Pick<
  DocumentRowProps,
  "document" | "expanded" | "opening" | "pinned"
>;

/** Build the native list order in one pass while preserving the query's relative order. */
export function documentListItems(
  documents: readonly DocumentSummary[],
  pinnedIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  openingId: string | null,
): DocumentListItem[] {
  if (pinnedIds.size === 0) {
    return documents.map((document) =>
      documentListItem(document, pinnedIds, expandedIds, openingId),
    );
  }

  const pinned: DocumentListItem[] = [];
  const unpinned: DocumentListItem[] = [];
  for (const document of documents) {
    const item = documentListItem(document, pinnedIds, expandedIds, openingId);
    (item.pinned ? pinned : unpinned).push(item);
  }
  return [...pinned, ...unpinned];
}

/** Avoid a list render when an unrelated local-query invalidation returns the same ids. */
export function documentIdSetsAreEqual(
  current: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  if (current.size !== next.size) return false;
  for (const id of current) {
    if (!next.has(id)) return false;
  }
  return true;
}

function documentListItem(
  document: DocumentSummary,
  pinnedIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  openingId: string | null,
): DocumentListItem {
  return {
    document,
    expanded: expandedIds.has(document._id),
    opening: openingId === document._id,
    pinned: pinnedIds.has(document._id),
  };
}

/** Compare only the fields that change the native row's rendered output or behavior. */
export function documentRowIsEqual(left: DocumentRowProps, right: DocumentRowProps): boolean {
  return (
    left.document._id === right.document._id &&
    left.document.slug === right.document.slug &&
    left.document.title === right.document.title &&
    left.document.updatedAt === right.document.updatedAt &&
    left.expanded === right.expanded &&
    left.opening === right.opening &&
    left.pinned === right.pinned &&
    left.onOpen === right.onOpen &&
    left.onToggleExpanded === right.onToggleExpanded &&
    left.onTogglePin === right.onTogglePin
  );
}
