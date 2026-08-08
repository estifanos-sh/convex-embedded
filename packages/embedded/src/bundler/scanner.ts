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

interface CodeTransition {
  index: number;
  previous: string;
  word: string;
}

interface CodeToken {
  previous: string;
  word: string;
}

interface ModuleEdgeRead {
  edge?: ModuleEdge;
  end: number;
}

/**
 * Replaces lexical trivia with spaces while preserving every UTF-16 offset and line ending.
 *
 * This deliberately is not a parser: callers continue to own their narrow grammars after
 * scanning. Template and JSX text are trivia, but `${...}` and `{...}` expressions remain code
 * so module edges in their expressions can be discovered.
 */
export function maskCommentsAndStrings(source: string): string {
  return new LexicalMask(source).read();
}

class LexicalMask {
  readonly #output: string[];

  constructor(readonly source: string) {
    this.#output = source.split("");
  }

  read(): string {
    this.#scanCode(0);
    return this.#output.join("");
  }

  #mask(start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
      if (this.#output[index] !== "\n" && this.#output[index] !== "\r") {
        this.#output[index] = " ";
      }
    }
  }

  #skipSpace(start: number): number {
    let index = start;
    while (index < this.source.length && /\s/.test(this.source[index]!)) index += 1;
    return index;
  }

  #isExpressionStart(previous: string, word: string): boolean {
    if (word !== "") return REGEX_PRECEDING_KEYWORDS.has(word);
    return previous === "" || "([{:;,=!?&|+-*/%~^>".includes(previous);
  }

  #maskEscape(start: number): number {
    const end = Math.min(start + 2, this.source.length);
    this.#mask(start, end);
    return end;
  }

  #maskLiteral(start: number, isEnd: (character: string) => boolean): number {
    this.#mask(start, start + 1);
    let index = start + 1;
    while (index < this.source.length) {
      const character = this.source[index]!;
      this.#mask(index, index + 1);
      if (character === "\\") index = this.#maskEscape(index);
      else if (isEnd(character)) return index + 1;
      else index += 1;
    }
    return this.source.length;
  }

  #maskString(start: number, quote: string): number {
    return this.#maskLiteral(start, (character) => character === quote || isLineBreak(character));
  }

  #maskLineComment(start: number): number {
    let index = start;
    while (
      index < this.source.length &&
      this.source[index] !== "\n" &&
      this.source[index] !== "\r"
    ) {
      index += 1;
    }
    this.#mask(start, index);
    return index;
  }

  #maskBlockComment(start: number): number {
    let index = start + 2;
    while (
      index < this.source.length &&
      !(this.source[index] === "*" && this.source[index + 1] === "/")
    ) {
      index += 1;
    }
    const end = index < this.source.length ? index + 2 : this.source.length;
    this.#mask(start, end);
    return end;
  }

  #maskRegex(start: number): number {
    let characterClass = false;
    return this.#maskLiteral(start, (character) => {
      if (character === "[") {
        characterClass = true;
      } else if (character === "]") {
        characterClass = false;
      }
      return (character === "/" && !characterClass) || isLineBreak(character);
    });
  }

  #readClosingTag(start: number): number | undefined {
    if (this.source[start] !== "<" || this.source[start + 1] !== "/") return undefined;
    for (let index = start + 2; index < this.source.length; index += 1) {
      if (this.source[index] === ">") return index + 1;
      if (this.source[index] === "\n" || this.source[index] === "\r") return undefined;
    }
    return undefined;
  }

  #maskTemplate(start: number): number {
    this.#mask(start, start + 1);
    for (let index = start + 1; index < this.source.length; index += 1) {
      const character = this.source[index]!;
      if (character === "\\") {
        index = this.#maskEscape(index) - 1;
      } else if (character === "$" && this.source[index + 1] === "{") {
        this.#mask(index, index + 2);
        const end = this.#scanCode(index + 2, true, "{");
        if (end === undefined) return this.source.length;
        this.#mask(end, end + 1);
        index = end;
      } else {
        this.#mask(index, index + 1);
        if (character === "`") return index + 1;
      }
    }
    return this.source.length;
  }

  #readOpeningTag(
    start: number,
    previous: string,
    word: string,
    nested = false,
  ): { end: number; selfClosing: boolean } | undefined {
    if (!nested && !this.#isExpressionStart(previous, word)) return undefined;
    const index = start + 1;
    if (!isJsxTagStart(this.source[index])) return undefined;
    if (this.source[index] === ">") {
      return { end: index + 1, selfClosing: false };
    }
    return this.#readTagBody(start, index, nested);
  }

  #readTagBody(
    start: number,
    initialIndex: number,
    nested: boolean,
  ): { end: number; selfClosing: boolean } | undefined {
    let index = initialIndex;
    while (index < this.source.length) {
      const character = this.source[index]!;
      if (character === '"' || character === "'") {
        index = this.#maskString(index, character);
        continue;
      }
      if (character === "{") {
        const end = this.#scanCode(index + 1, true, "{");
        if (end === undefined) return undefined;
        index = end + 1;
        continue;
      }
      if (character === ">") return this.#finishOpeningTag(start, index, nested);
      index += 1;
    }
    return { end: this.source.length, selfClosing: false };
  }

  #finishOpeningTag(
    start: number,
    end: number,
    nested: boolean,
  ): { end: number; selfClosing: boolean } | undefined {
    // `<T>(value) => value` and `<T extends U>(value) => value` are TypeScript generics.
    if (!nested && this.source[this.#skipSpace(end + 1)] === "(") return undefined;
    let before = end - 1;
    while (before > start && /\s/.test(this.source[before]!)) before -= 1;
    return { end: end + 1, selfClosing: this.source[before] === "/" };
  }

  #readElement(start: number, previous: string, word: string, nested = false): number | undefined {
    const opening = this.#readOpeningTag(start, previous, word, nested);
    if (opening === undefined) return undefined;
    if (opening.selfClosing || opening.end >= this.source.length) return opening.end;
    return this.#readChildren(opening.end);
  }

  #readChildren(start: number): number | undefined {
    let index = start;
    let textStart = start;
    while (index < this.source.length) {
      if (this.source[index] === "{") {
        this.#mask(textStart, index);
        const end = this.#scanCode(index + 1, true, "{");
        if (end === undefined) return undefined;
        index = end + 1;
        textStart = index;
        continue;
      }
      if (this.source[index] === "<") {
        const closing = this.#readClosingTag(index);
        if (closing !== undefined) {
          this.#mask(textStart, index);
          return closing;
        }
        const nestedEnd = this.#readElement(index, "", "", true);
        if (nestedEnd !== undefined) {
          this.#mask(textStart, index);
          index = nestedEnd;
          textStart = index;
          continue;
        }
      }
      index += 1;
    }
    return undefined;
  }

  #readSlash(index: number, previous: string, word: string): CodeTransition | undefined {
    if (this.source[index] !== "/") return undefined;
    const next = this.source[index + 1];
    if (next === "/") {
      return { index: this.#maskLineComment(index), previous, word };
    }
    if (next === "*") {
      return { index: this.#maskBlockComment(index), previous, word };
    }
    if (!startsRegexLiteral(previous, word)) return undefined;
    return { index: this.#maskRegex(index), previous: "/", word: "" };
  }

  #readLiteral(index: number, previous: string, word: string): CodeTransition | undefined {
    const character = this.source[index]!;
    if (character === "`") {
      return { index: this.#maskTemplate(index), previous: "`", word: "" };
    }
    if (character === '"' || character === "'") {
      return { index: this.#maskString(index, character), previous: character, word: "" };
    }
    if (character !== "<") return undefined;
    const end = this.#readElement(index, previous, word);
    return end === undefined ? undefined : { index: end, previous: ">", word: "" };
  }

  #readCodeTransition(index: number, previous: string, word: string): CodeTransition | undefined {
    return this.#readSlash(index, previous, word) ?? this.#readLiteral(index, previous, word);
  }

  #scanCode(start: number, stopAtBrace = false, initialPrevious = ""): number | undefined {
    let previous = initialPrevious;
    let word = "";
    let braceDepth = 0;
    for (let index = start; index < this.source.length; ) {
      const character = this.source[index]!;
      if (isExpressionEnd(stopAtBrace, character, braceDepth)) return index;
      const transition = this.#readCodeTransition(index, previous, word);
      if (transition !== undefined) {
        ({ index, previous, word } = transition);
        continue;
      }
      braceDepth = readBraceDepth(stopAtBrace, character, braceDepth);
      ({ previous, word } = readCodeToken(character, previous, word));
      index += 1;
    }
    if (stopAtBrace) return undefined;
    return this.source.length;
  }
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
    const read = readModuleEdge(source, code, index);
    if (read === undefined) continue;
    if (read.edge !== undefined) edges.push(read.edge);
    index = read.end - 1;
  }
  return edges;
}

function readModuleEdge(source: string, code: string, start: number): ModuleEdgeRead | undefined {
  if (startsWord(code, start, "import")) return readImportEdge(source, code, start);
  if (!startsWord(code, start, "export")) return undefined;
  const end = start + "export".length;
  return readDeclarationEdge(source, code, skipTrivia(source, end), end);
}

function readImportEdge(source: string, code: string, start: number): ModuleEdgeRead {
  const end = start + "import".length;
  const cursor = skipTrivia(source, end);
  if (code[cursor] === ".") return { end };
  if (code[cursor] === "(") return readDynamicEdge(source, code, cursor, end);
  return readDeclarationEdge(source, code, cursor, end);
}

function readDynamicEdge(
  source: string,
  code: string,
  opening: number,
  fallbackEnd: number,
): ModuleEdgeRead {
  const argument = readQuotedSpecifier(source, code, skipTrivia(source, opening + 1));
  if (argument === undefined) return { end: fallbackEnd };
  const afterArgument = skipTrivia(source, argument.end);
  if (code[afterArgument] !== ")" && code[afterArgument] !== ",") return { end: fallbackEnd };
  return {
    edge: { specifier: argument.specifier, typeOnly: false },
    end: argument.end,
  };
}

function readDeclarationEdge(
  source: string,
  code: string,
  cursor: number,
  fallbackEnd: number,
): ModuleEdgeRead {
  const declaration = readDeclarationSpecifier(source, code, cursor);
  if (declaration === undefined) return { end: fallbackEnd };
  return {
    edge: {
      specifier: declaration.specifier,
      typeOnly: startsWord(code, cursor, "type"),
    },
    end: declaration.end,
  };
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
    const specifier = readQuotedSpecifier(source, code, skipTrivia(source, index + "from".length));
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

function skipTrivia(source: string, start: number): number {
  let index = skipWhitespace(source, start);
  let commentEnd = skipComment(source, index);
  while (commentEnd !== undefined) {
    index = skipWhitespace(source, commentEnd);
    commentEnd = skipComment(source, index);
  }
  return index;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index]!)) index += 1;
  return index;
}

function skipComment(source: string, start: number): number | undefined {
  if (source[start] !== "/") return undefined;
  if (source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (source[start + 1] !== "/") return undefined;
  let end = start + 2;
  while (end < source.length && !isLineBreak(source[end]!)) end += 1;
  return end;
}

function isLineBreak(character: string): boolean {
  return character === "\n" || character === "\r";
}

function isJsxTagStart(character: string | undefined): boolean {
  return character === ">" || /[A-Za-z_$]/.test(character ?? "");
}

function isExpressionEnd(stopAtBrace: boolean, character: string, braceDepth: number): boolean {
  return stopAtBrace && character === "}" && braceDepth === 0;
}

function readBraceDepth(stopAtBrace: boolean, character: string, current: number): number {
  if (!stopAtBrace) return current;
  if (character === "{") return current + 1;
  if (character === "}") return current - 1;
  return current;
}

function readCodeToken(character: string, previous: string, word: string): CodeToken {
  if (/\s/.test(character)) return { previous, word };
  return {
    previous: character,
    word: /[$\w]/.test(character) ? `${word}${character}` : "",
  };
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
