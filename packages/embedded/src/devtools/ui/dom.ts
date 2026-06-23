/// <reference lib="dom" />

import { themeText } from "./theme";

export type Child = HTMLElement | Text | string | number | false | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    dataset?: Record<string, string | number | boolean | undefined>;
    on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
    text?: string | number;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.dataset ?? {})) {
    if (value !== undefined) node.dataset[key] = String(value);
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }
  append(node, children);
  return node;
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof HTMLElement || child instanceof Text ? child : text(child));
  }
}

export function text(value: string | number): Text {
  return document.createTextNode(String(value));
}

export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  return el("button", {
    className: `ce-button ${className}`.trim(),
    on: { click: onClick },
    text: label,
  });
}

export function badge(label: string, tone = "neutral"): HTMLElement {
  return el("span", { className: `ce-badge ce-badge-${tone}`, text: label });
}

export function empty(message: string): HTMLElement {
  return el("div", { className: "ce-empty", text: message });
}

export function time(value: number | undefined): string {
  return value === undefined ? "" : new Date(value).toLocaleTimeString();
}

export function size(value: unknown): string {
  if (typeof value !== "number") return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function setStatus(node: HTMLElement, message: string, tone = "neutral"): void {
  node.textContent = message;
  node.dataset.tone = tone;
}

export const styleText = `${themeText}
.ce-mount{width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
.ce-root{width:100%;max-width:100%;height:100%;min-height:360px;max-height:100%;background:var(--ce-background-primary);color:var(--ce-foreground-primary);font:13px/1.42 var(--ce-font-sans);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden}
.ce-root *{box-sizing:border-box}
.ce-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--ce-border-primary);background:var(--ce-background-secondary);padding:0 12px;overflow-x:auto}
.ce-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ce-foreground-muted);padding:11px 14px 10px;cursor:pointer;font:13px/1.2 var(--ce-font-sans);font-weight:600;display:inline-flex;align-items:center;gap:7px}
.ce-tab:hover{color:var(--ce-foreground-secondary)}
.ce-tab[data-active=true]{border-bottom-color:var(--ce-border-selected);color:var(--ce-foreground-primary)}
.ce-panel{width:100%;max-width:100%;min-width:0;min-height:0;overflow:hidden;background:var(--ce-background-primary)}
.ce-tab-panel{width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;display:none}
.ce-tab-panel[data-active=true]{display:block}
.ce-solid-host{width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
.ce-page{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--ce-background-primary)}
.ce-page-header{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--ce-border-primary);background:var(--ce-background-secondary)}
.ce-page-title{display:flex;align-items:baseline;gap:8px;min-width:0}
.ce-page-title h2{margin:0;color:var(--ce-foreground-primary);font-size:15px;line-height:1.2;font-weight:700}
.ce-page-title span{color:var(--ce-foreground-muted);font-size:12px;white-space:nowrap}
.ce-page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ce-page-actions>.ce-input{width:240px}
.ce-page-body{flex:1;min-width:0;min-height:0;overflow:hidden}
.ce-admin-grid{height:100%;min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,34%);background:var(--ce-background-primary)}
.ce-admin-grid[data-detail=false]{grid-template-columns:minmax(0,1fr)}
.ce-admin-main{min-width:0;min-height:0;overflow:auto}
.ce-admin-detail{min-width:0;min-height:0;overflow:auto;border-left:1px solid var(--ce-border-primary);background:var(--ce-background-secondary)}
.ce-toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ce-border-primary);background:var(--ce-background-secondary);min-height:48px}
.ce-toolbar h3{font-size:13px;margin:0;color:var(--ce-foreground-primary)}
.ce-toolbar-spacer{flex:1}
.ce-list{display:flex;flex-direction:column;padding:6px;gap:2px}
.ce-item{border:0;background:transparent;color:var(--ce-foreground-muted);text-align:left;border-radius:6px;padding:6px 8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;font:12px var(--ce-font-mono)}
.ce-item:hover,.ce-item[data-active=true]{background:var(--ce-background-tertiary);color:var(--ce-foreground-primary)}
.ce-item small{color:var(--ce-foreground-disabled);flex-shrink:0}
.ce-table-wrap{min-height:0;overflow:auto}
.ce-table{width:100%;border-collapse:collapse;table-layout:fixed}
.ce-table th,.ce-table td{padding:7px 10px;border-bottom:1px solid var(--ce-border-secondary);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ce-table th{position:sticky;top:0;background:var(--ce-background-secondary);color:var(--ce-foreground-muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;z-index:1}
.ce-row{cursor:pointer}
.ce-row:hover{background:var(--ce-row-hover)}
.ce-row[data-active=true]{background:var(--ce-row-selected)}
.ce-section{padding:14px 16px;border-bottom:1px solid var(--ce-border-primary)}
.ce-section h3{margin:0 0 10px;font-size:13px;color:var(--ce-foreground-primary)}
.ce-section h4{margin:12px 0 8px;font-size:12px;color:var(--ce-foreground-muted)}
.ce-button{border:1px solid var(--ce-border-primary);background:var(--ce-background-tertiary);color:var(--ce-foreground-primary);border-radius:6px;padding:6px 11px;cursor:pointer;font:13px/1.2 var(--ce-font-sans)}
.ce-button:hover{border-color:var(--ce-border-selected);background:var(--ce-background-raised)}
.ce-button-primary{border-color:var(--ce-background-accent);background:var(--ce-background-accent);color:white}
.ce-button-primary:hover{background:#6969f0}
.ce-button-danger{border-color:var(--ce-border-error);color:var(--ce-foreground-error);background:var(--ce-background-error-secondary)}
.ce-iconbutton{min-width:28px;padding:4px 8px}
.ce-badge{display:inline-flex;align-items:center;border:1px solid var(--ce-border-primary);border-radius:999px;padding:2px 7px;color:var(--ce-foreground-muted);background:var(--ce-background-tertiary);font:10px/1.4 var(--ce-font-mono);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.ce-badge-error{border-color:var(--ce-border-error);color:var(--ce-foreground-error);background:var(--ce-background-error-secondary)}
.ce-badge-success{border-color:#1f7a3b;color:var(--ce-foreground-success);background:var(--ce-background-success-secondary)}
.ce-badge-pending{border-color:#8a6519;color:var(--ce-foreground-warning);background:var(--ce-background-warning-secondary)}
.ce-field{display:flex;flex-direction:column;gap:6px;color:var(--ce-foreground-muted);font-size:12px;margin:0}
.ce-field>span{font-weight:600}
.ce-form-stack{display:flex;flex-direction:column;gap:12px;align-items:stretch}
.ce-input,.ce-textarea{box-sizing:border-box;width:100%;border:1px solid var(--ce-border-primary);background:var(--ce-input-background);color:var(--ce-foreground-primary);border-radius:6px;padding:8px 10px;font:12px/1.4 var(--ce-font-mono)}
.ce-input:focus,.ce-textarea:focus{outline:2px solid var(--ce-background-accent-secondary);border-color:var(--ce-border-selected)}
.ce-textarea{min-height:160px;font-family:var(--ce-font-mono);resize:vertical}
.ce-json{font:12px/1.5 var(--ce-font-mono);white-space:pre-wrap;word-break:break-word;color:var(--ce-foreground-secondary);margin:0}
.ce-json-viewer{border:1px solid var(--ce-border-primary);border-radius:7px;background:var(--ce-input-background);overflow:hidden}
.ce-json-toolbar{display:flex;justify-content:flex-end;gap:6px;padding:6px;border-bottom:1px solid var(--ce-border-secondary);background:var(--ce-background-primary)}
.ce-json-toolbar .ce-button{font-size:11px;padding:4px 8px;color:var(--ce-foreground-muted)}
.ce-json-editor{position:relative;border:1px solid var(--ce-border-primary);border-radius:7px;background:var(--ce-input-background);overflow:hidden}
.ce-json-codemirror{min-height:180px}
.ce-json-editor:focus-within{outline:2px solid var(--ce-background-accent-secondary);border-color:var(--ce-border-selected)}
.ce-json-diagnostic{min-height:22px;border-top:1px solid var(--ce-border-secondary);padding:4px 9px;color:var(--ce-foreground-muted);font:11px/1.3 var(--ce-font-sans)}
.ce-json-diagnostic:empty{display:none}
.ce-json-diagnostic[data-tone=error]{color:var(--ce-foreground-error)}
.ce-json-highlight{font:12px/1.5 var(--ce-font-mono);white-space:pre-wrap;word-break:break-word;color:var(--ce-foreground-secondary);margin:0;padding:10px 12px}
.ce-json-token-key{color:#9cdcfe}
.ce-json-token-string{color:#ce9178}
.ce-json-token-number{color:#b5cea8}
.ce-json-token-boolean{color:#569cd6}
.ce-json-token-null{color:#c586c0}
.ce-json-token-punctuation{color:#858585}
.ce-empty{color:var(--ce-foreground-muted);padding:16px;font-style:normal}
.ce-empty-state{min-height:220px;display:flex;align-items:center;justify-content:center;color:var(--ce-foreground-muted);font-size:13px}
.ce-status{color:var(--ce-foreground-muted);font-size:12px}
.ce-status[data-tone=success]{color:var(--ce-foreground-success)}
.ce-status[data-tone=error]{color:var(--ce-foreground-error)}
.ce-status[data-tone=pending]{color:var(--ce-foreground-warning)}
.ce-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ce-foreground-muted);padding:5px 8px 7px}
.ce-segmented{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--ce-border-primary);background:var(--ce-background-primary);border-radius:7px;padding:2px}
.ce-segment{border:0;border-radius:5px;background:transparent;color:var(--ce-foreground-muted);cursor:pointer;font:12px/1.2 var(--ce-font-sans);font-weight:600;padding:5px 9px}
.ce-segment:hover{color:var(--ce-foreground-primary)}
.ce-segment[data-active=true]{background:var(--ce-background-raised);color:var(--ce-foreground-primary);box-shadow:inset 0 0 0 1px var(--ce-border-primary)}
.ce-detail-head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--ce-border-primary);background:var(--ce-background-secondary)}
.ce-detail-head>span{color:var(--ce-foreground-muted);font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.04em}
.ce-detail-head code{font:12px var(--ce-font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ce-foreground-secondary)}
.ce-detail-head>div{margin-left:auto;display:flex;gap:6px}
.ce-actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.ce-error{color:var(--ce-foreground-error);font:12px/1.5 var(--ce-font-mono);margin-top:6px;white-space:pre-wrap}
.ce-kv{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);gap:7px 14px;font:12px var(--ce-font-mono)}
.ce-kv span:nth-child(odd){color:var(--ce-foreground-muted)}
.ce-kv span:nth-child(even){color:var(--ce-foreground-secondary);overflow:hidden;text-overflow:ellipsis}
.ce-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;padding:12px 16px;border-bottom:1px solid var(--ce-border-primary);background:var(--ce-background-secondary)}
.ce-metric{border:1px solid var(--ce-border-primary);background:var(--ce-background-primary);border-radius:7px;padding:10px 12px;min-width:0}
.ce-metric span{display:block;color:var(--ce-foreground-muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.ce-metric strong{display:block;color:var(--ce-foreground-primary);font:16px/1.3 var(--ce-font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ce-split-handle{width:7px;min-width:7px;height:100%;border:0;border-left:1px solid var(--ce-border-primary);border-right:1px solid var(--ce-border-primary);background:var(--ce-background-primary);cursor:col-resize;padding:0}
.ce-split-handle:hover,.ce-split-handle:focus-visible{background:var(--ce-background-accent-secondary);outline:0}
.ce-resizing{user-select:none}
.ce-data{width:100%;max-width:100%;height:100%;display:grid;min-width:0;min-height:0;background:var(--ce-background-primary);overflow:hidden}
.ce-data-list{min-width:0;min-height:0;overflow:auto;background:var(--ce-background-secondary);padding:8px}
.ce-data-main{min-width:0;min-height:0;overflow:auto}
.ce-data-detail{min-width:0;min-height:0;overflow:auto;border-left:1px solid var(--ce-border-primary);background:var(--ce-background-secondary);display:none}
.ce-data-detail[data-open=true]{display:block}
.ce-system-toggle{justify-content:flex-start;color:var(--ce-foreground-muted)}
.ce-caret{display:inline-block;width:12px;color:var(--ce-foreground-disabled);flex:0 0 auto}
.ce-data-head{display:flex;align-items:baseline;gap:8px;padding:12px 14px 6px}
.ce-data-head strong{font:14px var(--ce-font-mono);color:var(--ce-foreground-primary)}
.ce-data-head span{color:var(--ce-foreground-muted)}
.ce-schema{padding:0 14px 10px}
.ce-schema-toggle{border:0;background:transparent;color:var(--ce-foreground-muted);padding:3px 0;display:flex;align-items:center;gap:4px;cursor:pointer;font:12px var(--ce-font-sans)}
.ce-indexes{padding:8px 0 0 16px}
.ce-indexes div{display:flex;gap:12px;padding:2px 0;font:12px var(--ce-font-mono)}
.ce-indexes code{min-width:160px;color:var(--ce-foreground-accent)}
.ce-indexes span{color:var(--ce-foreground-muted)}
.ce-data-table{table-layout:auto;min-width:100%;font:12px var(--ce-font-mono)}
.ce-data-table td{max-width:320px}
.ce-cell{color:var(--ce-foreground-secondary)}
.ce-cell-dim{color:var(--ce-foreground-disabled)}
.ce-sentinel{height:1px;width:100%}
.ce-function-layout{height:100%;display:grid;min-width:0;min-height:0;overflow:hidden}
.ce-function-browser{min-width:0;background:var(--ce-background-secondary);overflow:auto}
.ce-function-browser-head{display:flex;flex-direction:column;gap:10px;padding:14px 14px 12px;border-bottom:1px solid var(--ce-border-primary)}
.ce-function-browser-head h3{margin:0;color:var(--ce-foreground-primary);font-size:14px}
.ce-function-tree{padding:10px 8px 18px}
.ce-function-module{width:100%;border:0;background:transparent;display:flex;align-items:center;gap:8px;color:var(--ce-foreground-secondary);font:13px var(--ce-font-mono);padding:8px 8px 6px;cursor:pointer;text-align:left}
.ce-function-module:hover{color:var(--ce-foreground-primary)}
.ce-function-module-icon{color:var(--ce-foreground-muted);font:12px var(--ce-font-sans)}
.ce-function-group{display:flex;flex-direction:column;margin-left:18px;padding-left:10px;border-left:1px solid var(--ce-border-primary)}
.ce-function-row{display:grid;grid-template-columns:22px minmax(120px,1fr) auto auto;align-items:center;gap:8px;border:0;background:transparent;color:var(--ce-foreground-secondary);text-align:left;border-radius:6px;padding:7px 8px;cursor:pointer;font:13px var(--ce-font-mono)}
.ce-function-row:hover{background:var(--ce-background-tertiary);color:var(--ce-foreground-primary)}
.ce-function-row[data-active=true]{background:var(--ce-row-selected);color:var(--ce-foreground-primary)}
.ce-function-icon{color:var(--ce-foreground-muted);font-style:italic;font-family:Georgia,serif}
.ce-function-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ce-function-kind{color:var(--ce-foreground-muted);font:10px var(--ce-font-mono);text-transform:uppercase;letter-spacing:.04em}
.ce-function-lock{color:var(--ce-foreground-warning);font:10px var(--ce-font-sans);text-transform:uppercase}
.ce-function-form{min-width:0;background:var(--ce-background-secondary);overflow:auto}
.ce-function-result{min-width:0;overflow:auto}
.ce-function-history{border-top:1px solid var(--ce-border-primary)}
.ce-form-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.ce-form-title h3{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ce-result{padding:16px}
.ce-result-card{border:1px solid var(--ce-border-primary);background:var(--ce-background-secondary);border-radius:8px;overflow:hidden}
.ce-result-card[data-tone=error]{border-color:var(--ce-border-error);background:var(--ce-background-error-secondary)}
.ce-result-head{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--ce-border-primary)}
.ce-pills{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.ce-pill{border:1px solid var(--ce-border-primary);background:transparent;color:var(--ce-foreground-muted);border-radius:6px;padding:5px 9px;cursor:pointer;font:12px var(--ce-font-sans);font-weight:600}
.ce-pill:hover{color:var(--ce-foreground-primary)}
.ce-pill[data-active=true]{border-color:var(--ce-border-selected);background:var(--ce-background-accent-secondary);color:var(--ce-foreground-primary)}
`;
