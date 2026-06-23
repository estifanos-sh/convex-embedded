/// <reference lib="dom" />

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { EmbeddedDevtoolsSource } from "../../core/types";
import { copyButton, rowId, valuePreview } from "../components";
import { size } from "../dom";
import { json } from "../json";
import { createViewSnapshot } from "../view/signal";

type StorageGroup = "files" | "uploads";

const columns: Record<StorageGroup, string[]> = {
  files: ["storageId", "contentType", "size", "source", "sha256"],
  uploads: ["localStorageId", "state", "owner", "leaseUntil", "size"],
};

export function StorageTab(props: { source: EmbeddedDevtoolsSource }) {
  const snapshot = createViewSnapshot(props.source, "storage");
  const [group, setGroup] = createSignal<StorageGroup>("files");
  const [selected, setSelected] = createSignal("");
  const groups = createMemo<Record<StorageGroup, Record<string, unknown>[]>>(() => ({
    files: snapshot().storage.files,
    uploads: snapshot().storage.uploads,
  }));
  const rows = createMemo(() => groups()[group()]);
  const row = createMemo(() => rows().find((entry) => rowId(entry) === selected()));

  createEffect(() => {
    if (!rows().some((entry) => rowId(entry) === selected())) {
      setSelected(rowId(rows()[0] ?? {}));
    }
  });

  return (
    <section class="ce-page">
      <div class="ce-toolbar">
        <div class="ce-segmented">
          <Segment
            active={group() === "files"}
            count={groups().files.length}
            label="Files"
            onClick={() => {
              setGroup("files");
              setSelected("");
            }}
          />
          <Segment
            active={group() === "uploads"}
            count={groups().uploads.length}
            label="Pending uploads"
            onClick={() => {
              setGroup("uploads");
              setSelected("");
            }}
          />
        </div>
      </div>
      <div class="ce-page-body">
        <div class="ce-admin-grid" data-detail={Boolean(row())}>
          <main class="ce-admin-main">
            <Show
              when={rows().length > 0}
              fallback={<div class="ce-empty-state">No {label(group())} yet.</div>}
            >
              <StorageTable
                cols={columns[group()]}
                rows={rows()}
                selected={selected()}
                onSelect={setSelected}
              />
            </Show>
          </main>
          <Show when={row()}>
            {(entry) => (
              <aside class="ce-admin-detail">
                <StorageDetail group={group()} row={entry()} />
              </aside>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

function Segment(props: { active: boolean; count: number; label: string; onClick: () => void }) {
  return (
    <button class="ce-segment" data-active={props.active} type="button" onClick={props.onClick}>
      {props.label} {props.count}
    </button>
  );
}

function label(group: StorageGroup): string {
  if (group === "files") return "Files";
  return "Pending uploads";
}

function StorageTable(props: {
  cols: string[];
  onSelect: (id: string) => void;
  rows: Record<string, unknown>[];
  selected: string;
}) {
  return (
    <table class="ce-table ce-data-table">
      <thead>
        <tr>
          <For each={props.cols}>{(col) => <th>{col}</th>}</For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => {
            const id = rowId(row);
            return (
              <tr
                class="ce-row"
                data-active={id === props.selected}
                onClick={() => props.onSelect(id)}
              >
                <For each={props.cols}>
                  {(col) => <td>{col === "size" ? size(row[col]) : valuePreview(row[col])}</td>}
                </For>
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}

function StorageDetail(props: { group: StorageGroup; row: Record<string, unknown> }) {
  return (
    <div>
      <div class="ce-detail-head">
        <span>{props.group}</span>
        <code>{rowId(props.row)}</code>
        <div>{copyButton("Copy ID", rowId(props.row))}</div>
      </div>
      <div class="ce-section">{json(props.row)}</div>
    </div>
  );
}
