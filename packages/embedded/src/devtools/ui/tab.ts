/// <reference lib="dom" />

import type { Component } from "solid-js";

import type { EmbeddedDevtoolsSource, EmbeddedDevtoolsView } from "../core/types";

export interface DevtoolsTab {
  id: EmbeddedDevtoolsView;
  label: string;
  component: Component<{ source: EmbeddedDevtoolsSource }>;
}
