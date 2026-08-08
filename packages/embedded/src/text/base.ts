/** Corruption-safe text-write helpers used by the text-field convergence loop. */
import { hashValue } from "../hash";

/**
 * Minimal splice turning `before` into `after`: a code-point prefix/suffix diff reported in the
 * UTF-16 `index`/`delete` units the engine's `text.splice` expects. Undefined when the strings match.
 */
export function diff(
  before: string,
  after: string,
): { index: number; delete: number; insert: string } | undefined {
  if (before === after) return undefined;
  const beforeChars = Array.from(before);
  const afterChars = Array.from(after);

  let prefix = 0;
  const prefixLimit = Math.min(beforeChars.length, afterChars.length);
  while (prefix < prefixLimit && beforeChars[prefix] === afterChars[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(beforeChars.length - prefix, afterChars.length - prefix);
  while (
    suffix < suffixLimit &&
    beforeChars[beforeChars.length - 1 - suffix] === afterChars[afterChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = beforeChars.slice(prefix, beforeChars.length - suffix).join("");
  return {
    index: beforeChars.slice(0, prefix).join("").length,
    delete: removed.length,
    insert: afterChars.slice(prefix, afterChars.length - suffix).join(""),
  };
}

/** SHA-256 fingerprint of a whole text value, used as a splice's whole-base precondition. */
export async function base(value: string): Promise<string> {
  return hashValue(value);
}
