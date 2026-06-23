/// <reference lib="dom" />

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type {
  EmbeddedDevtoolsFunction,
  EmbeddedDevtoolsRunFunctionInput,
  EmbeddedDevtoolsSource,
} from "../../core/types";
import { getTimerTime } from "../../../time";
import { badge, time } from "../dom";
import { json, parseObject } from "../json";
import { jsonEditor, type JsonEditor } from "../json/editor";
import { clamp, handleSplitPointerDown, readSize, writeSize } from "../split";
import { createViewSnapshot } from "../view/signal";

interface RunEntry {
  at: number;
  error?: string;
  input: EmbeddedDevtoolsRunFunctionInput;
  kind?: EmbeddedDevtoolsFunction["kind"];
  result?: unknown;
}

export function FunctionsTab(props: { source: EmbeddedDevtoolsSource }) {
  const snapshot = createViewSnapshot(props.source, "functions");
  const [layoutElement, setLayoutElement] = createSignal<HTMLDivElement>();
  const [history, setHistory] = createSignal<RunEntry[]>([]);
  const [collapsed, setCollapsed] = createSignal(readCollapsed());
  const [selected, setSelected] = createSignal(0);
  const [pathValue, setPathValue] = createSignal("");
  const [argsValue, setArgsValue] = createSignal("{}");
  const [browserWidth, setBrowserWidth] = createSignal(
    readSize(FUNCTION_BROWSER_KEY, FUNCTION_BROWSER_DEFAULT),
  );
  const [formWidth, setFormWidth] = createSignal(
    readSize(FUNCTION_FORM_KEY, FUNCTION_FORM_DEFAULT),
  );
  const [filter, setFilter] = createSignal("");
  const [selectedPath, setSelectedPath] = createSignal("");
  const [statusMessage, setStatusMessage] = createSignal("");
  const [statusTone, setStatusTone] = createSignal("neutral");

  const functions = createMemo(() => snapshot().functions);
  const visible = createMemo(() => filterFunctions(functions(), filter()));
  const groups = createMemo(() => groupFunctions(visible()));
  const current = createMemo(() => history()[selected()]);

  createEffect(() => {
    const entries = functions();
    if (!selectedPath() && !pathValue() && entries[0]) selectFunction(entries[0]);
  });

  createEffect(() => {
    const length = history().length;
    if (selected() >= length) setSelected(Math.max(0, length - 1));
  });

  onMount(() => {
    const layout = layoutElement();
    if (!layout) return;
    const observer = new ResizeObserver(() => applyFunctionGrid());
    observer.observe(layout);
    requestAnimationFrame(() => applyFunctionGrid());
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    browserWidth();
    formWidth();
    requestAnimationFrame(() => applyFunctionGrid());
  });

  async function run(): Promise<void> {
    const selectedFn = props.source
      .getSnapshot("functions")
      .functions.find((fn) => fn.path === pathValue());
    let parsed: Record<string, unknown>;
    try {
      parsed = parseObject(argsValue());
    } catch (error) {
      const inputValue = { args: {}, path: pathValue() };
      setHistory((entries) => [
        {
          at: getTimerTime(),
          error: error instanceof Error ? error.message : String(error),
          input: inputValue,
          kind: selectedFn?.kind,
        },
        ...entries,
      ]);
      setSelected(0);
      setStatusMessage("Invalid arguments");
      setStatusTone("error");
      return;
    }

    const inputValue: EmbeddedDevtoolsRunFunctionInput = {
      args: parsed,
      path: pathValue(),
    };
    setStatusMessage("Running");
    setStatusTone("pending");
    try {
      const resultValue = await props.source.runFunction(inputValue);
      setHistory((entries) => [
        { at: getTimerTime(), input: inputValue, kind: selectedFn?.kind, result: resultValue },
        ...entries,
      ]);
      setSelected(0);
      setStatusMessage("Complete");
      setStatusTone("success");
    } catch (error) {
      setHistory((entries) => [
        {
          at: getTimerTime(),
          error: error instanceof Error ? error.message : String(error),
          input: inputValue,
          kind: selectedFn?.kind,
        },
        ...entries,
      ]);
      setSelected(0);
      setStatusMessage("Error");
      setStatusTone("error");
    }
  }

  function selectFunction(fn: EmbeddedDevtoolsFunction): void {
    setPathValue(fn.path);
    setSelectedPath(fn.path);
    setArgsValue(stringifyPrefill(fn));
  }

  function applyFunctionGrid(): void {
    const layout = layoutElement();
    if (!layout?.clientWidth) return;
    const available = Math.max(0, layout.clientWidth - 14);
    const maxBrowser = Math.min(
      FUNCTION_BROWSER_MAX,
      Math.max(FUNCTION_BROWSER_MIN, available - 760),
    );
    const nextBrowser = clamp(browserWidth(), FUNCTION_BROWSER_MIN, maxBrowser);
    const maxForm = Math.min(
      FUNCTION_FORM_MAX,
      Math.max(FUNCTION_FORM_MIN, available - nextBrowser - 360),
    );
    const nextForm = clamp(formWidth(), FUNCTION_FORM_MIN, maxForm);
    if (nextBrowser !== browserWidth()) setBrowserWidth(nextBrowser);
    if (nextForm !== formWidth()) setFormWidth(nextForm);
    layout.style.gridTemplateColumns = `${nextBrowser}px 7px ${nextForm}px 7px minmax(0,1fr)`;
  }

  function readLayout(): HTMLElement {
    const layout = layoutElement();
    if (!layout) throw new Error("Function layout is not mounted.");
    return layout;
  }

  const resizeBrowser = (value: number) => {
    setBrowserWidth(value);
    writeSize(FUNCTION_BROWSER_KEY, value);
  };

  const resizeForm = (value: number) => {
    setFormWidth(value);
    writeSize(FUNCTION_FORM_KEY, value);
  };

  return (
    <section class="ce-page">
      <div class="ce-page-body">
        <div class="ce-function-layout" ref={(element) => setLayoutElement(element)}>
          <aside class="ce-function-browser">
            <div class="ce-function-browser-head">
              <input
                class="ce-input"
                value={filter()}
                placeholder="Search functions..."
                onInput={(event) => setFilter(event.currentTarget.value)}
              />
            </div>
            <Show
              when={visible().length > 0}
              fallback={<div class="ce-empty">No matching functions.</div>}
            >
              <div class="ce-function-tree">
                <For each={groups()}>
                  {([module, entries]) => {
                    const open = () => Boolean(filter().trim()) || !collapsed().has(module);
                    return (
                      <>
                        <button
                          class="ce-function-module"
                          data-open={open()}
                          type="button"
                          onClick={() => setCollapsed(toggleModule(module))}
                        >
                          <span class="ce-caret">{open() ? "v" : ">"}</span>
                          <span class="ce-function-module-icon">{"</>"}</span>
                          <span>{module}</span>
                        </button>
                        <Show when={open()}>
                          <div class="ce-function-group">
                            <For each={entries}>
                              {(fn) => (
                                <button
                                  class="ce-function-row"
                                  data-active={fn.path === selectedPath()}
                                  type="button"
                                  onClick={() => selectFunction(fn)}
                                >
                                  <span class="ce-function-icon">fn</span>
                                  <span class="ce-function-name">{fn.name}</span>
                                  <span class="ce-function-kind">{fn.kind}</span>
                                  <Show when={fn.visibility === "internal"}>
                                    <span class="ce-function-lock">lock</span>
                                  </Show>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </>
                    );
                  }}
                </For>
              </div>
            </Show>
          </aside>
          <SplitButton
            container={readLayout}
            label="Resize function list"
            max={FUNCTION_BROWSER_MAX}
            min={FUNCTION_BROWSER_MIN}
            onChange={resizeBrowser}
            read={browserWidth}
            reset={() => resizeBrowser(FUNCTION_BROWSER_DEFAULT)}
          />
          <aside class="ce-function-form">
            <div class="ce-section">
              <span class="ce-status" data-tone={statusTone()}>
                {statusMessage()}
              </span>
              <div class="ce-form-stack">
                <label class="ce-field">
                  <span>Args JSON</span>
                  <JsonEditorMount minHeight={178} value={argsValue()} onChange={setArgsValue} />
                </label>
                <button
                  class="ce-button ce-button-primary"
                  type="button"
                  onClick={() => void run()}
                >
                  Run
                </button>
              </div>
            </div>
            <Show when={history().length > 0}>
              <div class="ce-function-history">
                <div class="ce-label">Recent runs</div>
                <For each={history()}>
                  {(entry, index) => (
                    <button
                      class="ce-item"
                      data-active={index() === selected()}
                      type="button"
                      onClick={() => setSelected(index())}
                    >
                      <span>{entry.input.path || "(missing path)"}</span>
                      <small>{time(entry.at)}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </aside>
          <SplitButton
            container={readLayout}
            label="Resize function arguments"
            max={FUNCTION_FORM_MAX}
            min={FUNCTION_FORM_MIN}
            onChange={resizeForm}
            read={formWidth}
            reset={() => resizeForm(FUNCTION_FORM_DEFAULT)}
          />
          <main class="ce-function-result">
            <FunctionResult entry={current()} />
          </main>
        </div>
      </div>
    </section>
  );
}

function JsonEditorMount(props: {
  minHeight: number;
  onChange: (value: string) => void;
  value: string;
}) {
  const [hostElement, setHostElement] = createSignal<HTMLDivElement>();
  let editor: JsonEditor | undefined;

  onMount(() => {
    const host = hostElement();
    if (!host) return;
    editor = jsonEditor({
      minHeight: props.minHeight,
      onChange: props.onChange,
      value: props.value,
    });
    host.append(editor.element);
  });

  createEffect(() => {
    const value = props.value;
    if (editor && editor.value() !== value) editor.setValue(value);
  });

  onCleanup(() => editor?.destroy());

  return <div ref={(element) => setHostElement(element)} />;
}

function SplitButton(props: {
  container: () => HTMLElement;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  read: () => number;
  reset: () => void;
}) {
  return (
    <button
      aria-label={props.label}
      class="ce-split-handle"
      title={`${props.label}. Drag to resize. Double-click to reset.`}
      type="button"
      onDblClick={props.reset}
      onPointerDown={(event) =>
        handleSplitPointerDown(event, { ...props, container: props.container() })
      }
    />
  );
}

function FunctionResult(props: { entry: RunEntry | undefined }) {
  return (
    <Show
      when={props.entry}
      fallback={<div class="ce-empty-state">Run a function to inspect the result.</div>}
    >
      {(entry) => (
        <div class="ce-result">
          <section class="ce-result-card" data-tone={entry().error ? "error" : "success"}>
            <div class="ce-result-head">
              <div class="ce-page-title">
                <h2>{entry().input.path || "(missing path)"}</h2>
              </div>
              <Show when={entry().kind}>
                {(kind) => badge(kind(), entry().error ? "error" : "success")}
              </Show>
            </div>
            <Show
              when={entry().error}
              fallback={<div class="ce-section">{json(entry().result)}</div>}
            >
              {(error) => (
                <div class="ce-section">
                  <pre class="ce-error">{error()}</pre>
                </div>
              )}
            </Show>
            <div class="ce-section">
              <h3>Arguments</h3>
              {json(entry().input.args)}
            </div>
          </section>
        </div>
      )}
    </Show>
  );
}

function groupFunctions(
  functions: EmbeddedDevtoolsFunction[],
): Array<[string, EmbeddedDevtoolsFunction[]]> {
  const grouped = new Map<string, EmbeddedDevtoolsFunction[]>();
  for (const fn of functions) {
    const items = grouped.get(fn.module) ?? [];
    items.push(fn);
    grouped.set(fn.module, items);
  }
  return [...grouped.entries()];
}

function filterFunctions(
  functions: EmbeddedDevtoolsFunction[],
  filter: string,
): EmbeddedDevtoolsFunction[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return functions;
  return functions.filter((fn) =>
    `${fn.kind} ${fn.path} ${fn.visibility}`.toLowerCase().includes(needle),
  );
}

function stringifyPrefill(fn: EmbeddedDevtoolsFunction): string {
  const value = Object.fromEntries(
    fn.args.filter((arg) => !arg.optional).map((arg) => [arg.name, arg.placeholder]),
  );
  return JSON.stringify(value, null, 2);
}

function readCollapsed(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(FUNCTION_COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function toggleModule(module: string): (collapsed: Set<string>) => Set<string> {
  return (collapsed) => {
    const next = new Set(collapsed);
    if (next.has(module)) next.delete(module);
    else next.add(module);
    localStorage.setItem(FUNCTION_COLLAPSED_KEY, JSON.stringify([...next]));
    return next;
  };
}

const FUNCTION_BROWSER_DEFAULT = 380;
const FUNCTION_BROWSER_MAX = 560;
const FUNCTION_BROWSER_MIN = 320;
const FUNCTION_FORM_DEFAULT = 600;
const FUNCTION_FORM_MAX = 780;
const FUNCTION_FORM_MIN = 440;
const FUNCTION_BROWSER_KEY = "convex-embedded-devtools-functions-browser-width";
const FUNCTION_FORM_KEY = "convex-embedded-devtools-functions-form-width";
const FUNCTION_COLLAPSED_KEY = "convex-embedded-devtools-functions-collapsed";
