import type { WorkSummary } from "./schemas.js";

/** How a follow-up kind reads next to its status. Other kinds are only their status. */
const WHAT: Record<string, string> = {
  review_feedback: "addressing review",
  merged_feedback: "following up after merge",
  conflict: "resolving conflicts",
  ci_failed: "CI failed",
};

/** One piece of work: a ticket, or a pull request without one, with the follow-ups on it. */
export interface WorkGroup {
  key: string;
  ticketKey?: string;
  ticketTitle?: string;
  pr?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;

  /** Title of the first item, for work that has neither a ticket nor a pull request. */
  title: string;

  /** The items of the group, in the order they were given. */
  items: WorkSummary[];
}

const keyOf = (i: WorkSummary) =>
  i.ticketKey ? `ticket:${i.ticketKey}` : i.pr ? `pr:${i.pr}` : `item:${i.id}`;

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Groups items by ticket, or by pull request when there is no ticket, so a review round or a CI fix is part of the
 * piece of work it follows up on and never a place of its own. A group sits where its first item is. */
export function groupWork(items: readonly WorkSummary[]): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const i of items) {
    const key = keyOf(i);
    const g = groups.get(key);
    if (g) {
      g.items.push(i);
      Object.assign(
        g,
        defined({
          ticketTitle: i.ticketTitle,
          pr: i.pr,
          prNumber: i.prNumber,
          prTitle: i.prTitle,
          prUrl: i.prUrl,
        }),
        g,
      );

      continue;
    }

    groups.set(key, {
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

/**
 * One numbered line per group:
 * `1. [ACME-1 Title](ticket link) (running: addressing review on [PR #4](pr link))`.
 */
export function formatWorkGroups(
  groups: readonly WorkGroup[],
  ticketUrl: (key: string) => string | undefined = () => undefined,
): string[] {
  return groups.map((g, n) => {
    const headIsPr = !g.ticketKey && g.pr !== undefined;
    const pr = g.prNumber === undefined ? "the pull request" : `PR #${g.prNumber}`;
    const head = g.ticketKey
      ? link(
          withKey(g.ticketKey, g.ticketTitle ?? primaryTitle(g)),
          ticketUrl(g.ticketKey) ?? g.prUrl,
        )
      : headIsPr
        ? link(
            g.prNumber === undefined ? g.title : `${pr}${g.prTitle ? ` ${g.prTitle}` : ""}`,
            g.prUrl,
          )
        : link(g.title, g.prUrl);

    const parts = g.items.flatMap((i) => {
      const status = STATUS[i.status] ?? i.status;
      const what = i.kind ? WHAT[i.kind] : undefined;
      if (what) {
        return [`${status}: ${what}${headIsPr ? "" : ` on ${link(pr, g.prUrl)}`}`];
      }

      return status === "queued" ? [] : [status];
    });

    const states = [...new Set(parts)];
    return `${n + 1}. ${head}${states.length ? ` (${states.join("; ")})` : ""}`;
  });
}
