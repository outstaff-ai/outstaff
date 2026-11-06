import type { ContextRecentPr } from "@outstaff/protocol";
import type { WorkItem } from "#/store/types.js";
import type { PrRecord } from "#/workstate/index.js";
import { MERGE_CHECKS_FAILED_KIND } from "./failed-checks.js";
import type { ContextReaders } from "./types.js";

/** The rounds on a failure of a pull request that another pull request of the agent's may already fix. */
const FAILURE_KINDS = new Set([MERGE_CHECKS_FAILED_KIND, "ci_failed", "rebase"]);

const keyIn = (prKey: string, number: number) =>
  `${prKey.slice(0, prKey.lastIndexOf("#"))}#${number}`;

/** When the failure was seen: the merge the checks followed, else when the round was queued for it. */
const sinceOf = (item: WorkItem, rec: PrRecord) =>
  item.kind === MERGE_CHECKS_FAILED_KIND && rec.mergeChecks?.since
    ? rec.mergeChecks.since
    : item.createdAt;

const entryOf = (key: string, p: PrRecord): ContextRecentPr => ({
  ref: keyIn(key, p.ref.number),
  number: p.ref.number,
  title: p.title,
  ...(p.url ? { url: p.url } : {}),
  state: p.state,
  draft: p.draft,
  ...(p.ticket ? { ticket: p.ticket } : {}),
  at: p.updatedAt,
});

/**
 * For a round on failing checks or a conflict of a pull request: the person's other pull requests in the same
 * repository, on any ticket, that the office saw opened or pushed to since the failure, latest first, at most `max`. A
 * fix made in another round (a chat request filed as a ticket, say) shows here, so the round does not make it again.
 * Undefined for any other item.
 */
export async function recentPrsOf(
  r: ContextReaders,
  item: WorkItem,
  max: number,
): Promise<ContextRecentPr[] | undefined> {
  if (!FAILURE_KINDS.has(item.kind) || item.subject?.type !== "pr" || !r.prs) {
    return undefined;
  }

  const key = item.subject.ref;
  const rec = (await r.store.getSubject("pr", key))?.data as PrRecord | undefined;
  if (!rec) {
    return undefined;
  }

  const since = Date.parse(sinceOf(item, rec));
  return r
    .prs(rec.ref.repo)
    .filter(
      (p) =>
        p.author.person === item.person &&
        p.ref.number !== rec.ref.number &&
        p.state !== "closed" &&
        !p.goneAt &&
        Date.parse(p.updatedAt) >= since,
    )
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max)
    .map((p) => entryOf(key, p));
}
