import { CHAT_KIND } from "#/scheduler/policy.js";
import type { WorkItem } from "#/store/types.js";
import { worksOnTicket } from "#/workstate/blocked.js";
import type { NoticeDeskOptions, NoticeEntry, PendingNotices } from "./notify.types.js";

/** Work that is still to come: queued, or under way. */
const AHEAD = new Set<WorkItem["status"]>(["queued", "active"]);

/** The subjects of the entry's work: its ticket and the ticket's pull requests, or the pull requests it names. */
function subjectsOf(workState: NoticeDeskOptions["workState"], e: NoticeEntry): Set<string> {
  const prs = e.ticket
    ? workState.prsOfTicket(e.ticket).map((r) => workState.prSubject(r.ref))
    : e.prs.map((p) => p.ref);

  return new Set([...(e.ticket ? [`ticket:${e.ticket}`] : []), ...prs.map((r) => `pr:${r}`)]);
}

/**
 * Whether the item is more work on the entry's ticket or pull requests. A blocked notice is superseded only by the
 * reply to it: work a human started on the ticket since the block was told.
 */
const supersedes = (e: NoticeEntry, subjects: ReadonlySet<string>) => (i: WorkItem) =>
  !!i.subject &&
  subjects.has(`${i.subject.type}:${i.subject.ref}`) &&
  (e.need !== "blocked" || (i.trigger === "human" && Date.parse(i.updatedAt) >= Date.parse(e.at)));

/**
 * Drops the notices that more work of the same agent on the same ticket or pull request, queued or running, makes
 * stale: that round hands back after it, and its notice is the one sent. A dropped notice tells the human nothing, so
 * it is not recorded as what they were told.
 */
export function createSupersede(opts: Pick<NoticeDeskOptions, "store" | "workState" | "logger">) {
  const { store, workState, logger: log } = opts;

  return async (p: PendingNotices, entries: readonly NoticeEntry[]): Promise<NoticeEntry[]> => {
    if (entries.length === 0) {
      return [];
    }

    const ahead = (await store.listItems({ person: p.as })).filter(
      (i) => AHEAD.has(i.status) && i.kind !== CHAT_KIND && worksOnTicket(i.kind),
    );

    return entries.filter((e) => {
      const by = ahead.find(supersedes(e, subjectsOf(workState, e)));
      if (by) {
        log.info(
          `notify: nothing sent to ${p.human} about ${e.ticket ?? e.prs[0]?.ref}: superseded by ${by.id} (${by.kind} on ${by.subject!.ref})`,
          { as: p.as, event: e.event, item: by.id },
        );
      }

      return !by;
    });
  };
}
