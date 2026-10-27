import type { WorkGroup, WorkSummary } from "./types.js";

/** How a follow-up kind reads next to its status. Other kinds are only their status. */
const WHAT: Record<string, string> = {
  review_feedback: "addressing review",
  merged_feedback: "following up after merge",
  doc_feedback: "answering document comments",
  ticket_comment: "answering a ticket comment",
  asked: "answering a question on the ticket",
  merge: "merging",
  conflict: "resolving conflicts",
  ci_failed: "CI failed",
};

const keyOf = (i: WorkSummary) =>
  i.ticketKey ? `ticket:${i.ticketKey}` : i.pr ? `pr:${i.pr}` : `item:${i.id}`;

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A group that starts at its first item; empty titles and links are left out. */
const startGroup = (key: string, i: WorkSummary): WorkGroup => ({
  key,
  ...(i.ticketKey ? { ticketKey: i.ticketKey } : {}),
  ...(i.ticketTitle ? { ticketTitle: i.ticketTitle } : {}),
  ...(i.pr ? { pr: i.pr } : {}),
  ...(i.prNumber === undefined ? {} : { prNumber: i.prNumber }),
  ...(i.prTitle ? { prTitle: i.prTitle } : {}),
  ...(i.prUrl ? { prUrl: i.prUrl } : {}),
  title: i.title,
  items: [i],
});

/** Adds a later item to its group, filling in ticket and pull request details the group does not have yet. */
function joinGroup(g: WorkGroup, i: WorkSummary): void {
  g.items.push(i);
  const { ticketTitle, pr, prNumber, prTitle, prUrl } = i;
  Object.assign(g, defined({ ticketTitle, pr, prNumber, prTitle, prUrl }), g);
}

/** Groups items by ticket, or by pull request when there is no ticket, so a review round or a CI fix is part of the
 * piece of work it follows up on and never a place of its own. A group sits where its first item is. */
export function groupWork(items: readonly WorkSummary[]): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const i of items) {
    const key = keyOf(i);
    const g = groups.get(key);
    if (g) {
      joinGroup(g, i);
    } else {
      groups.set(key, startGroup(key, i));
    }
  }

  return [...groups.values()];
}

const STATUS: Record<string, string> = { active: "running" };

const link = (text: string, url?: string) => (url ? `[${text}](${url})` : text);

/** The key in front of the title, unless the title has it already. */
const withKey = (key: string, title?: string) =>
  !title ? key : title.toLowerCase().includes(key.toLowerCase()) ? title : `${key} ${title}`;

/** The title of an item that is the work itself, not a follow-up on it. */
const primaryTitle = (g: WorkGroup) => g.items.find((i) => !(i.kind && WHAT[i.kind]))?.title;

const isPrHead = (g: WorkGroup) => !g.ticketKey && g.pr !== undefined;

const prLabel = (g: WorkGroup) =>
  g.prNumber === undefined ? "the pull request" : `PR #${g.prNumber}`;

/** The title of a group headed by its pull request: the number and title, or the item title without a number. */
const prHeadText = (g: WorkGroup) =>
  g.prNumber === undefined ? g.title : `${prLabel(g)}${g.prTitle ? ` ${g.prTitle}` : ""}`;

/** The linked title a group's line starts with. */
function headOf(g: WorkGroup, ticketUrl: (key: string) => string | undefined): string {
  if (g.ticketKey) {
    return link(
      withKey(g.ticketKey, g.ticketTitle ?? primaryTitle(g)),
      ticketUrl(g.ticketKey) ?? g.prUrl,
    );
  }

  return isPrHead(g) ? link(prHeadText(g), g.prUrl) : link(g.title, g.prUrl);
}

/** What one item adds to its group's state list: a follow-up names what it does, queued work adds nothing. */
function itemState(g: WorkGroup, i: WorkSummary): string[] {
  const status = STATUS[i.status] ?? i.status;
  const what = i.kind ? WHAT[i.kind] : undefined;
  if (what) {
    return [`${status}: ${what}${isPrHead(g) ? "" : ` on ${link(prLabel(g), g.prUrl)}`}`];
  }

  return status === "queued" ? [] : [status];
}

/**
 * One numbered line per group:
 * `1. [ACME-1 Title](ticket link) (running: addressing review on [PR #4](pr link))`.
 */
export function formatWorkGroups(
  groups: readonly WorkGroup[],
  ticketUrl: (key: string) => string | undefined = () => undefined,
): string[] {
  return groups.map((g, n) => {
    const states = [...new Set(g.items.flatMap((i) => itemState(g, i)))];
    return `${n + 1}. ${headOf(g, ticketUrl)}${states.length ? ` (${states.join("; ")})` : ""}`;
  });
}
