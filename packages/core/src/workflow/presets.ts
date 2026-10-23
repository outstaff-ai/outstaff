import type { Rule } from "./rules.js";

const OPEN: Rule["if"] = { ticket_status: ["backlog", "ready", "active", "blocked"] };

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
    if: {
      all: [
        { actor_kind: "human" },
        { pr_author_kind: "agent" },
        { ticket_status: ["review", "blocked"] },
        { not: { review_state: ["approved"] } },
      ],
    },
    do: [
      { assign: "author" },
      { move: "active" },
      { schedule: { person: "author", kind: "review_feedback", priority: "high" } },
    ],
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
    do: [{ move: "review" }, { assign: "requester" }],
  },
  {
    id: "assigned-agent-scheduled",
    on: "ticket.assigned",
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
    if: {
      all: [
        { actor_kind: "human" },
        { pr_author_kind: "agent" },
        { not: { review_state: ["approved"] } },
      ],
    },
    do: [
      { assign: "author" },
      { schedule: { person: "author", kind: "review_feedback", priority: "high" } },
    ],
  },
  {
    id: "assigned-agent-scheduled",
    on: "ticket.assigned",
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
