import { tokenize } from "./shell-tokens.js";
import type { LexResult, Segment, Separator } from "./shell.types.js";

const fail = (reason: string): LexResult => ({ ok: false, reason });

/**
 * A small shell lexer. It understands quoting, command separators, redirection, here-documents, groups and
 * subshells. It never runs anything: expansions stay as written, and the source of each command or process
 * substitution is handed back so it can be judged as a command line of its own.
 */
export function lex(src: string): LexResult {
  const lexed = tokenize(src);
  if (!lexed.ok) {
    return lexed;
  }

  const { tokens } = lexed;
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
