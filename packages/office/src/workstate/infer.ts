const KEY = "[A-Za-z][A-Za-z0-9]{1,9}-\\d+";
const CLOSING = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|implements?)\\b:?\\s+(${KEY})\\b`,
  "gi",
);

const ANY_KEY = new RegExp(`\\b(${KEY})\\b`, "g");

function all(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!.toUpperCase());
}

/**
 * Ticket keys a pull request may refer to, best guess first: a closing reference in the body
 * (`Closes ACME-12`), the branch name, the title, then any other key in the body.
 */
export function ticketCandidates(pr: { headRef: string; title: string; body?: string }): string[] {
  const body = pr.body ?? "";
  const ordered = [
    ...all(CLOSING, body),
    ...all(ANY_KEY, pr.headRef),
    ...all(ANY_KEY, pr.title),
    ...all(ANY_KEY, body),
  ];

  return [...new Set(ordered)];
}
