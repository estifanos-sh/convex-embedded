/**
 * Vite plugin helper for embedded devtools.
 *
 * @packageDocumentation
 */
import { devtools, type TanStackDevtoolsViteConfig } from "@tanstack/devtools-vite";

export interface EmbeddedDevtoolsVitePlugin {
  name: string;
  [key: string]: unknown;
}

export type EmbeddedDevtoolsVitePlugins = EmbeddedDevtoolsVitePlugin | EmbeddedDevtoolsVitePlugin[];

/**
 * Creates the TanStack Devtools Vite plugin configured for embedded devtools.
 *
 * @remarks
 * This helper is intentionally a thin pass-through over `@tanstack/devtools-vite`.
 * Use TanStack's config for shell-level features such as source injection, console
 * piping, enhanced logs, the server event bus, editor integration, plugin logging,
 * and removing devtools from production builds.
 *
 * @param config - Optional TanStack devtools Vite config.
 * @returns A Vite plugin that removes devtools code from production builds.
 * @public
 */
export function embeddedDevtools(
  config: TanStackDevtoolsViteConfig = {},
): EmbeddedDevtoolsVitePlugins {
  return devtools({
    removeDevtoolsOnBuild: true,
    ...config,
  }) as EmbeddedDevtoolsVitePlugins;
}
