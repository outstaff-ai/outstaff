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

/** A trusted human's comment or reply on a document an agent wrote goes back to that agent. */
const docFeedbackRule: Rule = {
  id: "doc-feedback-to-author",
  on: "doc.commented",
  if: { actor_kind: "human" },
  do: [{ schedule: { person: "doc_author", kind: "doc_feedback", priority: "high" } }],
};

/** A trusted human's comment on a ticket assigned to an agent starts a round for that agent. */
const ticketCommentRule = (status: Condition): Rule => ({
  id: "ticket-comment-to-assignee",
  on: "ticket.commented",
  if: {
    all: [
      { actor_kind: "human" },
      { not: { agent_mentioned: true } },
      { assignee_kind: "agent" },
      status,
    ],
  },
  do: [{ schedule: { person: "assignee", kind: "ticket_comment", priority: "high" } }],
});

/**
 * A comment on a ticket the agent handed back (assigned to a person, in review or blocked) is feedback: the ticket
 * goes back to the agent who last worked on it, as `human-feedback-reactivates-ticket` does for a pull request.
 */
const ticketCommentReactivatesRule: Rule = {
  id: "ticket-comment-reactivates-ticket",
  on: "ticket.commented",
  if: {
    all: [
      { actor_kind: "human" },
      { not: { agent_mentioned: true } },
      { assignee_kind: "human" },
      { ticket_status: ["review", "blocked"] },
    ],
  },
  do: [
    { assign: "last_worker" },
    { move: "active" },
    { schedule: { person: "last_worker", kind: "ticket_comment", priority: "high" } },
  ],
};

/**
 * A trusted human's comment on an open ticket that mentions team agents hands the ticket to the first one: it is
 * assigned to them and (except in `minimal`, which never moves a ticket) moved to active, and they get a round with
 * the comment. Every other agent mentioned gets an `asked` round, to answer on the ticket without taking it. It goes
 * to the mentioned agent, not to the assignee or the last worker, so the two rules above leave such a comment alone.
 */
const mentionRule = (moves: boolean): Rule => ({
  id: "mention-assigns-agent",
  on: "ticket.commented",
  if: {
    all: [
      { actor_kind: "human" },
      { agent_mentioned: true },
      { not: { ticket_status: ["done", "canceled"] } },
    ],
  },
  do: [
    { assign: "mentioned" },
    ...(moves ? [{ move: "active" } as const] : []),
    { schedule: { person: "mentioned", kind: "ticket_comment", priority: "high" } },
    { schedule: { person: "other_mentioned", kind: "asked", priority: "high" } },
  ],
});

/** A mention on a document gives the first agent mentioned a round on the document's comments. */
const docMentionRule: Rule = {
  id: "doc-mention-feedback",
  on: "doc.commented",
  if: { all: [{ actor_kind: "human" }, { agent_mentioned: true }] },
  do: [
    { schedule: { person: "mentioned", kind: "doc_feedback", priority: "high" } },
    { schedule: { person: "other_mentioned", kind: "doc_feedback", priority: "high" } },
  ],
};

/** The ticket a document was written for goes to the agent mentioned on it, unless an agent already has it. */
const docMentionAssignsRule: Rule = {
  id: "doc-mention-assigns-ticket",
  on: "doc.commented",
  if: {
    all: [
      { actor_kind: "human" },
      { agent_mentioned: true },
      { ticket_status: ["backlog", "ready", "active", "review", "blocked"] },
      { any: [{ assignee_kind: "human" }, { assignee_kind: "none" }] },
    ],
  },
  do: [{ assign: "mentioned" }],
};

/**
 * An allowed approver approved an open pull request an agent wrote: its author merges it (`ost pr merge` checks
 * everything again). Exists only while `policies.merge.on_approval` is on. An approval that carries comments is
 * feedback first: it schedules only the review round, and `approved-merge-after-feedback` merges after that round.
 */
const approvedMergeRule: Rule = {
  id: "approved-merge",
  on: "pr.review_submitted",
  if: {
    all: [
      { approver: true },
      { pr_author_kind: "agent" },
      { pr_open: true },
      { review_state: ["approved"] },
      { has_body: false },
    ],
  },
  do: [{ schedule: { person: "author", kind: "merge", priority: "high" } }],
};

/**
 * The author handed back the round on an approval's comments, and the pull request is approved by an allowed
 * approver with no change requested since: now it merges. Same switch as `approved-merge`.
 */
const approvedMergeAfterFeedbackRule: Rule = {
  id: "approved-merge-after-feedback",
  on: "agent.handed_back",
  if: {
    all: [
      { hand_back_status: ["done"] },
      { hand_back_kind: ["review_feedback"] },
      { pr_author_kind: "agent" },
      { pr_open: true },
      { pr_approved: true },
    ],
  },
  do: [{ schedule: { person: "author", kind: "merge", priority: "high" } }],
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
    id: "second-pr-comment",
    // A person opened it, so `ost pr open` could not refuse it: the ticket is told instead.
    on: "pr.opened",
    if: {
      all: [
        { pr_author_kind: "human" },
        { ticket_prs_several: true },
        { not: { ticket_status: ["done", "canceled"] } },
      ],
    },
    do: [{ comment: "second_pr" }],
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
  docFeedbackRule,
  docMentionRule,
  docMentionAssignsRule,
  ticketCommentRule({ not: { ticket_status: ["done", "canceled"] } }),
  ticketCommentReactivatesRule,
  mentionRule(true),
  approvedMergeRule,
  approvedMergeAfterFeedbackRule,
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
    // A ticket the agent moved to blocked stays blocked: a done hand-back on it counts as blocked.
    if: {
      all: [
        { hand_back_status: ["done"] },
        { not: { ticket_status: ["blocked", "done", "canceled"] } },
      ],
    },
    do: [{ move: "review" }, { assign: "requester" }],
  },
  {
    id: "hand-back-blocked-to-requester",
    on: "agent.handed_back",
    if: {
      all: [
        {
          any: [
            { hand_back_status: ["blocked"] },
            { all: [{ hand_back_status: ["done"] }, { ticket_status: ["blocked"] }] },
          ],
        },
        { not: { ticket_status: ["done", "canceled"] } },
      ],
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
const COMMITTED: Condition = { ticket_status: ["ready", "active", "review", "blocked"] };
const scrumRules: Rule[] = kanbanRules.map((r) => {
  switch (r.id) {
    case "assigned-agent-scheduled":
      return {
        ...r,
        if: {
          all: [{ assignee_kind: "agent" }, { not: { actor_kind: "automation" } }, COMMITTED],
        },
      };
    case "ticket-comment-to-assignee":
      return ticketCommentRule(COMMITTED);
    default:
      return r;
  }
});

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
  docFeedbackRule,
  docMentionRule,
  docMentionAssignsRule,
  ticketCommentRule({ not: { ticket_status: ["done", "canceled"] } }),
  mentionRule(false),
  approvedMergeRule,
  approvedMergeAfterFeedbackRule,
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
