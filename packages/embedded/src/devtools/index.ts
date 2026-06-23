/// <reference lib="dom" />

/**
 * Embedded devtools package entrypoint.
 *
 * @packageDocumentation
 */
import { TanStackDevtoolsCore } from "@tanstack/devtools";
import type { EmbeddedClient } from "../client";
import { createEmbeddedDevtoolsSource } from "./core/source";
import type { MountEmbeddedDevtoolsOptions, MountedEmbeddedDevtools } from "./types";

export { createEmbeddedDevtoolsSource } from "./core/source";
export type {
  EmbeddedDevtoolsSource,
  MountEmbeddedDevtoolsOptions,
  MountedEmbeddedDevtools,
} from "./types";

/**
 * Mounts the embedded devtools panel for an embedded client.
 *
 * @param client - Embedded client to inspect.
 * @param options - Mount position, default-open state, and optional source override.
 * @returns A handle that unmounts the devtools.
 * @public
 */
export function mountEmbeddedDevtools(
  client: EmbeddedClient,
  options: MountEmbeddedDevtoolsOptions = {},
): MountedEmbeddedDevtools {
  const ownsSource = options.source === undefined;
  const source = options.source ?? createEmbeddedDevtoolsSource(client);
  const target = options.target ?? document.body;
  const host = document.createElement("div");
  target.append(host);

  let renderToken = 0;
  let destroyApp: (() => void) | undefined;
  const destroyPanel = (): void => {
    renderToken += 1;
    destroyApp?.();
    destroyApp = undefined;
  };
  const devtools = new TanStackDevtoolsCore({
    config: {
      defaultOpen: options.defaultOpen ?? false,
      position: options.position ?? "bottom-right",
    },
    plugins: [
      {
        id: "convex-embedded",
        name: "Convex Embedded",
        render: (el: HTMLElement) => {
          destroyPanel();
          const token = renderToken;
          void import("./ui/app").then(({ mountEmbeddedDevtoolsApp }) => {
            if (token !== renderToken) return;
            destroyApp = mountEmbeddedDevtoolsApp(el, source);
          });
        },
        destroy: destroyPanel,
      },
    ],
  });
  devtools.mount(host);
  return {
    unmount() {
      destroyPanel();
      if (ownsSource) source.dispose();
      devtools.unmount();
      host.remove();
    },
  };
}
