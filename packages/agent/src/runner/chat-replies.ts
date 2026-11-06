import {
  formatWorkGroupHead,
  formatWorkGroups,
  groupWork,
  type WorkSummary,
} from "@outstaff/protocol";

type TicketUrl = (key: string) => string | undefined;

/** "A", "A and B", "A, B and C". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** What the running work reads as after "after": its heads, and whether one or several run. */
const runningText = (heads: string[]) =>
  `${listed(heads)}, which ${heads.length === 1 ? "is" : "are"} running now`;

/**
 * Where filed work went, when the person is busy: the office placed it next, after the running work and ahead of the
 * queued work. With queued work, the queued pieces are listed by number and the requester is offered to move it after
 * one; nothing waits for that answer, which reaches a chat session that moves it. Undefined when nothing else is open.
 */
export function placementNote(work: WorkSummary[], ticketUrl: TicketUrl): string | undefined {
  const groups = groupWork(work);
  const isRunning = (g: (typeof groups)[number]) => g.items.some((i) => i.status === "active");
  const running = groups.filter(isRunning).map((g) => formatWorkGroupHead(g, ticketUrl));
  const queued = groups.filter((g) => !isRunning(g));
  if (queued.length === 0) {
    return running.length ? `It runs after ${runningText(running)}.` : undefined;
  }

  return [
    `Queued next${running.length ? `, after ${listed(running)} (running)` : ""}. Ahead of:`,
    ...formatWorkGroups(queued, ticketUrl),
    "Tell me if it should go after one of these instead.",
  ].join("\n");
}
