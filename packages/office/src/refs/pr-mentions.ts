import type { PrMention } from "./types.js";

/** How many pull requests one text may name; a longer list is cut, the rest is left to the agent's tools. */
export const MAX_PR_MENTIONS = 5;

// A link to a pull request (`https://<host>/<owner>/<repo>/pull/<n>`), `<owner>/<repo>#<n>`, "PR <n>", "PR #<n>",
// "pull request <n>", or a bare `#<n>`. The repository is named only by the first two.
const LINK = /https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)/g;
const SLUG = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const WORD = /\b(?:PR|pull request)\s*#?(\d+)\b/gi;
const BARE = /(?<![\w/.-])#(\d+)\b/g;

const scan = (text: string, re: RegExp, named: boolean): PrMention[] =>
  [...text.matchAll(re)].map((m) =>
    named
      ? { number: Number(m[3]), repo: `${m[1]}/${m[2]}`.toLowerCase() }
      : { number: Number(m[1]) },
  );

/**
 * The pull requests a text names, each once, the ones with their repository first, at most `MAX_PR_MENTIONS`. A
 * number also named with its repository is not repeated without it.
 */
export function prMentionsIn(text: string): PrMention[] {
  const named = [...scan(text, LINK, true), ...scan(text, SLUG, true)];
  const bare = [...scan(text, WORD, false), ...scan(text, BARE, false)].filter(
    (b) => !named.some((n) => n.number === b.number),
  );

  const all = [...named, ...bare];
  const key = (m: PrMention) => `${m.repo ?? ""}#${m.number}`;
  return all
    .filter((m, i) => all.findIndex((x) => key(x) === key(m)) === i)
    .slice(0, MAX_PR_MENTIONS);
}
