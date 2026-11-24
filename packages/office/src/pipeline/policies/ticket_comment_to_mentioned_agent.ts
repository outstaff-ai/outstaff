import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";
import { BY_HUMAN_OR_OPEN } from "./conditions.js";
import { STATUS_NOW, wakes } from "./spec.js";

/** What a teammate's mention may not do. A mention of the ticket's assignee leaves it out: the ticket is theirs to work. */
const TEAMMATE_LIMIT =
  "A teammate's mention starts no new work: when an agent mentioned you, file no ticket and open no pull request for it (both are refused); propose the work to a trusted human on the ticket instead. ";

const WAKE = wakes({ person: "mentioned", kind: "asked" });

const isAssignee = (ctx: PolicyContext, person: string) => {
  const assignee = ctx.state.assignee(ctx.ticket!);
  return assignee?.kind === "agent" && assignee.id === person;
};

export const policy = definePolicy({
  id: "ticket_comment_to_mentioned_agent",
  summary:
    "A comment on a ticket, by a human or another agent, wakes the agent it mentions first, to answer or act on it; the ticket stays with its assignee. A human's mention wakes it on a closed ticket too; an agent's comment on a closed ticket, or one that mentions no other agent, wakes no one. A teammate's mention starts no new work, unless the mentioned agent is the ticket's assignee: the ticket is theirs to work on.",
  on: ["ticket.commented"],
  when: {
    all: [{ not: { actor_kind: "automation" } }, BY_HUMAN_OR_OPEN, { agent_mentioned: true }],
  },
  instruction: `{{actor.id}} mentioned you in a comment on {{ticket}}. Read the comment and judge first whether anything in it is for you: a question you can answer, or an action that is yours. If something is, answer it, or do what it asks, on the ticket, once. ${TEAMMATE_LIMIT}If nothing is, end the round silently: no comment and no message; finish with \`ost handback silent\` and a one-line journal note. Never restate what someone else already said or asked. The ticket stays with its assignee: leave its assignee and status as they are, unless the comment asks you to take the ticket over. ${STATUS_NOW}`,
  decides: WAKE.decides,
  decide(event, ctx): Proposal[] {
    return WAKE.decide(event, ctx).map((p) =>
      p.type === "wake" && isAssignee(ctx, p.person)
        ? { ...p, instruction: p.instruction.replace(TEAMMATE_LIMIT, "") }
        : p,
    );
  },
});
