/**
 * Convergence helpers for text fields stored through an embedded client.
 *
 * @remarks
 * {@link createTextField} coalesces UI edits into guarded splices, rebases once after a concurrent
 * update, and exposes an explicit lifecycle for pending writes.
 *
 * @packageDocumentation
 */
export { createTextField } from "./text/field";
export type { TextFieldOptions, TextFieldWriter } from "./text/field";
