import type { CanonicalStatus } from "@outstaff/core";
import type { PipelineCondition } from "@outstaff/policy";

/** Statuses of work that is not finished. */
export const UNFINISHED: CanonicalStatus[] = ["backlog", "ready", "active", "review", "blocked"];

export const HUMAN: PipelineCondition = { actor_kind: "human" };
export const NOT_CLOSED: PipelineCondition = { not: { ticket_status: ["done", "canceled"] } };

/** Not a ticket in a backlog status: planned for later, so nothing starts it until a human moves it on. */
export const NOT_BACKLOG: PipelineCondition = { not: { ticket_status: ["backlog"] } };

/**
 * A human's comment, or one on an open ticket. A human's mention is an explicit request, so it wakes the agent on a
 * closed ticket too; an agent's does not, so agents do not wake each other on finished work.
 */
export const BY_HUMAN_OR_OPEN: PipelineCondition = { any: [HUMAN, NOT_CLOSED] };

/**
 * Not a ticket in the blocked status because a ticket that blocks it is still open, which waits for that ticket, not
 * for work. When it fails, the trace names the open blockers.
 */
export const NOT_WAITING_ON_BLOCKERS: PipelineCondition = {
  any: [{ not: { ticket_status: ["blocked"] } }, { open_blockers: false }],
};

/** A blocked ticket an agent is blocked on: a comment on it goes to that agent. */
export const BLOCKED_ON_AGENT: PipelineCondition = { blocked_agent: true };

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
