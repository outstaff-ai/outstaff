export const WORKFLOW_EVENT_TYPES = [
  "pr.opened",
  "pr.merged",
  "pr.closed",
  "pr.review_submitted",
  "pr.comment",
  "pr.conflicted",
  "pr.ci_failed",
  "pr.ci_passed",
  "pr.base_merged",
  "pr.linked",
  "pr.merge_checks_passed",
  "pr.merge_checks_failed",
  "ticket.assigned",
  "ticket.moved",
  "ticket.commented",
  "ticket.created",
  "ticket.unblocked",
  "ticket.block_maybe_resolved",
  "board.stale",
  "ticket.closed",
  "doc.commented",
  "doc.linked",
  "agent.started",
  "agent.handed_back",
  "agent.asked",
  "schedule.cron",
] as const;

export const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";

/**
 * How an agent ended its turn on a work item: finished with a result to review, waiting for an answer, unable to
 * continue, or finished silently, with nothing to hand on and the ticket put back as the round found it.
 */
export const HAND_BACK_STATUSES = ["done", "waiting", "blocked", "silent"] as const;

/**
 * Work item kinds whose round may finish silently, with nothing to hand on and the ticket put back as the round found it: answering a
 * question, a chat request, a comment or a mention, an unblock, a finished milestone, a merge, or work on a pull request
 * that already exists (its feedback, a rebase, failing checks). Any other kind (a ticket to work on, a request filed without a tracker)
 * never does. A `done` hand-back, of any kind, needs a result to review or finished work.
 */
export const SILENT_KINDS: readonly string[] = [
  "chat",
  "question",
  "asked",
  "ticket_comment",
  "doc_feedback",
  "unblock",
  "milestone",
  "reconcile",
  "merge",
  "review_feedback",
  "merged_feedback",
  "rebase",
  "ci_failed",
  "merge_checks_failed",
];
