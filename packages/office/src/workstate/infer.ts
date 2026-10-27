import { compileTicketLink, TICKET_KEY as KEY } from "@outstaff/core";
import type { TicketCandidate } from "./types.js";

// The closing keywords GitHub uses; a bare mention or a softer verb (`Refs`) links nothing.
const CLOSING = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+(${KEY})\\b`,
  "gi",
);

const ANY_KEY = new RegExp(`\\b(${KEY})\\b`, "g");

function all(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!.toUpperCase());
}

/**
 * Ticket keys that link a pull request, best first: the branch name, the title, then a closing
 * keyword in the body (`Closes ACME-12`), then a repository's own `ticket_link` patterns. A key mentioned elsewhere in the body links nothing.
 * Each key appears once, with the first source that named it.
 */
export function ticketCandidates(
  pr: { headRef: string; title: string; body?: string },
  extra: readonly string[] = [],
): TicketCandidate[] {
  const body = pr.body ?? "";
  const custom = extra.flatMap((pattern) => {
    const re = compileTicketLink(pattern);
    return typeof re === "string"
      ? []
      : [...body.matchAll(re)].map((m) => ({
          key: m.groups!.key!.toUpperCase(),
          source: "ticket_link" as const,
        }));
  });

  const ordered: TicketCandidate[] = [
    ...all(ANY_KEY, pr.headRef).map((key) => ({ key, source: "branch" as const })),
    ...all(ANY_KEY, pr.title).map((key) => ({ key, source: "title" as const })),
    ...all(CLOSING, body).map((key) => ({ key, source: "closing keyword" as const })),
    ...custom,
  ];

  return ordered.filter((c, i) => ordered.findIndex((o) => o.key === c.key) === i);
}
