const REGEX_PRECEDING_OPERATORS = "(,=:[!&|?{;+-*%~^>";
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Replaces lexical trivia with spaces while preserving every UTF-16 offset and line ending.
 *
 * This deliberately is not a parser: callers continue to own their narrow grammars after
 * scanning. Template literals are entirely trivia, including their substitutions, because the
 * current consumers only need to ignore syntactic lookalikes inside them.
 */
export function maskCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "string" | "regex" = "code";
  let quote = "";
  let previous = "";
  let word = "";
  let characterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line";
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block";
      } else if (character === "/" && startsRegexLiteral(previous, word)) {
        output += " ";
        characterClass = false;
        state = "regex";
      } else if (character === '"' || character === "'" || character === "`") {
        output += " ";
        quote = character;
        state = "string";
      } else {
        output += character;
        if (!/\s/.test(character)) {
          word = /[$\w]/.test(character) ? `${word}${character}` : "";
          previous = character;
        }
      }
      continue;
    }
    if (state === "line") {
      output += character === "\n" || character === "\r" ? character : " ";
      if (character === "\n" || character === "\r") state = "code";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (state === "regex") {
      output += character === "\n" || character === "\r" ? character : " ";
      if (character === "\\") {
        if (next !== undefined) {
          output += next === "\n" || next === "\r" ? next : " ";
          index += 1;
        }
      } else if (character === "[") {
        characterClass = true;
      } else if (character === "]") {
        characterClass = false;
      } else if (
        (character === "/" && !characterClass) ||
        character === "\n" ||
        character === "\r"
      ) {
        previous = "/";
        word = "";
        state = "code";
      }
      continue;
    }
    if (character === "\\") {
      output += " ";
      if (next !== undefined) {
        output += next === "\n" || next === "\r" ? next : " ";
        index += 1;
      }
    } else if (character === quote) {
      output += " ";
      previous = quote;
      word = "";
      state = "code";
    } else {
      output += character === "\n" || character === "\r" ? character : " ";
    }
  }
  return output;
}

/**
 * Whether a `/` opens a regex literal rather than a division, from the last significant token.
 * JSX closes (`</`, `/>`) keep `<` and `}` out of the operand-position set.
 */
function startsRegexLiteral(previous: string, word: string): boolean {
  if (word !== "") return REGEX_PRECEDING_KEYWORDS.has(word);
  return previous === "" || REGEX_PRECEDING_OPERATORS.includes(previous);
}
