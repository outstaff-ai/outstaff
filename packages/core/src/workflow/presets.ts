import type { Condition, Rule } from "./rules.js";

const OPEN: Rule["if"] = { ticket_status: ["backlog", "ready", "active", "blocked"] };

/**
 * A trusted human's review or comment on an open pull request an agent wrote. An approval with
 * nothing written in it is a sign-off, not feedback.
 */
const feedbackOn = (state: { pr_open: true } | { pr_merged: true }): Condition => ({
  all: [
    { actor_kind: "human" },
    { pr_author_kind: "agent" },
    state,
    { not: { all: [{ review_state: ["approved"] }, { has_body: false }] } },
  ],
});

const humanFeedback = feedbackOn({ pr_open: true });

/**
 * The same on a merged pull request. The author answers on it and, if a change is asked for, opens a follow-up
 * pull request; the ticket is not reopened, so there is no assign or move.
 */
const mergedFeedbackRule: Rule = {
  id: "merged-feedback-follow-up",
  on: ["pr.review_submitted", "pr.comment"],
  if: feedbackOn({ pr_merged: true }),
  do: [{ schedule: { person: "author", kind: "merged_feedback", priority: "high" } }],
};

const kanbanRules: Rule[] = [
  {
    id: "pr-opened-review",
    on: "pr.opened",
    if: { all: [{ not: { pr_draft: true } }, OPEN] },
    do: [{ move: "review" }],
  },
  {
    id: "pr-merged-done",
    on: "pr.merged",
    if: { ticket_status: ["backlog", "ready", "active", "review", "blocked"] },
    do: [{ move: "done" }],
  },
  {
    id: "pr-closed-ready",
    on: "pr.closed",
    if: { ticket_status: ["active", "review"] },
    do: [{ move: "ready" }],
  },
  {
    id: "human-feedback-back-to-author",
    on: ["pr.review_submitted", "pr.comment"],
    if: humanFeedback,
    do: [{ schedule: { person: "author", kind: "review_feedback", priority: "high" } }],
  },
  mergedFeedbackRule,
  {
    id: "human-feedback-reactivates-ticket",
    on: ["pr.review_submitted", "pr.comment"],
    if: { all: [humanFeedback, { ticket_status: ["review", "blocked"] }] },
    do: [{ assign: "author" }, { move: "active" }],
  },
  {
    id: "conflict-back-to-author",
    on: "pr.conflicted",
    if: { all: [{ pr_author_kind: "agent" }, { ticket_status: ["review", "active", "blocked"] }] },
    do: [
      { assign: "author" },
      { move: "active" },
      { comment: "rebase_conflict" },
      { schedule: { person: "author", kind: "conflict", priority: "high" } },
    ],
  },
  {
    id: "active-human-takeback",
    on: "ticket.moved",
    if: {
      all: [
        { moved_to: ["active"] },
        { assignee_kind: "human" },
        { not: { has_label: "$needs_human" } },
      ],
    },
    do: [
      { assign: "last_worker" },
      { schedule: { person: "last_worker", kind: "assigned", priority: "normal" } },
    ],
  },
  {
    id: "hand-back-to-requester",
    on: "agent.handed_back",
    // A finished ticket stays finished: the answer to feedback on a merged pull request reopens nothing.
    // Waiting (for an answer) changes nothing here; blocked has its own rule.
    if: {
      all: [{ hand_back_status: ["done"] }, { not: { ticket_status: ["done", "canceled"] } }],
    },
    do: [{ move: "review" }, { assign: "requester" }],
  },
  {
    id: "hand-back-blocked-to-requester",
    on: "agent.handed_back",
    if: {
      all: [{ hand_back_status: ["blocked"] }, { not: { ticket_status: ["done", "canceled"] } }],
    },
    do: [
      { move: "blocked" },
      { assign: "requester" },
      { notify: { to: "requester", template: "hand_back_blocked" } },
    ],
  },
  {
    id: "assigned-agent-scheduled",
    // A ticket created already assigned has one `created` item and no assignment item to go on.
    on: ["ticket.assigned", "ticket.created"],
    if: {
      all: [
        { assignee_kind: "agent" },
        { not: { actor_kind: "automation" } },
        { not: { ticket_status: ["done", "canceled"] } },
      ],
    },
    do: [{ schedule: { person: "assignee", kind: "assigned", priority: "normal" } }],
  },
];

/** In scrum, `ready` means committed to the sprint: work on uncommitted (backlog) tickets is not started. */
const scrumRules: Rule[] = kanbanRules.map((r) =>
  r.id === "assigned-agent-scheduled"
    ? {
        ...r,
        if: {
          all: [
            { assignee_kind: "agent" },
            { not: { actor_kind: "automation" } },
            { ticket_status: ["ready", "active", "review", "blocked"] },
          ],
        },
      }
    : r,
);

/** Scheduling on assignment and the review loop; never moves a ticket. */
const minimalRules: Rule[] = [
  {
    id: "human-feedback-back-to-author",
    on: ["pr.review_submitted", "pr.comment"],
    if: humanFeedback,
    do: [
      { assign: "author" },
      { schedule: { person: "author", kind: "review_feedback", priority: "high" } },
    ],
  },
  mergedFeedbackRule,
  {
    id: "assigned-agent-scheduled",
    // A ticket created already assigned has one `created` item and no assignment item to go on.
    on: ["ticket.assigned", "ticket.created"],
    if: { all: [{ assignee_kind: "agent" }, { not: { actor_kind: "automation" } }] },
    do: [{ schedule: { person: "assignee", kind: "assigned", priority: "normal" } }],
  },
];

export const WORKFLOW_PRESETS = ["kanban", "scrum", "minimal"] as const;
export type WorkflowPreset = (typeof WORKFLOW_PRESETS)[number];

const PRESETS: Record<WorkflowPreset, readonly Rule[]> = {
  kanban: kanbanRules,
  scrum: scrumRules,
  minimal: minimalRules,
};

export function presetRules(preset: WorkflowPreset): Rule[] {
  return structuredClone(PRESETS[preset]) as Rule[];
}
