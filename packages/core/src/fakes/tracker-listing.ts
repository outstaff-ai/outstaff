import type { Issue, IssueFilter } from "#/ports/index.js";

/** What the fake knows about its issues beyond the issues: their parents and initiatives, by ticket key. */
interface Relations {
  parents: Map<string, string>;
  initiatives: Map<string, string>;
}

type Check = (i: Issue, r: Relations, f: IssueFilter) => boolean;

const lower = (s: string) => s.toLowerCase();

/** One check per filter; a filter not given passes everything. */
const CHECKS: Check[] = [
  (i, _p, f) => f.assignee === undefined || (i.assignee?.id ?? null) === f.assignee,
  (i, _p, f) => !f.status || f.status.some((s) => s === i.status.canonical),
  (i, _p, f) => f.label === undefined || i.labels.map(lower).includes(lower(f.label)),
  (i, r, f) => f.parent === undefined || r.parents.get(i.key) === f.parent,
  (i, r, f) => f.initiative === undefined || r.initiatives.get(i.key) === f.initiative,
  (i, _p, f) => !f.updatedSince || i.updatedAt >= f.updatedSince,
];

/** The fake's `listIssues`: the issues that match, most recently updated first; a brief listing has no body. */
export function listIssues(issues: Issue[], r: Relations, f: IssueFilter): Issue[] {
  return issues
    .filter((i) => CHECKS.every((check) => check(i, r, f)))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, f.limit)
    .map((i) => (f.brief ? { ...i, body: "" } : i));
}
