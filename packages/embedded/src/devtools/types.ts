/// <reference lib="dom" />

/** Embedded devtools types. @packageDocumentation */
import type { EmbeddedDevtoolsSource } from "./core/types";

export type { EmbeddedDevtoolsSource } from "./core/types";

/**
 * Options for mounting embedded devtools.
 *
 * @public
 */
export interface MountEmbeddedDevtoolsOptions {
  /** Open the devtools panel immediately after mounting. */
  defaultOpen?: boolean;
  /** Floating panel position. */
  position?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** Explicit source for tests or custom shells. */
  source?: EmbeddedDevtoolsSource;
  /** DOM node that should receive the devtools host. */
  target?: HTMLElement;
}

/**
 * Mounted devtools handle.
 *
 * @public
 */
export interface MountedEmbeddedDevtools {
  /** Unmounts the panel and detaches all listeners. */
  unmount(): void;
}
