import type { Issue, Tracker } from "@outstaff/core";

/** Words that say nothing about what a ticket is about. */
const STOP_WORDS = new Set(
  "a an and as at be by for from in into is it of on or so the this that to with".split(" "),
);

/** How many of a title's words a search runs on, and how many tickets each search reads. */
const SEARCHES = 2;
const PER_SEARCH = 10;

/** The words of a title that count: lower case, without punctuation or stop words. */
export function titleWords(title: string): string[] {
  return (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP_WORDS.has(w));
}

/**
 * Whether two titles name the same work: the same words, or at least two words in common that make up at least
 * three quarters of the longer title's words.
 */
export function similarTitles(a: string, b: string): boolean {
  const left = new Set(titleWords(a));
  const right = new Set(titleWords(b));
  if (left.size === 0 || right.size === 0) {
    return false;
  }

  const shared = [...left].filter((w) => right.has(w)).length;
  const longer = Math.max(left.size, right.size);
  return shared === longer || (shared >= 2 && shared / longer >= 0.75);
}

const open = (issue: Issue) =>
  issue.status.canonical !== "done" && issue.status.canonical !== "canceled";

/**
 * Open tickets whose title is close to `title`, found by searching the tracker for the title's longest words. `skip`
 * are tickets that may share the title on purpose, such as the parent. Best effort: a failing search finds nothing.
 */
export async function similarOpenTickets(
  tracker: Tracker,
  title: string,
  skip: (string | undefined)[],
): Promise<Issue[]> {
  const terms = [...new Set(titleWords(title))]
    .toSorted((a, b) => b.length - a.length)
    .slice(0, SEARCHES);

  try {
    const found = (await Promise.all(terms.map((t) => tracker.search(t, PER_SEARCH)))).flat();
    const unique = new Map(found.map((i) => [i.key, i]));
    return [...unique.values()].filter(
      (i) => !skip.includes(i.key) && open(i) && similarTitles(title, i.title),
    );
  } catch {
    return [];
  }
}

/**
 * The warning `ost ticket create` adds when it found open tickets like the new one: its lines, the data that lists
 * them, and their links. Nothing when it found none.
 */
export function similarWarning(tracker: Tracker, key: string, similar: Issue[]) {
  if (similar.length === 0) {
    return { lines: [], data: {}, links: [] };
  }

  const links = similar.map((i) => tracker.links.issue(i.key));
  return {
    lines: [
      "Warning: open tickets with a similar title:",
      ...similar.map((i, n) => `- ${i.key}: ${i.title} (${links[n]})`),
      `If one of them is this work, change that ticket instead (ost ticket assign, move or edit) and cancel ${key} with a comment that links it (ost ticket move ${key} canceled). If it is separate work, say why in a comment on ${key}.`,
    ],
    data: { similar: similar.map((i) => ({ key: i.key, title: i.title })) },
    links,
  };
}
