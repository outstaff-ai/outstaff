import type { Expansion, Token } from "./shell.types.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL = /[@*#?!$0-9-]/;

/** Index just past the `)` that closes the `(` at `open`, honouring quotes and nesting; -1 when it is not closed. */
export function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    } else {
      i = skipQuoted(src, i);
      if (i < 0) {
        return -1;
      }
    }
  }

  return -1;
}

/** Index of the last character of the escape or quoted string at `i` (`i` itself for anything else); -1 when a single quote is not closed. */
function skipQuoted(src: string, i: number): number {
  const c = src[i];
  if (c === "\\") {
    return i + 1;
  }

  if (c === "'") {
    return src.indexOf("'", i + 1);
  }

  return c === '"' ? closingDoubleQuote(src, i) : i;
}

/** Index of the `"` that closes the one at `open`, or the end of the text. */
function closingDoubleQuote(src: string, open: number): number {
  let i = open + 1;
  while (i < src.length && src[i] !== '"') {
    i += src[i] === "\\" ? 2 : 1;
  }

  return i;
}

/** Index just past the backtick that closes the one at `open`; -1 when it is not closed. */
export function closeBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
    } else if (src[i] === "`") {
      return i + 1;
    }
  }

  return -1;
}

/** Reads the expansion at `src[i] === "$"`: null when it is not one, "unclosed" when it does not end. */
export function expansion(src: string, i: number): Expansion | null | "unclosed" {
  const n = src[i + 1];
  if (n === "(") {
    return parenExpansion(src, i);
  }

  return n === "{" ? braceExpansion(src, i) : bareExpansion(src, i);
}

/** `$(command)` or `$((arithmetic))`. */
function parenExpansion(src: string, i: number): Expansion | "unclosed" {
  const end = closeParen(src, i + 1);
  if (end < 0) {
    return "unclosed";
  }

  // $((arithmetic)) holds no command, but judging its inside as one does no harm.
  return { tokens: [{ k: "sub", v: src.slice(i + 2, end - 1) }], text: src.slice(i, end), end };
}

/** `${NAME...}`, `${#NAME}` or `${!NAME}`. */
function braceExpansion(src: string, i: number): Expansion | "unclosed" {
  const end = src.indexOf("}", i + 2);
  if (end < 0) {
    return "unclosed";
  }

  const name = NAME.exec(src.slice(i + 2, end).replace(/^[#!]/, ""))?.[0];

  return {
    tokens: name ? [{ k: "var", v: name }] : [],
    text: src.slice(i, end + 1),
    end: end + 1,
  };
}

/** `$NAME` or a special parameter such as `$?`. */
function bareExpansion(src: string, i: number): Expansion | null {
  const name = NAME.exec(src.slice(i + 1))?.[0];
  if (name) {
    return { tokens: [{ k: "var", v: name }], text: `$${name}`, end: i + 1 + name.length };
  }

  const n = src[i + 1];
  if (n !== undefined && SPECIAL.test(n)) {
    return { tokens: [], text: `$${n}`, end: i + 2 };
  }

  return null;
}

/** Substitutions and variables inside text the shell expands, such as an unquoted here-document. */
export function expansionsIn(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
    } else if (c === "`") {
      const end = closeBacktick(text, i);
      if (end < 0) {
        break;
      }

      out.push({ k: "sub", v: text.slice(i + 1, end - 1) });
      i = end - 1;
    } else if (c === "$") {
      const e = expansion(text, i);
      if (e === "unclosed") {
        break;
      }

      if (e) {
        out.push(...e.tokens);
        i = e.end - 1;
      }
    }
  }

  return out;
}
