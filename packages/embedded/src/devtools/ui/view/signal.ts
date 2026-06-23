import { createSignal, onCleanup } from "solid-js";

import type { EmbeddedDevtoolsSource, EmbeddedDevtoolsView } from "../../core/types";

export function createViewSnapshot(source: EmbeddedDevtoolsSource, view: EmbeddedDevtoolsView) {
  const [version, setVersion] = createSignal(0);
  const unsubscribe = source.subscribe(view, () => setVersion((current) => current + 1));
  onCleanup(unsubscribe);
  return () => {
    version();
    return source.getSnapshot(view);
  };
}
