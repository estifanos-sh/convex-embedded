import type { Block, PartialBlock } from "@blocknote/core";

import type { EditorDraft } from "./types";

export const recoveryVersion = 2;

export type RecoveryRecord = {
  base: string;
  draft: EditorDraft;
  version: typeof recoveryVersion;
};

export type RecoveryDecision = {
  draft: EditorDraft;
  recovered: boolean;
  remove: boolean;
};

export type TitleRecoveryRecord = {
  baseTitle: string;
  title: string;
  version: 1;
};

export type TitleRecoveryDecision = {
  recovered: boolean;
  remove: boolean;
  title: string;
};

export const emptyBlocks: PartialBlock[] = [
  {
    type: "heading",
    props: { level: 1 },
    content: "Untitled",
  },
  { type: "paragraph", content: "" },
];

export function parseBlocks(body: string): PartialBlock[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as PartialBlock[]) : emptyBlocks;
  } catch {
    return emptyBlocks;
  }
}

export function documentBlocks(body: string, title: string): PartialBlock[] {
  const blocks = parseBlocks(body);
  const titleBlock: PartialBlock = {
    ...blocks[0],
    type: "heading",
    props: { ...blocks[0]?.props, level: 1 },
    content: title,
  };
  return [titleBlock, ...blocks.slice(1)];
}

export function normalizeDocumentDraft(draft: EditorDraft): EditorDraft {
  return { ...draft, body: JSON.stringify(documentBlocks(draft.body, draft.title)) };
}

export function draftFingerprint(draft: EditorDraft): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  const write = (value: number): void => {
    left = Math.imul(left ^ value, 0x01000193);
    right = Math.imul(right ^ value, 0x85ebca6b);
    right ^= right >>> 13;
  };

  write(draft.title.length);
  for (let index = 0; index < draft.title.length; index += 1) write(draft.title.charCodeAt(index));
  write(draft.body.length);
  for (let index = 0; index < draft.body.length; index += 1) write(draft.body.charCodeAt(index));

  return `${draft.body.length.toString(36)}.${draft.title.length.toString(36)}.${(
    left >>> 0
  ).toString(36)}.${(right >>> 0).toString(36)}`;
}

export function recoveryRecord(base: string, draft: EditorDraft): RecoveryRecord {
  return { base, draft, version: recoveryVersion };
}

export function recoveryEncode(record: RecoveryRecord): string {
  const header = JSON.stringify({
    base: record.base,
    title: record.draft.title,
    version: record.version,
  });
  return `${header}\n${record.draft.body}`;
}

export function recoveryDecode(encoded: string): unknown {
  const separator = encoded.indexOf("\n");
  if (separator < 0) return undefined;
  const header = JSON.parse(encoded.slice(0, separator)) as unknown;
  if (!header || typeof header !== "object") return undefined;
  const value = header as { base?: unknown; title?: unknown; version?: unknown };
  return {
    base: value.base,
    draft: { body: encoded.slice(separator + 1), title: value.title },
    version: value.version,
  };
}

export function recoveryDecision(native: EditorDraft, candidate: unknown): RecoveryDecision {
  if (!isRecoveryRecord(candidate)) return { draft: native, recovered: false, remove: true };
  if (sameDraft(native, candidate.draft)) {
    return { draft: native, recovered: false, remove: true };
  }
  if (candidate.base === draftFingerprint(native)) {
    return { draft: candidate.draft, recovered: true, remove: false };
  }
  return { draft: native, recovered: false, remove: true };
}

export function titleRecoveryRecord(baseTitle: string, title: string): TitleRecoveryRecord {
  return { baseTitle, title, version: 1 };
}

export function titleRecoveryDecision(
  nativeTitle: string,
  candidate: unknown,
): TitleRecoveryDecision {
  if (!isTitleRecoveryRecord(candidate)) {
    return { recovered: false, remove: true, title: nativeTitle };
  }
  if (candidate.title === nativeTitle) {
    return { recovered: false, remove: true, title: nativeTitle };
  }
  if (candidate.baseTitle === nativeTitle) {
    return { recovered: true, remove: false, title: candidate.title };
  }
  return { recovered: false, remove: true, title: nativeTitle };
}

export function sameDraft(left: EditorDraft, right: EditorDraft): boolean {
  return left.body === right.body && left.title === right.title;
}

export function isEmptyTable(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const candidate = block as { content?: unknown; type?: unknown };
  if (candidate.type !== "table" || !candidate.content || typeof candidate.content !== "object") {
    return false;
  }

  const rows = (candidate.content as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let cells = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") return false;
    const rowCells = (row as { cells?: unknown }).cells;
    if (!Array.isArray(rowCells) || rowCells.length === 0) return false;
    for (const cell of rowCells) {
      cells += 1;
      if (Array.isArray(cell)) {
        if (cell.length > 0) return false;
        continue;
      }
      if (!cell || typeof cell !== "object" || !("type" in cell)) return false;
      const content = (cell as { content?: unknown }).content;
      if (!Array.isArray(content) || content.length > 0) return false;
    }
  }
  return cells > 0;
}

export function titleFromBlocks(blocks: readonly (PartialBlock | Block)[]): string {
  const titleBlock = blocks[0];
  return titleBlock ? blockText(titleBlock).trim().slice(0, 90) : "";
}

function blockText(block: PartialBlock | Block): string {
  const content = "content" in block ? block.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RecoveryRecord>;
  return (
    record.version === recoveryVersion &&
    typeof record.base === "string" &&
    !!record.draft &&
    typeof record.draft === "object" &&
    typeof record.draft.body === "string" &&
    typeof record.draft.title === "string"
  );
}

function isTitleRecoveryRecord(value: unknown): value is TitleRecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TitleRecoveryRecord>;
  return (
    record.version === 1 && typeof record.baseTitle === "string" && typeof record.title === "string"
  );
}
