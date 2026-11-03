/** How much of a moment's text a result shows. */
export const EXCERPT_CHARS = 240;

/** The words of a search worth finding in a text: the terms it wants, not the ones it excludes or `or`. */
function wanted(query: string): string[] {
  return [...query.matchAll(/(-?)"?([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)]
    .filter(([, not, word]) => !not && word!.toLowerCase() !== "or")
    .map(([, , word]) => word!.toLowerCase());
}

/** Where the text first has one of the words, or the start of one in another form ("greetings" for "greeting"). */
function firstMatch(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  const at = (w: string) => lower.indexOf(w);
  const found = words
    .flatMap((w) => [at(w), at(w.slice(0, Math.max(4, w.length - 3)))])
    .filter((i) => i >= 0);

  return found.length > 0 ? Math.min(...found) : 0;
}

/** A short part of the text around the first match, on one line, marked where it was cut. */
export function excerpt(text: string, query: string, max = EXCERPT_CHARS): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }

  // A little of what came before the match, a quarter of the excerpt at most.
  const lead = Math.min(60, Math.floor(max / 4));
  const start = Math.max(0, Math.min(firstMatch(flat, wanted(query)) - lead, flat.length - max));
  const part = flat.slice(start, start + max).trim();
  return `${start > 0 ? "…" : ""}${part}${start + max < flat.length ? "…" : ""}`;
}
