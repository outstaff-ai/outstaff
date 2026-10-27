import type { CanonicalStatus } from "@outstaff/core";
import type { PipelineCondition, Policy } from "./policy.types.js";

const UNFINISHED: CanonicalStatus[] = ["backlog", "ready", "active", "review", "blocked"];
const HUMAN: PipelineCondition = { actor_kind: "human" };
const NOT_CLOSED: PipelineCondition = { not: { ticket_status: ["done", "canceled"] } };

/** A trusted human's review or comment on an agent's pull request; a bare approval is a sign-off, not feedback. */
const feedbackOn = (state: { pr_open: true } | { pr_merged: true }): PipelineCondition => ({
  all: [
    HUMAN,
    { pr_author_kind: "agent" },
    state,
    { not: { all: [{ review_state: ["approved"] }, { has_body: false }] } },
  ],
});

const AGENT_PR_OPEN: PipelineCondition = {
  all: [{ pr_author_kind: "agent" }, { pr_open: true }, { not: { ticket_status: ["canceled"] } }],
};

/** The policies the office runs when the team changes nothing, in evaluation order. */
export const DEFAULT_POLICIES: readonly Policy[] = [
  {
    id: "chat_to_addressed",
    summary: "A chat message wakes the agent it was written to.",
    on: ["chat.message"],
    when: HUMAN,
    decide: { wake: { person: "addressed", kind: "chat" } },
    instruction:
      "{{actor.id}} wrote to you in chat. Answer in the thread. If they ask for work, decide how it fits your queue.",
  },
  {
    id: "review_to_author",
    summary: "A human's review or comment on an agent's open pull request wakes its author.",
    on: ["pr.review_submitted", "pr.comment"],
    when: feedbackOn({ pr_open: true }),
    decide: { wake: { person: "author", kind: "review_feedback" } },
    instruction:
      "{{actor.id}} left feedback on your pull request #{{pr.number}} ({{pr.title}}). Address each point, answer in its thread and push.",
  },
  {
    id: "merged_feedback_to_author",
    summary: "A human's review or comment on an agent's merged pull request wakes its author.",
    on: ["pr.review_submitted", "pr.comment"],
    when: feedbackOn({ pr_merged: true }),
    decide: { wake: { person: "author", kind: "merged_feedback" } },
    instruction:
      "{{actor.id}} commented on your merged pull request #{{pr.number}} ({{pr.title}}). Answer there. If they ask for a change, open a follow-up pull request.",
  },
  {
    id: "merged_closes_ticket",
    summary:
      "A merge into the default branch closes the ticket for the author, unless another of its pull requests is open.",
    on: ["pr.merged"],
    when: {
      all: [
        { ticket_status: UNFINISHED },
        { pr_base_default: true },
        { not: { ticket_prs_open: true } },
      ],
    },
    decide: { act: { as: "author", ops: [{ move: "done" }] } },
    instruction: "Moved to done for {{person}} (pull request #{{pr.number}} merged).",
  },
  {
    id: "rebase_to_author",
    summary:
      "An agent's open pull request that conflicts, is behind its base, or whose base merged wakes its author, naming the merge that caused it.",
    on: ["pr.conflicted", "pr.behind_base", "pr.base_merged"],
    when: AGENT_PR_OPEN,
    decide: { wake: { person: "author", kind: "rebase" } },
    instruction:
      "Your pull request #{{pr.number}} ({{pr.title}}) {{pr.problem}}{{cause}}. Bring it up to date with `{{pr.base}}` the way the repository asks, and push.",
  },
  {
    id: "ci_failed_to_author",
    summary: "Failing checks on an agent's open pull request wake its author.",
    on: ["pr.ci_failed"],
    when: AGENT_PR_OPEN,
    decide: { wake: { person: "author", kind: "ci_failed" } },
    instruction:
      "Your pull request #{{pr.number}} ({{pr.title}}) {{pr.problem}}. The failing checks are in the feedback. Fix them and push.",
  },
  {
    id: "opened_to_review",
    summary: "A pull request opened for review moves its ticket to review, for the author.",
    on: ["pr.opened"],
    when: { all: [{ not: { pr_draft: true } }, { ticket_status: ["backlog", "ready", "active"] }] },
    decide: { act: { as: "author", ops: [{ move: "review" }] } },
    instruction: "Moved to review for {{person}} (pull request #{{pr.number}} opened).",
  },
  {
    id: "assigned_to_assignee",
    summary: "A ticket assigned to an agent, by anyone but that agent, wakes the agent.",
    on: ["ticket.assigned", "ticket.created"],
    when: {
      all: [
        { assignee_kind: "agent" },
        { not: { actor_kind: "automation" } },
        { not: { actor_is: "assignee" } },
        NOT_CLOSED,
      ],
    },
    decide: { wake: { person: "assignee", kind: "assigned" } },
    instruction: "{{ticket}} is assigned to you. Work on it the way the repository asks.",
  },
  {
    id: "ticket_comment_to_agent",
    summary: "A human's comment on a ticket wakes the agent it mentions, else the agent assigned.",
    on: ["ticket.commented"],
    when: {
      all: [HUMAN, NOT_CLOSED, { any: [{ agent_mentioned: true }, { assignee_kind: "agent" }] }],
    },
    decide: { wake: { person: ["mentioned", "assignee"], kind: "ticket_comment" } },
    instruction: "{{actor.id}} commented on {{ticket}}. Read the comment and act on it.",
  },
  {
    id: "moved_active_to_assignee",
    summary: "A human moving a ticket to active wakes the agent assigned.",
    on: ["ticket.moved"],
    when: { all: [HUMAN, { moved_to: ["active"] }, { assignee_kind: "agent" }] },
    decide: { wake: { person: "assignee", kind: "assigned" } },
    instruction: "{{actor.id}} moved {{ticket}} to active. Pick the work up.",
  },
  {
    id: "doc_comment_to_agent",
    summary:
      "A human's comment on a document wakes the agent it mentions, else the agent who wrote it.",
    on: ["doc.commented"],
    when: HUMAN,
    decide: { wake: { person: ["mentioned", "doc_author"], kind: "doc_feedback" } },
    instruction:
      "{{actor.id}} commented on the document {{doc.title}}. Answer in the document and change it if needed.",
  },
  {
    id: "hand_back_done",
    summary:
      "A hand-back as done moves the ticket to review and gives it to the requester, for the agent.",
    on: ["agent.handed_back"],
    when: {
      all: [
        { hand_back_status: ["done"] },
        { not: { ticket_status: ["blocked", "done", "canceled"] } },
      ],
    },
    decide: { act: { as: "actor", ops: [{ move: "review" }, { assign: "requester" }] } },
    instruction:
      "Moved to review and assigned to the requester for {{person}}, who handed the work back as done.",
  },
  {
    id: "hand_back_blocked",
    summary:
      "A hand-back as blocked, or as done on a ticket the agent moved to blocked, moves the ticket to blocked and gives it to the requester, for the agent.",
    on: ["agent.handed_back"],
    when: {
      all: [
        {
          any: [
            { hand_back_status: ["blocked"] },
            { all: [{ hand_back_status: ["done"] }, { ticket_status: ["blocked"] }] },
          ],
        },
        NOT_CLOSED,
      ],
    },
    decide: { act: { as: "actor", ops: [{ move: "blocked" }, { assign: "requester" }] } },
    instruction:
      "Moved to blocked and assigned to the requester for {{person}}, who handed the work back as blocked.",
  },
  {
    id: "idle_pulls_next",
    summary:
      "An agent with nothing queued or running is woken with its next ready ticket: the highest tracker priority, then the one ready the longest (policies.pull_ready).",
    on: ["agent.idle"],
    decide: { wake: { person: "actor", kind: "assigned", subject: "next_ready_ticket" } },
    instruction:
      "You have nothing queued. Start {{next.ticket}}, the next ready ticket assigned to you. Work on it the way the repository asks.",
  },
];

/** Policies that are on only while a `policies` switch is: the idle pull, as the scheduler does with the pipeline off. */
export const POLICY_SWITCH_OF: Readonly<Record<string, string>> = {
  idle_pulls_next: "pull_ready",
};
