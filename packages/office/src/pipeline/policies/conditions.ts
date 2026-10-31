import type { CanonicalStatus } from "@outstaff/core";
import type { PipelineCondition } from "@outstaff/policy";

/** Statuses of work that is not finished. */
export const UNFINISHED: CanonicalStatus[] = ["backlog", "ready", "active", "review", "blocked"];

export const HUMAN: PipelineCondition = { actor_kind: "human" };
export const NOT_CLOSED: PipelineCondition = { not: { ticket_status: ["done", "canceled"] } };

/** A hand-back as blocked, or as done on a ticket the agent moved to blocked, on a ticket still open. */
export const BLOCKED_HAND_BACK: PipelineCondition = {
  all: [
    {
      any: [
        { hand_back_status: ["blocked"] },
        { all: [{ hand_back_status: ["done"] }, { ticket_status: ["blocked"] }] },
      ],
    },
    NOT_CLOSED,
  ],
};

/** A trusted human's review or comment on an agent's pull request; a bare approval is a sign-off, not feedback. */
export const feedbackOn = (state: { pr_open: true } | { pr_merged: true }): PipelineCondition => ({
  all: [
    HUMAN,
    { pr_author_kind: "agent" },
    state,
    { not: { all: [{ review_state: ["approved"] }, { has_body: false }] } },
  ],
});

export const AGENT_PR_OPEN: PipelineCondition = {
  all: [{ pr_author_kind: "agent" }, { pr_open: true }, { not: { ticket_status: ["canceled"] } }],
};
