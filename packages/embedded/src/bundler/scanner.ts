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

export interface ModuleEdge {
  /** The literal module specifier exactly as it appears in the source. */
  specifier: string;

  /** Whether the declaration begins with TypeScript's `import type` or `export type`. */
  typeOnly: boolean;
}

/**
 * Replaces lexical trivia with spaces while preserving every UTF-16 offset and line ending.
 *
 * This deliberately is not a parser: callers continue to own their narrow grammars after
 * scanning. Template text is trivia, but `${...}` substitutions remain code so module edges in
 * template expressions can be discovered.
 */
export function maskCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "string" | "regex" | "template" = "code";
  let quote = "";
  let previous = "";
  let word = "";
  let characterClass = false;
  const templateExpressionDepths: number[] = [];
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
      } else if (character === "`") {
        output += " ";
        state = "template";
      } else if (character === '"' || character === "'") {
        output += " ";
        quote = character;
        state = "string";
      } else {
        let closesTemplateExpression = false;
        if (templateExpressionDepths.length > 0) {
          const expression = templateExpressionDepths.length - 1;
          if (character === "{") templateExpressionDepths[expression]! += 1;
          else if (character === "}") {
            templateExpressionDepths[expression]! -= 1;
            if (templateExpressionDepths[expression] === 0) {
              templateExpressionDepths.pop();
              state = "template";
              closesTemplateExpression = true;
            }
          }
        }
        output += closesTemplateExpression ? " " : character;
        if (!/\s/.test(character)) {
          word = /[$\w]/.test(character) ? `${word}${character}` : "";
          previous = character;
        }
      }
      continue;
    }
    if (state === "template") {
      if (character === "\\") {
        output += " ";
        if (next !== undefined) {
          output += next === "\n" || next === "\r" ? next : " ";
          index += 1;
        }
      } else if (character === "$" && next === "{") {
        output += "  ";
        index += 1;
        templateExpressionDepths.push(1);
        previous = "{";
        word = "";
        state = "code";
      } else if (character === "`") {
        output += " ";
        previous = "`";
        word = "";
        state = "code";
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
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
 * Reads literal module specifiers from import declarations, re-exports, and dynamic imports.
 *
 * This is intentionally a narrow semantic scan, not a JavaScript parser. It uses the trivia
 * mask to find only live keywords, then reads the corresponding string literal from the original
 * source. Consumers decide whether TypeScript type-only edges are relevant to their own stage.
 */
export function readModuleEdges(source: string): ModuleEdge[] {
  const code = maskCommentsAndStrings(source);
  const edges: ModuleEdge[] = [];
  for (let index = 0; index < code.length; index += 1) {
    if (startsWord(code, index, "import")) {
      const cursor = skipTrivia(source, code, index + "import".length);
      if (code[cursor] === ".") continue;
      if (code[cursor] === "(") {
        const argument = readQuotedSpecifier(source, code, skipTrivia(source, code, cursor + 1));
        if (argument !== undefined) {
          const afterArgument = skipTrivia(source, code, argument.end);
          if (code[afterArgument] === ")" || code[afterArgument] === ",") {
            edges.push({ specifier: argument.specifier, typeOnly: false });
            index = argument.end - 1;
          }
        }
        continue;
      }
      const typeOnly = startsWord(code, cursor, "type");
      const declaration = readDeclarationSpecifier(source, code, cursor);
      if (declaration !== undefined) {
        edges.push({ specifier: declaration.specifier, typeOnly });
        index = declaration.end - 1;
      }
      continue;
    }
    if (startsWord(code, index, "export")) {
      const cursor = skipTrivia(source, code, index + "export".length);
      const typeOnly = startsWord(code, cursor, "type");
      const declaration = readDeclarationSpecifier(source, code, cursor);
      if (declaration !== undefined) {
        edges.push({ specifier: declaration.specifier, typeOnly });
        index = declaration.end - 1;
      }
    }
  }
  return edges;
}

function readDeclarationSpecifier(
  source: string,
  code: string,
  start: number,
): { end: number; specifier: string } | undefined {
  const direct = readQuotedSpecifier(source, code, start);
  if (direct !== undefined) return direct;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === ";") return undefined;
    if (!startsWord(code, index, "from")) continue;
    const specifier = readQuotedSpecifier(
      source,
      code,
      skipTrivia(source, code, index + "from".length),
    );
    if (specifier !== undefined) return specifier;
  }
  return undefined;
}

function readQuotedSpecifier(
  source: string,
  code: string,
  start: number,
): { end: number; specifier: string } | undefined {
  const quote = source[start];
  if ((quote !== '"' && quote !== "'") || code[start] !== " ") return undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) {
      return { end: index + 1, specifier: source.slice(start + 1, index) };
    }
    if (source[index] === "\n" || source[index] === "\r") return undefined;
  }
  return undefined;
}

function skipTrivia(source: string, code: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (code[index] === " " && (source[index] === '"' || source[index] === "'")) break;
    break;
  }
  return index;
}

function startsWord(source: string, start: number, word: string): boolean {
  const end = start + word.length;
  return (
    source.slice(start, end) === word &&
    !isIdentifierCharacter(source[start - 1]) &&
    !isIdentifierCharacter(source[end])
  );
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[$\w]/.test(character);
}

/**
 * Whether a `/` opens a regex literal rather than a division, from the last significant token.
 * JSX closes (`</`, `/>`) keep `<` and `}` out of the operand-position set.
 */
function startsRegexLiteral(previous: string, word: string): boolean {
  if (word !== "") return REGEX_PRECEDING_KEYWORDS.has(word);
  return previous === "" || REGEX_PRECEDING_OPERATORS.includes(previous);
}
