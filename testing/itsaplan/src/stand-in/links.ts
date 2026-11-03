import type { ApiIssueLink } from "@outstaff/integration.shared.itsaplan";
import type { ItsaplanStore, StoredIssue, StoredLink } from "./types.js";

/** The kinds a link is made with that state the relation from the other issue's side. */
const REVERSED: Record<string, ApiIssueLink["kind"]> = {
  blocked_by: "blocks",
  duplicated_by: "duplicates",
};

const KINDS = new Set<string>(["blocks", "relates", "duplicates"]);

/** Links two issues as the API takes it: `kind` read from `from`'s side, kept the way round it is stated. */
export function addLink(
  s: ItsaplanStore,
  from: StoredIssue,
  to: StoredIssue,
  kind: string,
): StoredLink | undefined {
  const reversed = REVERSED[kind];
  if (!reversed && !KINDS.has(kind)) {
    return undefined;
  }

  const [a, b] = reversed ? [to, from] : [from, to];
  const link: StoredLink = {
    id: ++s.counters.link,
    from: a.identifier,
    to: b.identifier,
    kind: reversed ?? (kind as ApiIssueLink["kind"]),
  };

  s.links.push(link);
  return link;
}

/** Where a link of the issue, from either end, is in the store; -1 when the issue has no such link. */
export const linkIndex = (s: ItsaplanStore, issue: StoredIssue, id: number): number =>
  s.links.findIndex(
    (l) => l.id === id && (l.from === issue.identifier || l.to === issue.identifier),
  );

const linkedIssue = (s: ItsaplanStore, key: string): ApiIssueLink["issue"] => {
  const i = s.issues.find((x) => x.identifier === key)!;
  return {
    id: i.id,
    sequenceNumber: i.sequenceNumber,
    identifier: i.identifier,
    title: i.title,
    columnId: i.columnId,
  };
};

/** One link as `issue` reads it: outward when it is stated from `issue`, inward when from the other end. */
export function linkOf(s: ItsaplanStore, issue: StoredIssue, link: StoredLink): ApiIssueLink {
  const outward = link.from === issue.identifier;
  return {
    id: link.id,
    kind: link.kind,
    direction: outward ? "outward" : "inward",
    issue: linkedIssue(s, outward ? link.to : link.from),
  };
}

/** An issue as reading it answers: with its links, both ways. */
export function issueView(s: ItsaplanStore, issue: StoredIssue) {
  const links = s.links
    .filter((l) => l.from === issue.identifier || l.to === issue.identifier)
    .map((l) => linkOf(s, issue, l));

  return { ...issue, links };
}
