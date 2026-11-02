import { definePolicy, type ActSpec } from "@outstaff/policy";
import { BLOCKED_ON_AGENT } from "./conditions.js";
import { acts } from "./spec.js";

/** The assignee is an agent: it moves the ticket and is woken to work on it. */
const forAssignee: ActSpec = {
  as: "assignee",
  ops: [{ move: "ready" }],
  wake: { kind: "assigned" },
};

/** No agent holds the ticket: the agent who closed the blocker moves it, and wakes no one. */
const forCloser: ActSpec = { as: ["assignee", "closer"], ops: [{ move: "ready" }], note: "" };

export const policy = definePolicy({
  id: "unblocked_to_ready",
  summary:
    "A blocked ticket whose last open blocker was closed, with no agent blocked on it, was only waiting on its blockers: it moves to ready, for the agent it is assigned to, who is then woken; else for the agent who closed the blocker.",
  on: ["ticket.unblocked"],
  when: { all: [{ ticket_status: ["blocked"] }, { not: BLOCKED_ON_AGENT }] },
  instruction:
    "{{blocker}}, which blocked {{ticket}}, is closed, and no other ticket blocks it: {{ticket}} is ready again. Work on it the way the repository asks.",
  decides: `${acts(forAssignee).decides}; with no agent assigned, act for \`closer\`: move the ticket to \`ready\``,
  decide: (_event, ctx) =>
    "value" in ctx.person("assignee") ? ctx.act(forAssignee) : ctx.act(forCloser),
});
