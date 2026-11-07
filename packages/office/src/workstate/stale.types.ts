import type { CanonicalStatus } from "@outstaff/core";

/** A ticket the board sweep found out of step with the facts: why, and the facts in a line. */
export interface StaleTicket {
  ticket: string;
  status: CanonicalStatus;

  /** Who it is assigned to, by the work state's id. */
  assignee?: string;

  /** `prs_finished`, `nothing_to_review`, `blockers_closed`, `check_passed`, `idle_with_human`, `stranded` or `subtickets_settled`. */
  reason: string;
  facts: string;
}
