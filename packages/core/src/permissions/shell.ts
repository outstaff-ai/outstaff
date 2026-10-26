export type Separator = "&&" | "||" | ";" | "|" | "&";

export interface Redirect {
  /** `>`, `>>`, `<` or `<<<` (a here-string, whose target is data, not a file). */
  op: string;
  target: string;
}

export interface Segment {
  /** Words as written, quotes removed. Expansions (`$NAME`, `${...}`) stay in the text and are not resolved. */
  words: string[];
  redirects: Redirect[];

  /** What follows this segment; null for the last one. */
  sep: Separator | null;

  /** What preceded this segment; null for the first one. */
  before: Separator | null;

  /** Source of every command substitution, process substitution and here-document substitution in the segment. */
  subs: string[];

  /** Names of the variables the segment expands. */
  vars: string[];
}

export type LexResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

type Token =
  | { k: "word"; v: string }
  | { k: "redir"; op: string }
  | { k: "sep"; v: Separator }
  | { k: "sub"; v: string }
  | { k: "var"; v: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL = /[@*#?!$0-9-]/;

const fail = (reason: string): LexResult => ({ ok: false, reason });

/** Index just past the `)` that closes the `(` at `open`, honouring quotes and nesting; -1 when it is not closed. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) {
        return -1;
      }

      i = end;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        i += src[i] === "\\" ? 2 : 1;
      }
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

/** Index just past the backtick that closes the one at `open`; -1 when it is not closed. */
function closeBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
    } else if (src[i] === "`") {
      return i + 1;
    }
  }

  return -1;
}

type Expansion = { tokens: Token[]; text: string; end: number };

/** Reads the expansion at `src[i] === "$"`: null when it is not one, "unclosed" when it does not end. */
function expansion(src: string, i: number): Expansion | null | "unclosed" {
  const n = src[i + 1];
  if (n === "(") {
    const end = closeParen(src, i + 1);
    if (end < 0) {
      return "unclosed";
    }

    // $((arithmetic)) holds no command, but judging its inside as one does no harm.
    return { tokens: [{ k: "sub", v: src.slice(i + 2, end - 1) }], text: src.slice(i, end), end };
  }

  if (n === "{") {
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

  const name = NAME.exec(src.slice(i + 1))?.[0];
  if (name) {
    return { tokens: [{ k: "var", v: name }], text: `$${name}`, end: i + 1 + name.length };
  }

  if (n !== undefined && SPECIAL.test(n)) {
    return { tokens: [], text: `$${n}`, end: i + 2 };
  }

  return null;
}

/** Substitutions and variables inside text the shell expands, such as an unquoted here-document. */
function expansionsIn(text: string): Token[] {
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

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  expands: boolean;
}

/**
 * A small shell lexer. It understands quoting, command separators, redirection, here-documents, groups and
 * subshells. It never runs anything: expansions stay as written, and the source of each command or process
 * substitution is handed back so it can be judged as a command line of its own.
 */
export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  let buf = "";
  let inWord = false;
  let digitsOnly = true;
  const heredocs: Heredoc[] = [];
  let i = 0;

  const endWord = () => {
    if (inWord) {
      tokens.push({ k: "word", v: buf });
    }

    buf = "";
    inWord = false;
    digitsOnly = true;
  };

  const add = (s: string, digit = false) => {
    buf += s;
    inWord = true;
    if (!digit) {
      digitsOnly = false;
    }
  };

  /** Reads the bodies of the pending here-documents from `at`, the start of the next line; returns where they end. */
  const readBodies = (at: number): number => {
    let pos = at;
    for (const h of heredocs.splice(0)) {
      const body: string[] = [];
      while (pos < src.length) {
        const nl = src.indexOf("\n", pos);
        const line = src.slice(pos, nl < 0 ? src.length : nl);
        pos = nl < 0 ? src.length : nl + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter) {
          break;
        }

        body.push(line);
      }

      if (h.expands) {
        tokens.push(...expansionsIn(body.join("\n")));
      }
    }

    return pos;
  };

  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endWord();
      tokens.push({ k: "sep", v: ";" });
      i = heredocs.length > 0 ? readBodies(i + 1) : i + 1;
    } else if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") {
        i++;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) {
        return fail("unterminated single quote");
      }

      add(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      i++;
      inWord = true;
      digitsOnly = false;
      for (;;) {
        if (i >= src.length) {
          return fail("unterminated double quote");
        }

        const d = src[i]!;
        if (d === '"') {
          i++;
          break;
        }

        if (d === "\\" && i + 1 < src.length) {
          const e = src[i + 1]!;
          buf += '"\\$`'.includes(e) ? e : `\\${e}`;
          i += 2;
        } else if (d === "`") {
          const end = closeBacktick(src, i);
          if (end < 0) {
            return fail("unterminated backtick");
          }

          tokens.push({ k: "sub", v: src.slice(i + 1, end - 1) });
          buf += src.slice(i, end);
          i = end;
        } else if (d === "$") {
          const e = expansion(src, i);
          if (e === "unclosed") {
            return fail("unterminated expansion");
          }

          if (e) {
            tokens.push(...e.tokens);
            buf += e.text;
            i = e.end;
          } else {
            buf += d;
            i++;
          }
        } else {
          buf += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (n === "\n") {
        i += 2;
      } else if (n === undefined) {
        return fail("trailing backslash");
      } else {
        add(n);
        i += 2;
      }
    } else if (c === "`") {
      const end = closeBacktick(src, i);
      if (end < 0) {
        return fail("unterminated backtick");
      }

      tokens.push({ k: "sub", v: src.slice(i + 1, end - 1) });
      add(src.slice(i, end));
      i = end;
    } else if (c === "$" && n === "'") {
      // ANSI-C quoting: the text is data.
      const end = src.indexOf("'", i + 2);
      if (end < 0) {
        return fail("unterminated single quote");
      }

      add(src.slice(i + 2, end));
      i = end + 1;
    } else if (c === "$") {
      const e = expansion(src, i);
      if (e === "unclosed") {
        return fail("unterminated expansion");
      }

      if (e) {
        tokens.push(...e.tokens);
        add(e.text);
        i = e.end;
      } else {
        add(c);
        i++;
      }
    } else if ((c === "<" || c === ">") && n === "(") {
      const end = closeParen(src, i + 1);
      if (end < 0) {
        return fail("unterminated process substitution");
      }

      tokens.push({ k: "sub", v: src.slice(i + 2, end - 1) });
      add(src.slice(i, end));
      i = end;
    } else if (c === "(" || c === ")") {
      // A subshell or group runs its commands like any others; for judging them it is a separator.
      endWord();
      tokens.push({ k: "sep", v: ";" });
      i++;
    } else if (c === "<" && n === "<" && src[i + 2] === "<") {
      endWord();
      tokens.push({ k: "redir", op: "<<<" });
      i += 3;
    } else if (c === "<" && n === "<") {
      endWord();
      i += 2;
      const stripTabs = src[i] === "-";
      if (stripTabs) {
        i++;
      }

      while (src[i] === " " || src[i] === "\t") {
        i++;
      }

      const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(src.slice(i));
      if (!m) {
        return fail("here-document without a delimiter");
      }

      const quoted = m[3] === undefined || /["'\\]/.test(m[3]);
      const delimiter = m[1] ?? m[2] ?? m[3]!.replaceAll(/["'\\]/g, "");
      heredocs.push({ delimiter, stripTabs, expands: !quoted });
      i += m[0].length;
    } else if (c === "<" || c === ">") {
      // "2>" style file-descriptor prefix belongs to the operator, not to a word.
      if (inWord && digitsOnly && buf !== "") {
        buf = "";
        inWord = false;
      } else {
        endWord();
      }

      let op = c;
      i++;
      if (c === ">" && src[i] === ">") {
        op = ">>";
        i++;
      }

      if (src[i] === "&" && /[\d-]/.test(src[i + 1] ?? "")) {
        // fd duplication such as 2>&1: no file involved.
        i += 2;
        while (/\d/.test(src[i] ?? "")) {
          i++;
        }

        continue;
      }

      if (c === ">" && (src[i] === "&" || src[i] === "|")) {
        i++;
      }

      tokens.push({ k: "redir", op });
    } else if (c === "&") {
      endWord();
      if (n === "&") {
        tokens.push({ k: "sep", v: "&&" });
        i += 2;
      } else if (n === ">") {
        i += 2;
        let op = ">";
        if (src[i] === ">") {
          op = ">>";
          i++;
        }

        tokens.push({ k: "redir", op });
      } else {
        tokens.push({ k: "sep", v: "&" });
        i++;
      }
    } else if (c === "|") {
      endWord();
      if (n === "|") {
        tokens.push({ k: "sep", v: "||" });
        i += 2;
      } else {
        tokens.push({ k: "sep", v: "|" });
        i += n === "&" ? 2 : 1;
      }
    } else if (c === ";") {
      endWord();
      tokens.push({ k: "sep", v: ";" });
      i += n === ";" || n === "&" ? 2 : 1;
    } else {
      add(c, /\d/.test(c));
      i++;
    }
  }

  endWord();

  const segments: Segment[] = [];
  const fresh = (before: Separator | null): Segment => ({
    words: [],
    redirects: [],
    sep: null,
    before,
    subs: [],
    vars: [],
  });

  let cur = fresh(null);
  let pending: string | null = null;
  for (const t of tokens) {
    if (t.k === "word") {
      if (pending) {
        cur.redirects.push({ op: pending, target: t.v });
        pending = null;
      } else {
        cur.words.push(t.v);
      }
    } else if (t.k === "sub") {
      cur.subs.push(t.v);
    } else if (t.k === "var") {
      cur.vars.push(t.v);
    } else if (t.k === "redir") {
      if (pending) {
        return fail("redirection without a target");
      }

      pending = t.op;
    } else {
      if (pending) {
        return fail("redirection without a target");
      }

      // An empty segment (a blank line, a group's parenthesis) keeps collecting; substitutions in it still count.
      if (cur.words.length > 0 || cur.redirects.length > 0) {
        cur.sep = t.v;
        segments.push(cur);
        cur = fresh(t.v);
      }
    }
  }

  if (pending) {
    return fail("redirection without a target");
  }

  if (cur.words.length > 0 || cur.redirects.length > 0 || cur.subs.length > 0) {
    segments.push(cur);
  }

  return { ok: true, segments };
}
