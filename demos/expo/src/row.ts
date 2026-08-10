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
