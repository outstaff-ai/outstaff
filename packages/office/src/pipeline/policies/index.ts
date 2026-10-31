import type { Policy } from "@outstaff/policy";
import { policy as assignedToAssignee } from "./assigned_to_assignee.js";
import { policy as chatToAddressed } from "./chat_to_addressed.js";
import { policy as ciFailedToAuthor } from "./ci_failed_to_author.js";
import { policy as docCommentToAgent } from "./doc_comment_to_agent.js";
import { policy as handBackBlocked } from "./hand_back_blocked.js";
import { policy as handBackBlockedToPm } from "./hand_back_blocked_to_pm.js";
import { policy as handBackDone } from "./hand_back_done.js";
import { policy as idlePullsNext } from "./idle_pulls_next.js";
import { policy as mergedClosesTicket } from "./merged_closes_ticket.js";
import { policy as mergeReady } from "./merge_ready.js";
import { policy as mergedFeedbackToAuthor } from "./merged_feedback_to_author.js";
import { policy as movedActiveToAssignee } from "./moved_active_to_assignee.js";
import { policy as movedActiveToLastWorker } from "./moved_active_to_last_worker.js";
import { policy as openedToReview } from "./opened_to_review.js";
import { policy as rebaseToAuthor } from "./rebase_to_author.js";
import { policy as reviewToAuthor } from "./review_to_author.js";
import { policy as startMarksActive } from "./start_marks_active.js";
import { policy as ticketCommentToAgent } from "./ticket_comment_to_agent.js";
import { policy as ticketCommentToLastWorker } from "./ticket_comment_to_last_worker.js";

/** The built-in policies, one module each, in the order the trace lists them. */
export const BUILT_IN_POLICIES: readonly Policy[] = [
  chatToAddressed,
  reviewToAuthor,
  mergedFeedbackToAuthor,
  mergedClosesTicket,
  rebaseToAuthor,
  ciFailedToAuthor,
  // After the rebase: on a merged base the author first brings the pull request up to date, then decides the merge.
  mergeReady,
  openedToReview,
  assignedToAssignee,
  ticketCommentToAgent,
  ticketCommentToLastWorker,
  movedActiveToAssignee,
  movedActiveToLastWorker,
  docCommentToAgent,
  startMarksActive,
  handBackDone,
  handBackBlocked,
  handBackBlockedToPm,
  idlePullsNext,
];

/**
 * Built-in policies that are on only while a `policies` switch is: the merge wake (`policies.merge.on_approval`) and the
 * idle pull (`policies.pull_ready`).
 */
export const POLICY_SWITCH_OF: Readonly<Record<string, string>> = {
  merge_ready: "merge.on_approval",
  idle_pulls_next: "pull_ready",
};
