/**
 * Convergence helpers for text fields stored through an embedded client.
 *
 * @remarks
 * A positional splice computed from a stale UI baseline misapplies under a concurrent pull. These
 * {@link createTextField} coalesces UI edits into guarded splices, rebases once after a concurrent
 * update, and exposes an explicit lifecycle for pending writes.
 *
 * @packageDocumentation
 */
export { createTextField } from "./text/field";
export type { TextFieldOptions, TextFieldWriter } from "./text/field";

/**
 * Minimal splice turning `before` into `after`: a code-point prefix/suffix diff reported in the
 * UTF-16 `index`/`delete` units the engine's `text.splice` expects. Undefined when the strings match.
 */
