/// <reference lib="dom" />

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { EmbeddedDevtoolsSource } from "../../core/types";
import type { ScheduledJob } from "../../../storage/types";
import { copyButton } from "../components";
import { badge, time } from "../dom";
import { json } from "../json";
import { createViewSnapshot } from "../view/signal";

export function SchedulerTab(props: { source: EmbeddedDevtoolsSource }) {
  const snapshot = createViewSnapshot(props.source, "scheduler");
  const [selected, setSelected] = createSignal("");
  const [state, setState] = createSignal("all");
  const jobs = createMemo(() => snapshot().scheduler.jobs);
  const filtered = createMemo(() =>
    state() === "all" ? jobs() : jobs().filter((job) => job.state === state()),
  );
  const job = createMemo(() => filtered().find((entry) => entry.jobId === selected()));

  createEffect(() => {
    if (!filtered().some((entry) => entry.jobId === selected())) {
      setSelected(filtered()[0]?.jobId ?? "");
    }
  });

  return (
    <section class="ce-page">
      <div class="ce-toolbar">
        <Filters
          active={state()}
          jobs={jobs()}
          onChange={(next) => {
            setState(next);
            setSelected("");
          }}
        />
      </div>
      <div class="ce-page-body">
        <div class="ce-admin-grid" data-detail={Boolean(job())}>
          <main class="ce-admin-main">
            <Show
              when={filtered().length > 0}
              fallback={<div class="ce-empty-state">No scheduled jobs.</div>}
            >
              <SchedulerTable jobs={filtered()} selected={selected()} onSelect={setSelected} />
            </Show>
          </main>
          <Show when={job()}>
            {(entry) => (
              <aside class="ce-admin-detail">
                <SchedulerDetail job={entry()} />
              </aside>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

function Filters(props: {
  active: string;
  jobs: ScheduledJob[];
  onChange: (state: string) => void;
}) {
  const states = ["all", "pending", "running", "complete", "failed", "canceled"];
  return (
    <div class="ce-segmented">
      <For each={states}>
        {(item) => (
          <button
            class="ce-segment"
            data-active={item === props.active}
            type="button"
            onClick={() => props.onChange(item)}
          >
            {item} {count(item, props.jobs)}
          </button>
        )}
      </For>
    </div>
  );
}

function count(state: string, jobs: ScheduledJob[]): number {
  return state === "all" ? jobs.length : jobs.filter((job) => job.state === state).length;
}

function SchedulerTable(props: {
  jobs: ScheduledJob[];
  onSelect: (id: string) => void;
  selected: string;
}) {
  return (
    <table class="ce-table ce-data-table">
      <thead>
        <tr>
          <For each={["State", "Function", "Kind", "Due", "Job"]}>
            {(heading) => <th>{heading}</th>}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.jobs}>
          {(job) => (
            <tr
              class="ce-row"
              data-active={job.jobId === props.selected}
              onClick={() => props.onSelect(job.jobId)}
            >
              <td>{badge(job.state, tone(job.state))}</td>
              <td>{job.name}</td>
              <td>{job.kind}</td>
              <td>{time(job.dueTime)}</td>
              <td>{job.jobId}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

function SchedulerDetail(props: { job: ScheduledJob }) {
  return (
    <div>
      <div class="ce-detail-head">
        <span>{props.job.kind}</span>
        <code>{props.job.name}</code>
        {badge(props.job.state, tone(props.job.state))}
        <div>{copyButton("Copy Job ID", props.job.jobId)}</div>
      </div>
      <div class="ce-section">{json({ ...props.job, args: parseArgs(props.job.args) })}</div>
    </div>
  );
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function tone(state: string): string {
  if (state === "failed") return "error";
  if (state === "complete") return "success";
  if (state === "pending" || state === "running") return "pending";
  return "neutral";
}
