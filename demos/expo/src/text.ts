import type { Block, PartialBlock } from "@blocknote/core";

import type { DocumentWrite, EditorDraft, TextSplice } from "./types";

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

export function textSplice(before: string, after: string): TextSplice | undefined {
  if (before === after) return undefined;

  const beforeChars = Array.from(before);
  const afterChars = Array.from(after);
  let prefix = 0;
  const prefixLimit = Math.min(beforeChars.length, afterChars.length);
  while (prefix < prefixLimit && beforeChars[prefix] === afterChars[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(beforeChars.length - prefix, afterChars.length - prefix);
  while (
    suffix < suffixLimit &&
    beforeChars[beforeChars.length - 1 - suffix] === afterChars[afterChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    delete: beforeChars.slice(prefix, beforeChars.length - suffix).join("").length,
    index: beforeChars.slice(0, prefix).join("").length,
    insert: afterChars.slice(prefix, afterChars.length - suffix).join(""),
  };
}

export function documentWrite(
  id: string,
  persisted: EditorDraft,
  desired: EditorDraft,
): DocumentWrite | undefined {
  if (sameDraft(persisted, desired)) return undefined;
  const splice = textSplice(persisted.body, desired.body);
  return {
    id,
    splices: splice ? [splice] : [],
    ...(persisted.title === desired.title ? {} : { title: desired.title }),
  };
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

export function sameDraft(left: EditorDraft, right: EditorDraft): boolean {
  return left.body === right.body && left.title === right.title;
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
