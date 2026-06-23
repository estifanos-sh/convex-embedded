import type { EmbeddedDevtoolsOperation } from "./types";

/** Orders newest activity first. @internal */
export function newestOperations(
  operations: EmbeddedDevtoolsOperation[],
): EmbeddedDevtoolsOperation[] {
  return [...operations].sort((a, b) => b.startedAt - a.startedAt);
}
