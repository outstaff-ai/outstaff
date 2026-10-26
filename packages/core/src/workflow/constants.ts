export const WORKFLOW_EVENT_TYPES = [
  "pr.opened",
  "pr.merged",
  "pr.closed",
  "pr.review_submitted",
  "pr.comment",
  "pr.conflicted",
  "pr.ci_failed",
  "ticket.assigned",
  "ticket.moved",
  "ticket.commented",
  "ticket.created",
  "doc.commented",
  "agent.handed_back",
  "agent.asked",
  "schedule.cron",
] as const;

export const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";
