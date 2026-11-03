/** One term of a search, as the person wrote it: a word or a "quoted phrase", maybe excluded with a leading `-`. */
const TERM = /(-?)"([^"]*)"?|(-?)([^\s"]+)/g;

const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;

type Term = { kind: "or" } | { kind: "skip" } | { kind: "not" | "want"; text: string };

/** What one match of TERM is: a wanted or excluded term, `or`, or nothing worth matching. */
function termOf(match: RegExpMatchArray): Term {
  const [all, , phrase, , word] = match;
  const text = (phrase ?? word!).trim();
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return { kind: "skip" };
  }

  if (phrase === undefined && text.toLowerCase() === "or") {
    return { kind: "or" };
  }

  return { kind: all.startsWith("-") ? "not" : "want", text: quoted(text) };
}

/**
 * A search as SQLite FTS5 reads it, with the meaning Postgres gives it (`websearch_to_tsquery`): every word or phrase
 * must match, `or` between two of them matches either, and `-word` excludes. Each term is quoted, so nothing the person
 * writes is FTS5 syntax. Undefined when nothing is left to match.
 */
export function ftsQuery(text: string): string | undefined {
  const wanted: string[] = [];
  const excluded: string[] = [];
  let or = false;
  for (const match of text.matchAll(TERM)) {
    const term = termOf(match);
    if (term.kind === "or") {
      or = wanted.length > 0;
    } else if (term.kind === "not") {
      excluded.push(`NOT ${term.text}`);
    } else if (term.kind === "want") {
      wanted.push(or ? `OR ${term.text}` : term.text);
      or = false;
    }
  }

  return wanted.length === 0 ? undefined : [...wanted, ...excluded].join(" ");
}
