/// <reference lib="dom" />

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { EmbeddedDevtoolsOperation, EmbeddedDevtoolsSource } from "../../core/types";
import { statusBadge, valuePreview } from "../components";
import { time } from "../dom";
import { json } from "../json";
import { createViewSnapshot } from "../view/signal";

const kinds = ["all", "query", "mutation", "action", "upload"];

export function ActivityTab(props: { source: EmbeddedDevtoolsSource }) {
  const snapshot = createViewSnapshot(props.source, "activity");
  const [filter, setFilter] = createSignal("");
  const [kind, setKind] = createSignal("all");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const operations = createMemo(() =>
    [...snapshot().activity.operations]
      .sort((a, b) => b.startedAt - a.startedAt)
      .filter((operation) => {
        if (kind() !== "all" && operation.kind !== kind()) return false;
        return `${operation.kind} ${operation.name} ${valuePreview(operation.args)}`
          .toLowerCase()
          .includes(filter().toLowerCase());
      }),
  );
  const selected = createMemo(() =>
    operations().find((operation) => String(operation.id) === selectedId()),
  );

  createEffect(() => {
    if (!operations().some((operation) => String(operation.id) === selectedId())) {
      setSelectedId(operations()[0] ? String(operations()[0].id) : null);
    }
  });

  return (
    <section class="ce-page">
      <div class="ce-toolbar">
        <input
          class="ce-input"
          value={filter()}
          placeholder="Filter calls"
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <div class="ce-segmented">
          <For each={kinds}>
            {(item) => (
              <button
                class="ce-segment"
                data-active={item === kind()}
                type="button"
                onClick={() => {
                  setKind(item);
                  setSelectedId(null);
                }}
              >
                {item}
              </button>
            )}
          </For>
        </div>
        <div class="ce-toolbar-spacer" />
        <button
          class="ce-button"
          type="button"
          onClick={() => {
            setSelectedId(null);
            props.source.clearActivity();
          }}
        >
          Clear
        </button>
      </div>
      <div class="ce-page-body">
        <div class="ce-admin-grid" data-detail={Boolean(selected())}>
          <main class="ce-admin-main">
            <Show
              when={operations().length > 0}
              fallback={<div class="ce-empty-state">No activity yet.</div>}
            >
              <OperationTable
                operations={operations()}
                selectedId={selectedId()}
                onSelect={setSelectedId}
              />
            </Show>
          </main>
          <Show when={selected()}>
            {(operation) => (
              <aside class="ce-admin-detail">
                <OperationDetail operation={operation()} />
              </aside>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

function OperationTable(props: {
  onSelect: (id: string) => void;
  operations: EmbeddedDevtoolsOperation[];
  selectedId: string | null;
}) {
  return (
    <table class="ce-table ce-data-table">
      <thead>
        <tr>
          <For each={["Status", "Kind", "Function", "Duration", "Started"]}>
            {(heading) => <th>{heading}</th>}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.operations}>
          {(operation) => {
            const id = String(operation.id);
            return (
              <tr
                class="ce-row"
                data-active={id === props.selectedId}
                onClick={() => props.onSelect(id)}
              >
                <td>{statusBadge(operation.status)}</td>
                <td>{operation.kind}</td>
                <td>{operation.name}</td>
                <td>{operation.durationMs === undefined ? "" : `${operation.durationMs}ms`}</td>
                <td>{time(operation.startedAt)}</td>
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}

function OperationDetail(props: { operation: EmbeddedDevtoolsOperation }) {
  const operation = () => props.operation;
  return (
    <div>
      <div class="ce-detail-head">
        <span>{operation().kind}</span>
        <code>{operation().name}</code>
        {statusBadge(operation().status)}
      </div>
      <div class="ce-section ce-kv">
        <span>Started</span>
        <span>{time(operation().startedAt)}</span>
        <span>Duration</span>
        <span>{operation().durationMs === undefined ? "" : `${operation().durationMs}ms`}</span>
        <span>Result size</span>
        <span>{operation().resultSize === undefined ? "" : `${operation().resultSize} chars`}</span>
      </div>
      <Show when={operation().timing}>
        {(timing) => (
          <div class="ce-section ce-kv">
            <span>Total runtime</span>
            <span>{formatMs(timing().totalMs)}</span>
            <span>Prepare</span>
            <span>{formatMs(timing().prepareMs)}</span>
            <span>Mutation begin</span>
            <span>{formatMs(timing().beginMs)}</span>
            <span>Handler</span>
            <span>{formatMs(timing().handlerMs)}</span>
            <span>Batch</span>
            <span>{formatMs(timing().batchMs)}</span>
            <span>Result encode</span>
            <span>{formatMs(timing().resultEncodeMs)}</span>
            <span>Commit</span>
            <span>{formatMs(timing().commitMs)}</span>
            <span>Notify</span>
            <span>{formatMs(timing().notifyMs)}</span>
          </div>
        )}
      </Show>
      <Show when={operation().error}>
        {(error) => (
          <div class="ce-section">
            <h3>Error</h3>
            <pre class="ce-error">{error()}</pre>
          </div>
        )}
      </Show>
      <div class="ce-section">
        <h3>Arguments</h3>
        {json(operation().args)}
      </div>
      <Show when={operation().result !== undefined}>
        <div class="ce-section">
          <h3>Result</h3>
          {json(operation().result)}
        </div>
      </Show>
    </div>
  );
}

function formatMs(value: number): string {
  if (value < 1) return `${value.toFixed(2)}ms`;
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.trunc(value)}ms`;
}
