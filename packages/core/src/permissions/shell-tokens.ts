import { closeBacktick, closeParen, expansion, expansionsIn } from "./shell-expansion.js";
import type { Heredoc, Token, TokenResult } from "./shell.types.js";

const fail = (reason: string): TokenResult => ({ ok: false, reason });

/** The tokens of a command line: words, redirections, separators, substitutions and expanded variables. */
export function tokenize(src: string): TokenResult {
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
  return { ok: true, tokens };
}
