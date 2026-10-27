import { Scanner } from "./shell-scanner.js";
import { closeBacktick, closeParen, expansion } from "./shell-expansion.js";
import type { Heredoc, Separator, TokenResult } from "./shell.types.js";

/** Reads what starts at the current character; returns why the line cannot be read, or nothing to go on. */
type Step = (s: Scanner) => string | undefined;

const HEREDOC_DELIMITER = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/;

/** The tokens of a command line: words, redirections, separators, substitutions and expanded variables. */
export function tokenize(src: string): TokenResult {
  const s = new Scanner(src);
  while (!s.done) {
    const reason = (STEPS.get(s.at()!) ?? plain)(s);
    if (reason !== undefined) {
      return { ok: false, reason };
    }
  }

  s.endWord();

  return { ok: true, tokens: s.tokens };
}

function plain(s: Scanner): undefined {
  const c = s.at()!;
  s.add(c, /\d/.test(c));
  s.i++;
}

function separator(s: Scanner, v: Separator, width: number): void {
  s.push({ k: "sep", v });
  s.i += width;
}

function blank(s: Scanner): undefined {
  s.endWord();
  s.i++;
}

function newline(s: Scanner): undefined {
  s.endWord();
  separator(s, ";", 1);
  s.readHeredocBodies();
}

function comment(s: Scanner): undefined {
  if (s.wordStarted) {
    return plain(s);
  }

  const nl = s.src.indexOf("\n", s.i);
  s.i = nl < 0 ? s.src.length : nl;
}

/** Literal text from `from` up to the next single quote: a '...' string, or the body of an ANSI-C $'...'. */
function literalQuote(s: Scanner, from: number): string | undefined {
  const end = s.src.indexOf("'", from);
  if (end < 0) {
    return "unterminated single quote";
  }

  s.add(s.src.slice(from, end));
  s.i = end + 1;
}

function singleQuote(s: Scanner): string | undefined {
  return literalQuote(s, s.i + 1);
}

function doubleQuote(s: Scanner): string | undefined {
  s.i++;
  s.add("");
  while (s.at() !== '"') {
    if (s.done) {
      return "unterminated double quote";
    }

    const reason = (QUOTED_STEPS.get(s.at()!) ?? quotedPlain)(s);
    if (reason !== undefined) {
      return reason;
    }
  }

  s.i++;
}

function quotedPlain(s: Scanner): undefined {
  s.add(s.at()!);
  s.i++;
}

/** Inside double quotes a backslash escapes only `"`, `\`, `$` and a backtick; before anything else it stays. */
function quotedEscape(s: Scanner): undefined {
  const e = s.at(1);
  if (e === undefined) {
    return quotedPlain(s);
  }

  s.add('"\\$`'.includes(e) ? e : `\\${e}`);
  s.i += 2;
}

function backslash(s: Scanner): string | undefined {
  const n = s.at(1);
  if (n === undefined) {
    return "trailing backslash";
  }

  // A backslash before a newline joins the lines.
  if (n !== "\n") {
    s.add(n);
  }

  s.i += 2;
}

function backtick(s: Scanner): string | undefined {
  const end = closeBacktick(s.src, s.i);
  if (end < 0) {
    return "unterminated backtick";
  }

  s.push({ k: "sub", v: s.src.slice(s.i + 1, end - 1) });
  s.add(s.src.slice(s.i, end));
  s.i = end;
}

function dollar(s: Scanner): string | undefined {
  // ANSI-C quoting: the text is data.
  return s.at(1) === "'" ? literalQuote(s, s.i + 2) : expand(s);
}

function expand(s: Scanner): string | undefined {
  const e = expansion(s.src, s.i);
  if (e === "unclosed") {
    return "unterminated expansion";
  }

  if (!e) {
    return quotedPlain(s);
  }

  s.push(...e.tokens);
  s.add(e.text);
  s.i = e.end;
}

/** A subshell or group runs its commands like any others; for judging them it is a separator. */
function paren(s: Scanner): undefined {
  s.endWord();
  separator(s, ";", 1);
}

function angle(s: Scanner): string | undefined {
  if (s.at(1) === "(") {
    return processSubstitution(s);
  }

  if (s.at() === "<" && s.at(1) === "<") {
    return hereOperator(s);
  }

  redirect(s);
}

function processSubstitution(s: Scanner): string | undefined {
  const end = closeParen(s.src, s.i + 1);
  if (end < 0) {
    return "unterminated process substitution";
  }

  s.push({ k: "sub", v: s.src.slice(s.i + 2, end - 1) });
  s.add(s.src.slice(s.i, end));
  s.i = end;
}

/** `<<<` (a here-string) or `<<` (a here-document). */
function hereOperator(s: Scanner): string | undefined {
  s.endWord();
  if (s.at(2) !== "<") {
    return heredoc(s);
  }

  s.push({ k: "redir", op: "<<<" });
  s.i += 3;
}

function heredoc(s: Scanner): string | undefined {
  s.i += 2;
  const stripTabs = s.skip("-");
  s.skipBlanks();
  const m = HEREDOC_DELIMITER.exec(s.src.slice(s.i));
  if (!m) {
    return "here-document without a delimiter";
  }

  s.addHeredoc(heredocOf(m, stripTabs));
  s.i += m[0].length;
}

/** A here-document from its delimiter word; a quoted delimiter keeps the body from being expanded. */
function heredocOf(m: RegExpExecArray, stripTabs: boolean): Heredoc {
  const bare = m[3];
  const quoted = bare === undefined || /["'\\]/.test(bare);
  const delimiter = m[1] ?? m[2] ?? bare!.replaceAll(/["'\\]/g, "");

  return { delimiter, stripTabs, expands: !quoted };
}

function redirect(s: Scanner): void {
  const c = s.at()!;
  s.endWordBeforeRedirect();
  s.i++;
  const op = c === ">" && s.skip(">") ? ">>" : c;
  if (isFdDuplication(s)) {
    skipFdDuplication(s);

    return;
  }

  // ">|" overrides noclobber and ">&file" sends both streams to the file: either way the target is a file.
  if (c === ">" && /[&|]/.test(s.at() ?? "")) {
    s.i++;
  }

  s.push({ k: "redir", op });
}

/** fd duplication such as 2>&1: no file involved. */
function isFdDuplication(s: Scanner): boolean {
  return s.at() === "&" && /[\d-]/.test(s.at(1) ?? "");
}

function skipFdDuplication(s: Scanner): void {
  s.i += 2;
  while (/\d/.test(s.at() ?? "")) {
    s.i++;
  }
}

function ampersand(s: Scanner): undefined {
  s.endWord();
  if (s.at(1) === "&") {
    separator(s, "&&", 2);
  } else if (s.at(1) === ">") {
    redirectBoth(s);
  } else {
    separator(s, "&", 1);
  }
}

/** `&>` and `&>>`: both streams to a file. */
function redirectBoth(s: Scanner): void {
  s.i += 2;
  s.push({ k: "redir", op: s.skip(">") ? ">>" : ">" });
}

function pipe(s: Scanner): undefined {
  s.endWord();
  if (s.at(1) === "|") {
    separator(s, "||", 2);
  } else {
    separator(s, "|", s.at(1) === "&" ? 2 : 1);
  }
}

function semicolon(s: Scanner): undefined {
  s.endWord();
  separator(s, ";", s.at(1) === ";" || s.at(1) === "&" ? 2 : 1);
}

const STEPS = new Map<string, Step>([
  [" ", blank],
  ["\t", blank],
  ["\n", newline],
  ["#", comment],
  ["'", singleQuote],
  ['"', doubleQuote],
  ["\\", backslash],
  ["`", backtick],
  ["$", dollar],
  ["(", paren],
  [")", paren],
  ["<", angle],
  [">", angle],
  ["&", ampersand],
  ["|", pipe],
  [";", semicolon],
]);

const QUOTED_STEPS = new Map<string, Step>([
  ["\\", quotedEscape],
  ["`", backtick],
  ["$", expand],
]);
