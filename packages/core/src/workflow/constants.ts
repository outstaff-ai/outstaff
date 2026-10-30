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
  "ticket.assigned",
  "ticket.moved",
  "ticket.commented",
  "ticket.created",
  "doc.commented",
  "agent.started",
  "agent.handed_back",
  "agent.asked",
  "schedule.cron",
] as const;

export const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";

/** How an agent ended its turn on a work item: finished, waiting for an answer, or unable to continue. */
export const HAND_BACK_STATUSES = ["done", "waiting", "blocked"] as const;
