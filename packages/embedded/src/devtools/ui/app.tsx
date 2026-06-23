/// <reference lib="dom" />

import { createMemo, createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";

import type { EmbeddedDevtoolsSource, EmbeddedDevtoolsView } from "../core/types";
import { styleText } from "./dom";
import { tabs } from "./tabs";

/**
 * Mounts the embedded devtools application inside the TanStack panel.
 *
 * @internal
 */
export function mountEmbeddedDevtoolsApp(
  host: HTMLElement,
  source: EmbeddedDevtoolsSource,
): () => void {
  const style = document.createElement("style");
  style.textContent = styleText;
  const root = document.createElement("div");
  root.className = "ce-mount";
  host.replaceChildren(style, root);
  const cleanup = render(() => <EmbeddedDevtoolsApp source={source} />, root);
  return () => {
    cleanup();
    host.replaceChildren();
  };
}

function EmbeddedDevtoolsApp(props: { source: EmbeddedDevtoolsSource }) {
  const [active, setActive] = createSignal(readActive());
  const [opened, setOpened] = createSignal(new Set<EmbeddedDevtoolsView>([active()]));
  const openedTabs = createMemo(() => opened());

  const selectTab = (id: EmbeddedDevtoolsView) => {
    setActive(id);
    setOpened((current) => new Set(current).add(id));
    localStorage.setItem(ACTIVE_KEY, id);
  };

  return (
    <div class="ce-root">
      <nav class="ce-tabs">
        <For each={tabs}>
          {(tab) => (
            <button
              class="ce-tab"
              data-active={tab.id === active()}
              type="button"
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </nav>
      <main class="ce-panel">
        <For each={tabs}>
          {(tab) => {
            const Tab = tab.component;
            return (
              <Show when={openedTabs().has(tab.id)}>
                <section
                  class="ce-tab-panel"
                  data-active={tab.id === active()}
                  aria-hidden={tab.id !== active()}
                >
                  <Tab source={props.source} />
                </section>
              </Show>
            );
          }}
        </For>
      </main>
    </div>
  );
}

const ACTIVE_KEY = "convex-embedded-devtools-tab";

function readActive(): EmbeddedDevtoolsView {
  const stored = localStorage.getItem(ACTIVE_KEY) as EmbeddedDevtoolsView | null;
  return stored && tabs.some((tab) => tab.id === stored) ? stored : "data";
}
