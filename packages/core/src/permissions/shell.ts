export type Separator = "&&" | "||" | ";" | "|" | "&";

export interface Redirect {
  /** `>`, `>>` or `<`. */
  op: string;
  target: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];

  /** What follows this segment; null for the last one. */
  sep: Separator | null;

  /** What preceded this segment; null for the first one. */
  before: Separator | null;
}

export type LexResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

type Token = { k: "word"; v: string } | { k: "redir"; op: string } | { k: "sep"; v: Separator };

const NAME_START = /[A-Za-z_0-9@*#?!$-]/;

const fail = (reason: string): LexResult => ({ ok: false, reason });

/**
 * A deliberately small shell lexer. It understands quoting, command separators and redirection,
 * and refuses anything whose meaning cannot be known without running a shell (substitution,
 * expansion, subshells, heredocs, brace expansion).
 */
export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  let buf = "";
  let inWord = false;
  let digitsOnly = true;
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

  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endWord();
      tokens.push({ k: "sep", v: ";" });
      i++;
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
      inWord = true;
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
        } else if (d === "`" || (d === "$" && src[i + 1] === "(")) {
          return fail("command substitution is not allowed");
        } else if (d === "$" && src[i + 1] !== undefined && NAME_START.test(src[i + 1]!)) {
          return fail("variable expansion is not allowed");
        } else if (d === "$" && src[i + 1] === "{") {
          return fail("variable expansion is not allowed");
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
      return fail("command substitution is not allowed");
    } else if (c === "$") {
      if (n === "(") {
        return fail("command substitution is not allowed");
      }

      if (n === "'" || n === '"') {
        return fail("$-quoting is not allowed");
      }

      if (n !== undefined && (NAME_START.test(n) || n === "{")) {
        return fail("variable expansion is not allowed");
      }

      add(c);
      i++;
    } else if (c === "(" || c === ")") {
      return fail("subshells and groups are not allowed");
    } else if (c === "{" && /^\{[^\s}]*(,|\.\.)/.test(src.slice(i))) {
      return fail("brace expansion is not allowed");
    } else if (c === "<" || c === ">") {
      if (n === "(") {
        return fail("process substitution is not allowed");
      }

      if (c === "<" && n === "<") {
        return fail("heredocs are not allowed");
      }
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

      if (c === ">" && src[i] === "&" && /[\d-]/.test(src[i + 1] ?? "")) {
        // fd duplication such as 2>&1: no file involved.
        i += 2;
        while (/\d/.test(src[i] ?? "")) {
          i++;
        }

        continue;
      }

      if (c === ">" && src[i] === "&") {
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
      if (n === ";") {
        return fail("unsupported syntax");
      }

      tokens.push({ k: "sep", v: ";" });
      i++;
    } else {
      add(c, /\d/.test(c));
      i++;
    }
  }

  endWord();

  const segments: Segment[] = [];
  let cur: Segment = { words: [], redirects: [], sep: null, before: null };
  let pending: string | null = null;
  const close = (sep: Separator | null): string | null => {
    if (pending) {
      return "redirection without a target";
    }

    if (cur.words.length === 0 && cur.redirects.length === 0) {
      if (sep === "&&" || sep === "||" || sep === "|") {
        return "empty command";
      }

      return null;
    }

    cur.sep = sep;
    segments.push(cur);
    cur = { words: [], redirects: [], sep: null, before: sep };
    return null;
  };

  for (const t of tokens) {
    if (t.k === "word") {
      if (pending) {
        cur.redirects.push({ op: pending, target: t.v });
        pending = null;
      } else {
        cur.words.push(t.v);
      }
    } else if (t.k === "redir") {
      if (pending) {
        return fail("redirection without a target");
      }

      pending = t.op;
    } else {
      const err = close(t.v);
      if (err) {
        return fail(err);
      }
    }
  }

  const err = close(null);
  if (err) {
    return fail(err);
  }

  return { ok: true, segments };
}
