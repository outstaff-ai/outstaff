import { tokenize } from "./shell-tokens.js";
import type { LexResult, Segment, Separator, Token } from "./shell.types.js";

/** The segments read so far, the one being built and a redirection still waiting for its target. */
type Collecting = { segments: Segment[]; cur: Segment; pending: string | null };

const MISSING_TARGET: LexResult = { ok: false, reason: "redirection without a target" };

const fresh = (before: Separator | null): Segment => ({
  words: [],
  redirects: [],
  sep: null,
  before,
  subs: [],
  vars: [],
});

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

  const state: Collecting = { segments: [], cur: fresh(null), pending: null };
  for (const t of lexed.tokens) {
    if (!collect(state, t)) {
      return MISSING_TARGET;
    }
  }

  if (state.pending) {
    return MISSING_TARGET;
  }

  if (hasCommand(state.cur) || state.cur.subs.length > 0) {
    state.segments.push(state.cur);
  }

  return { ok: true, segments: state.segments };
}

/** Adds a token to the segment being built; false when it leaves a redirection without a target. */
function collect(state: Collecting, t: Token): boolean {
  switch (t.k) {
    case "word":
      addWord(state, t.v);
      return true;
    case "sub":
      state.cur.subs.push(t.v);
      return true;
    case "var":
      state.cur.vars.push(t.v);
      return true;
    case "redir":
      return startRedirect(state, t.op);
    case "sep":
      return endSegment(state, t.v);
  }
}

/** A word is the target of a pending redirection, or else the next word of the command. */
function addWord(state: Collecting, word: string): void {
  if (state.pending) {
    state.cur.redirects.push({ op: state.pending, target: word });
    state.pending = null;
  } else {
    state.cur.words.push(word);
  }
}

function startRedirect(state: Collecting, op: string): boolean {
  if (state.pending) {
    return false;
  }

  state.pending = op;

  return true;
}

function endSegment(state: Collecting, sep: Separator): boolean {
  if (state.pending) {
    return false;
  }

  // An empty segment (a blank line, a group's parenthesis) keeps collecting; substitutions in it still count.
  if (hasCommand(state.cur)) {
    state.cur.sep = sep;
    state.segments.push(state.cur);
    state.cur = fresh(sep);
  }

  return true;
}

function hasCommand(segment: Segment): boolean {
  return segment.words.length > 0 || segment.redirects.length > 0;
}
