import { definePolicy, type ActSpec } from "@outstaff/policy";
import { BLOCKED_ON_AGENT } from "./conditions.js";
import { acts } from "./spec.js";

/** The assignee is an agent: it moves the ticket and is woken to work on it. */
const forAssignee: ActSpec = {
  as: "assignee",
  ops: [{ move: "ready" }],
  wake: { kind: "assigned" },
};

/**
 * The blocker was a sibling sub-ticket and the parent is with the same agent, who coordinates its sub-tickets: a wake
 * on the parent for that close is the only one, and the idle pull starts this one when the agent has nothing queued.
 */
const quietly: ActSpec = { as: "assignee", ops: [{ move: "ready" }], note: "" };

/** No agent holds the ticket: the agent who closed the blocker moves it, and wakes no one. */
const forCloser: ActSpec = { as: ["assignee", "closer"], ops: [{ move: "ready" }], note: "" };

export const policy = definePolicy({
  id: "unblocked_to_ready",
  summary:
    "A blocked ticket whose last open blocker was closed, with no agent blocked on it, was only waiting on its blockers: it moves to ready, for the agent it is assigned to, who is then woken; else for the agent who closed the blocker. When the blocker is a sub-ticket of the same parent and that parent is with the same agent, the ticket is only moved and no one is woken here: the agent holding the parent coordinates its sub-tickets, and the idle pull starts this one when it has nothing queued.",
  on: ["ticket.unblocked"],
  when: { all: [{ ticket_status: ["blocked"] }, { not: BLOCKED_ON_AGENT }] },
  instruction:
    "{{blocker}}, which blocked {{ticket}}, is closed, and no other ticket blocks it: {{ticket}} is ready again. Work on it the way the repository asks.",
  decides: `${acts(forAssignee).decides}, unless the blocker is a sub-ticket of the same parent and the parent is with that agent (\`parentAgent\`): then only move it; with no agent assigned, act for \`closer\`: move the ticket to \`ready\``,
  decide: (event, ctx) => {
    const assignee = ctx.person("assignee");
    if (!("value" in assignee)) {
      return ctx.act(forCloser);
    }

    return event.data["parentAgent"] === assignee.value ? ctx.act(quietly) : ctx.act(forAssignee);
  },
});
