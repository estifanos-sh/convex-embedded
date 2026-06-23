/// <reference lib="dom" />

import { json as jsonLanguage, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { basicSetup, EditorView } from "codemirror";
import { button, el } from "../dom";

export interface JsonEditor {
  element: HTMLElement;
  destroy(): void;
  focus(): void;
  setValue(value: string): void;
  value(): string;
}

export function jsonEditor(options: {
  minHeight?: number;
  onChange?: (value: string) => void;
  value: string;
}): JsonEditor {
  const editor = el("div", { className: "ce-json-codemirror" });
  if (options.minHeight !== undefined) {
    editor.style.setProperty("--ce-json-editor-min-height", `${options.minHeight}px`);
  }
  const diagnostic = el("div", { className: "ce-json-diagnostic" });
  const host = el("div", { className: "ce-json-editor" }, editor, diagnostic);

  const validate = (value: string) => {
    try {
      JSON.parse(value);
      diagnostic.textContent = "";
      diagnostic.dataset.tone = "success";
    } catch (error) {
      diagnostic.textContent = error instanceof Error ? error.message : String(error);
      diagnostic.dataset.tone = "error";
    }
  };

  const view = new EditorView({
    doc: options.value,
    extensions: [
      basicSetup,
      jsonLanguage(),
      lintGutter(),
      linter(jsonParseLinter(), { delay: 250 }),
      EditorView.lineWrapping,
      jsonEditorTheme,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const value = update.state.doc.toString();
        options.onChange?.(value);
        validate(value);
      }),
    ],
    parent: editor,
  });
  validate(options.value);

  return {
    element: host,
    destroy() {
      view.destroy();
    },
    focus: () => view.focus(),
    setValue(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    value: () => view.state.doc.toString(),
  };
}

const jsonEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--ce-foreground-primary)",
      fontSize: "12px",
      minHeight: "var(--ce-json-editor-min-height, 180px)",
    },
    "&.cm-focused": {
      outline: "0",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--ce-background-secondary)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--ce-background-secondary)",
      color: "var(--ce-foreground-muted)",
    },
    ".cm-content": {
      caretColor: "var(--ce-foreground-primary)",
      padding: "10px 0",
    },
    ".cm-diagnostic": {
      backgroundColor: "var(--ce-background-raised)",
      border: "1px solid var(--ce-border-primary)",
      color: "var(--ce-foreground-primary)",
      fontFamily: "var(--ce-font-sans)",
      fontSize: "12px",
    },
    ".cm-diagnostic-error": {
      borderLeftColor: "var(--ce-border-error)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      borderRight: "1px solid var(--ce-border-secondary)",
      color: "var(--ce-foreground-disabled)",
    },
    ".cm-line": {
      padding: "0 12px",
    },
    ".cm-lintRange-error": {
      backgroundImage:
        "linear-gradient(45deg, transparent 65%, var(--ce-foreground-error) 80%, transparent 90%)",
    },
    ".cm-scroller": {
      fontFamily: "var(--ce-font-mono)",
      lineHeight: "1.5",
      minHeight: "var(--ce-json-editor-min-height, 180px)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--ce-background-accent-secondary)",
    },
  },
  { dark: true },
);

export function jsonViewer(value: unknown): HTMLElement {
  const text = stringify(value);
  const ids = extractIds(value);
  return el(
    "div",
    { className: "ce-json-viewer" },
    el(
      "div",
      { className: "ce-json-toolbar" },
      button("Copy JSON", () => void copy(text)),
      ids.length
        ? button(
            ids.length === 1 ? "Copy ID" : `Copy IDs ${ids.length}`,
            () => void copy(ids.join("\n")),
          )
        : null,
    ),
    highlightJson(text),
  );
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function highlightJson(text: string): HTMLElement {
  const pre = el("pre", { className: "ce-json-highlight" });
  const pattern =
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(?=\s*:))|("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\bnull\b|([{}[\],:])/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > index) pre.append(document.createTextNode(text.slice(index, at)));
    const token = match[0];
    const className = match[1]
      ? "ce-json-token-key"
      : match[2]
        ? "ce-json-token-string"
        : match[3]
          ? "ce-json-token-number"
          : match[4]
            ? "ce-json-token-boolean"
            : token === "null"
              ? "ce-json-token-null"
              : "ce-json-token-punctuation";
    pre.append(el("span", { className, text: token }));
    index = at + token.length;
  }
  if (index < text.length) pre.append(document.createTextNode(text.slice(index)));
  return pre;
}

function extractIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (entry: unknown): void => {
    if (typeof entry === "string" && /^[^|]+\|[0-9a-f]{32}$/.test(entry)) {
      ids.add(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return [...ids];
}

async function copy(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}
