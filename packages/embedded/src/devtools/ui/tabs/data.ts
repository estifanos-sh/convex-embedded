/// <reference lib="dom" />

import { onCleanup, onMount } from "solid-js";

import type {
  EmbeddedDevtoolsSchemaTable,
  EmbeddedDevtoolsSource,
  EmbeddedDevtoolsTable,
} from "../../core/types";
import type { EmbeddedInternalEvent } from "../../../events";
import { copyButton, rowId, valuePreview } from "../components";
import { button, el, empty, setStatus } from "../dom";
import { json, parseObject, stringify } from "../json";
import { jsonEditor, type JsonEditor } from "../json/editor";
import { clamp, readSize, splitHandle, writeSize } from "../split";

const PAGE_SIZE = 50;
const CELL_MAX = 80;

export function DataTab(props: { source: EmbeddedDevtoolsSource }): HTMLElement {
  const host = document.createElement("div");
  host.className = "ce-solid-host";
  onMount(() => {
    const cleanup = mountDataTab(host, props.source);
    onCleanup(cleanup);
  });
  return host;
}

export function mountDataTab(host: HTMLElement, source: EmbeddedDevtoolsSource): () => void {
  let state: DataTabState = {
    cursor: null,
    done: true,
    editError: "",
    editing: false,
    loadedTable: null,
    pendingRefresh: false,
    rows: [],
    rowsError: null,
    rowsStatus: "idle",
    schemaExpanded: false,
    selectedRowId: null,
    table: null,
  };
  let showSystem = false;
  let listWidth = readSize(DATA_LIST_KEY, 240);
  let detailWidth = readSize(DATA_DETAIL_KEY, 460);
  let detailEditor: JsonEditor | undefined;

  const list = el("aside", { className: "ce-data-list" });
  const main = el("main", { className: "ce-data-main" });
  const detail = el("aside", { className: "ce-data-detail" });
  const listHandle = splitHandle({
    container: main,
    label: "Resize table list",
    max: 420,
    min: 160,
    onChange: (value) => {
      listWidth = value;
      writeSize(DATA_LIST_KEY, value);
      applyDataGrid();
    },
    read: () => listWidth,
    reset: () => {
      listWidth = 240;
      writeSize(DATA_LIST_KEY, listWidth);
      applyDataGrid();
    },
  });
  const detailHandle = splitHandle({
    container: main,
    invert: true,
    label: "Resize document detail",
    max: 780,
    min: 320,
    onChange: (value) => {
      detailWidth = value;
      writeSize(DATA_DETAIL_KEY, value);
      applyDataGrid();
    },
    read: () => detailWidth,
    reset: () => {
      detailWidth = 460;
      writeSize(DATA_DETAIL_KEY, detailWidth);
      applyDataGrid();
    },
  });
  const root = el("div", { className: "ce-data" }, list, listHandle, main, detailHandle, detail);
  host.replaceChildren(root);
  const resizeObserver = new ResizeObserver(() => applyDataGrid());
  resizeObserver.observe(root);

  const observer = new IntersectionObserver(
    (entries) => {
      if (
        entries.some((entry) => entry.isIntersecting) &&
        state.table &&
        !state.done &&
        state.rowsStatus !== "loading"
      ) {
        void loadRows(false);
      }
    },
    { root: main, rootMargin: "220px" },
  );

  const renderList = () => {
    const snapshot = source.getSnapshot("data");
    const tables = snapshot.data;
    reconcileSelectedTable(tables);
    const user = tables.filter((table) => !isSystemTable(table.name));
    const system = tables.filter((table) => isSystemTable(table.name));
    const items: Array<HTMLElement | string> = [
      el("div", { className: "ce-label", text: "Tables" }),
      ...user.map(tableButton),
    ];
    if (system.length) {
      items.push(
        el(
          "button",
          {
            className: "ce-item ce-system-toggle",
            on: {
              click: () => {
                showSystem = !showSystem;
                renderList();
              },
            },
          },
          caret(showSystem),
          el("span", { text: `System (${system.length})` }),
        ),
      );
    }
    if (showSystem) items.push(...system.map(tableButton));
    list.replaceChildren(...items);
    if (tables.length) return;
    if (snapshot.runtime.status === "loading") {
      list.append(empty("Loading tables..."));
      return;
    }
    if (snapshot.runtime.status === "error") {
      list.append(
        errorState(
          "Runtime snapshot failed",
          snapshot.runtime.error,
          () => void refreshRuntimeRows(),
        ),
      );
      return;
    }
    list.append(empty("No tables."));
  };

  const tableButton = (table: EmbeddedDevtoolsTable): HTMLElement =>
    el(
      "button",
      {
        className: "ce-item",
        dataset: { active: table.name === state.table },
        on: {
          click: () => {
            selectTable(table.name);
            renderList();
            void loadRows(true);
          },
        },
      },
      el("span", { text: table.name }),
      el("small", { text: String(table.rowCount) }),
    );

  const renderMain = () => {
    observer.disconnect();
    main.replaceChildren();
    const snapshot = source.getSnapshot("data");
    if (!state.table) {
      if (snapshot.runtime.status === "loading") {
        main.append(empty("Loading tables..."));
      } else if (snapshot.runtime.status === "error") {
        main.append(
          errorState(
            "Runtime snapshot failed",
            snapshot.runtime.error,
            () => void refreshRuntimeRows(),
          ),
        );
      } else {
        main.append(empty("No tables."));
      }
      return;
    }
    const meta = snapshot.data.find((table) => table.name === state.table);
    main.append(
      el(
        "div",
        { className: "ce-data-head" },
        el("strong", { text: state.table }),
        el("span", { text: `${meta?.rowCount ?? 0} rows` }),
        el("span", { text: `${state.rows.length} loaded` }),
        state.rowsStatus === "loading" ? el("span", { text: "loading" }) : null,
        button("Clear local data", () => void clearLocalData(), "ce-button-danger"),
      ),
    );
    if (snapshot.runtime.status === "error") {
      main.append(
        errorState(
          "Runtime snapshot failed",
          snapshot.runtime.error,
          () => void refreshRuntimeRows(),
        ),
      );
      if (!state.rows.length && state.loadedTable !== state.table) return;
    }
    const schema = snapshot.schema.find((entry) => entry.name === state.table);
    const schemaNode = schemaBlock(schema);
    if (schemaNode) main.append(schemaNode);
    if (state.rowsError) {
      main.append(
        errorState(
          "Rows failed to load",
          state.rowsError,
          () => void loadRows(true, state.selectedRowId ?? undefined),
        ),
      );
      return;
    }
    if (!state.rows.length) {
      main.append(
        state.rowsStatus === "loading" || state.loadedTable !== state.table
          ? empty("Loading rows...")
          : empty("No rows."),
      );
      return;
    }
    const columns = columnsOf(state.rows);
    main.append(
      el(
        "table",
        { className: "ce-table ce-data-table" },
        el("thead", {}, el("tr", {}, ...columns.map((column) => el("th", { text: column })))),
        el(
          "tbody",
          {},
          ...state.rows.map((row) => {
            const id = rowId(row);
            return el(
              "tr",
              {
                className: "ce-row",
                dataset: { active: id === state.selectedRowId },
                on: {
                  click: () => {
                    state.selectedRowId = id;
                    state.editing = false;
                    state.editError = "";
                    renderMain();
                    renderDetail();
                  },
                },
              },
              ...columns.map((column) => el("td", {}, cell(row[column]))),
            );
          }),
        ),
      ),
    );
    if (!state.done) {
      const sentinel = el("div", { className: "ce-sentinel" });
      main.append(sentinel);
      observer.observe(sentinel);
    }
  };

  const renderDetail = () => {
    detailEditor?.destroy();
    detailEditor = undefined;
    const row = state.selectedRowId
      ? state.rows.find((entry) => rowId(entry) === state.selectedRowId)
      : undefined;
    if (!row) {
      detail.replaceChildren();
      detail.dataset.open = "false";
      applyDataGrid();
      return;
    }
    detail.dataset.open = "true";
    const editable = state.table !== null && !isSystemTable(state.table);
    const status = el("span", { className: "ce-status" });
    detail.replaceChildren(
      el(
        "div",
        { className: "ce-detail-head" },
        el("span", { text: "Document" }),
        el("code", { text: state.selectedRowId ?? "" }),
        el(
          "div",
          {},
          editable && !state.editing
            ? button("Edit", () => {
                state.editing = true;
                renderDetail();
              })
            : null,
          state.selectedRowId ? copyButton("Copy ID", state.selectedRowId) : null,
          button("Close", () => {
            state.selectedRowId = null;
            state.editing = false;
            renderMain();
            renderDetail();
          }),
        ),
      ),
      state.editing && editable
        ? editor(row, status)
        : el("div", { className: "ce-section" }, json(row)),
      status,
    );
    applyDataGrid();
  };

  const editor = (row: Record<string, unknown>, status: HTMLElement): HTMLElement => {
    const fields = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "_id" && key !== "_creationTime"),
    );
    detailEditor = jsonEditor({ minHeight: 260, value: stringify(fields) });
    return el(
      "div",
      { className: "ce-section" },
      detailEditor.element,
      el(
        "div",
        { className: "ce-actions" },
        button("Save", () => {
          void save(rowId(row), detailEditor?.value() ?? "{}", status);
        }),
        button("Cancel", () => {
          state.editing = false;
          state.editError = "";
          if (state.pendingRefresh) {
            state.pendingRefresh = false;
            void loadRows(true, state.selectedRowId ?? undefined);
            return;
          }
          renderDetail();
        }),
        button(
          "Delete",
          () => {
            void remove(rowId(row), status);
          },
          "ce-button-danger",
        ),
      ),
      state.editError ? el("div", { className: "ce-error", text: state.editError }) : null,
    );
  };

  const clearLocalData = async () => {
    if (
      !globalThis.confirm(
        "Clear all local embedded data for this browser origin? This removes OPFS-backed local rows and cannot be undone.",
      )
    ) {
      return;
    }
    state = {
      ...state,
      cursor: null,
      done: true,
      editError: "",
      editing: false,
      loadedTable: null,
      pendingRefresh: false,
      rows: [],
      rowsError: null,
      rowsStatus: "idle",
      selectedRowId: null,
      table: null,
    };
    await source.clearLocalData();
    renderList();
    renderMain();
    renderDetail();
  };

  const save = async (id: string, raw: string, status: HTMLElement) => {
    if (!state.table) return;
    try {
      await source.patchDocument(state.table, id, parseObject(raw));
      state.editing = false;
      state.editError = "";
      await loadRows(true, id);
      setStatus(status, "Saved", "success");
    } catch (error) {
      state.editError = error instanceof Error ? error.message : String(error);
      renderDetail();
    }
  };

  const remove = async (id: string, status: HTMLElement) => {
    if (!state.table) return;
    if (!confirm(`Delete ${id} from ${state.table}?`)) return;
    try {
      await source.deleteDocument(state.table, id);
      state.selectedRowId = null;
      state.editing = false;
      await loadRows(true);
      setStatus(status, "Deleted", "success");
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const schemaBlock = (schema: EmbeddedDevtoolsSchemaTable | undefined): HTMLElement | null => {
    if (!schema?.indexes.length) return null;
    return el(
      "div",
      { className: "ce-schema" },
      el(
        "button",
        {
          className: "ce-schema-toggle",
          on: {
            click: () => {
              state.schemaExpanded = !state.schemaExpanded;
              renderMain();
            },
          },
        },
        caret(state.schemaExpanded),
        el("span", { text: `Indexes (${schema.indexes.length})` }),
      ),
      state.schemaExpanded
        ? el(
            "div",
            { className: "ce-indexes" },
            ...schema.indexes.map((index) =>
              el(
                "div",
                {},
                el("code", { text: index.name }),
                el("span", { text: index.fields.join(", ") }),
              ),
            ),
          )
        : null,
    );
  };

  const loadRows = async (reset: boolean, keepId?: string) => {
    if (!state.table || state.rowsStatus === "loading") return;
    const table = state.table;
    if (reset) {
      if (state.loadedTable !== table) state.rows = [];
      state.loadedTable = null;
      state.cursor = null;
      state.done = true;
      state.selectedRowId = keepId ?? null;
    }
    state.rowsError = null;
    state.rowsStatus = "loading";
    renderMain();
    try {
      const page = await source.listTableRows(table, { cursor: state.cursor, limit: PAGE_SIZE });
      if (state.table !== table) return;
      state.rows = (reset ? page.rows : state.rows.concat(page.rows)).sort(compareRows);
      state.loadedTable = table;
      state.cursor = page.cursor;
      state.done = page.isDone;
      state.rowsStatus = "ready";
    } catch (error) {
      if (state.table === table) {
        state.rowsError = formatError(error);
        state.loadedTable = table;
        state.done = true;
        state.rowsStatus = "error";
      }
    } finally {
      if (state.table === table) {
        renderMain();
        renderDetail();
      }
    }
  };

  const stop = source.subscribe("data", (event) => {
    if (applyDataEvent(event)) return;
    renderList();
    renderMain();
    renderDetail();
    if (state.table && state.rowsStatus !== "loading" && !state.editing) {
      void loadRows(true, state.selectedRowId ?? undefined);
    }
  });
  renderList();
  void loadRows(true);
  return () => {
    detailEditor?.destroy();
    resizeObserver.disconnect();
    observer.disconnect();
    stop();
  };

  function applyDataGrid(): void {
    if (!root.clientWidth) return;
    const hasDetail = detail.dataset.open === "true";
    const maxList = Math.max(160, root.clientWidth - 420);
    listWidth = clamp(listWidth, 160, Math.min(420, maxList));
    const maxDetail = Math.max(320, root.clientWidth - listWidth - 240);
    detailWidth = clamp(detailWidth, 320, Math.min(780, maxDetail));
    detailHandle.style.display = hasDetail ? "" : "none";
    detail.style.display = hasDetail ? "" : "none";
    root.style.gridTemplateColumns = hasDetail
      ? `${listWidth}px 7px minmax(0,1fr) 7px ${detailWidth}px`
      : `${listWidth}px 7px minmax(0,1fr)`;
  }

  function selectTable(table: string | null, keepId?: string): void {
    if (state.table === table) return;
    state.table = table;
    state.rows = [];
    state.loadedTable = null;
    state.cursor = null;
    state.done = true;
    state.rowsStatus = "idle";
    state.rowsError = null;
    state.selectedRowId = keepId ?? null;
    state.editing = false;
    state.editError = "";
    state.pendingRefresh = false;
    state.schemaExpanded = false;
  }

  function reconcileSelectedTable(tables: EmbeddedDevtoolsTable[]): void {
    if (state.table && tables.some((table) => table.name === state.table)) return;
    const next =
      tables.find((table) => !isSystemTable(table.name))?.name ?? tables[0]?.name ?? null;
    selectTable(next);
  }

  async function refreshRuntimeRows(): Promise<void> {
    const table = state.table;
    await source.refresh();
    renderList();
    if (table) await loadRows(true, state.selectedRowId ?? undefined);
  }

  function applyDataEvent(event: EmbeddedInternalEvent | undefined): boolean {
    if (event?.type !== "data" || !state.table || !event.changedTables.includes(state.table)) {
      return false;
    }
    if (state.editing) {
      state.pendingRefresh = true;
      renderList();
      return true;
    }
    let changed = false;
    for (const deleted of event.deletes) {
      if (deleted.table !== state.table) continue;
      const next = state.rows.filter((row) => rowId(row) !== deleted.id);
      changed ||= next.length !== state.rows.length;
      state.rows = next;
      if (state.selectedRowId === deleted.id) state.selectedRowId = null;
    }
    for (const upsert of event.upserts) {
      if (upsert.table !== state.table) continue;
      const index = state.rows.findIndex((row) => rowId(row) === upsert.id);
      const row = upsert.row;
      if (index >= 0) {
        state.rows = state.rows.map((current, currentIndex) =>
          currentIndex === index ? row : current,
        );
      } else if (state.done || state.rows.length < PAGE_SIZE) {
        state.rows = state.rows.concat(row);
      } else {
        continue;
      }
      changed = true;
    }
    if (!changed) return false;
    state.loadedTable = state.table;
    state.rows = state.rows.sort(compareRows);
    renderList();
    renderMain();
    renderDetail();
    return true;
  }
}

function isSystemTable(name: string): boolean {
  return name.startsWith("_");
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) set.add(key);
  const rank = (key: string) => (key === "_id" ? 0 : key === "_creationTime" ? 1 : 2);
  return [...set].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function cell(value: unknown): HTMLElement {
  const preview = truncate(valuePreview(value));
  return el("span", {
    className: value === null || value === undefined ? "ce-cell-dim" : "ce-cell",
    text: preview,
  });
}

function truncate(value: string): string {
  return value.length > CELL_MAX ? `${value.slice(0, CELL_MAX)}...` : value;
}

function caret(open: boolean): HTMLElement {
  return el("span", { className: "ce-caret", text: open ? "v" : ">" });
}

function compareRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftTime = numeric(left._creationTime);
  const rightTime = numeric(right._creationTime);
  return leftTime - rightTime || rowId(left).localeCompare(rowId(right));
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorState(title: string, message: string | null, retry: () => void): HTMLElement {
  return el(
    "div",
    { className: "ce-empty ce-empty-actions" },
    el("span", { text: message ? `${title}: ${message}` : `${title}.` }),
    button("Retry", retry),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DATA_LIST_KEY = "convex-embedded-devtools-data-list-width";
const DATA_DETAIL_KEY = "convex-embedded-devtools-data-detail-width";

interface DataTabState {
  cursor: string | null;
  done: boolean;
  editError: string;
  editing: boolean;
  loadedTable: string | null;
  pendingRefresh: boolean;
  rows: Record<string, unknown>[];
  rowsError: string | null;
  rowsStatus: "error" | "idle" | "loading" | "ready";
  schemaExpanded: boolean;
  selectedRowId: string | null;
  table: string | null;
}
