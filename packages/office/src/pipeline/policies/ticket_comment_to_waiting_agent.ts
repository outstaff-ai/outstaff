import {
  definePolicy,
  type PolicyContext,
  type Proposal,
  type WaitingAgent,
} from "@outstaff/policy";
import { HUMAN } from "./conditions.js";
import { STATUS_NOW } from "./spec.js";

const KIND = "ticket_comment";
const MENTION_KIND = "asked";

/** The agents the comment mentions, as intake resolved them (`data.mentions`). */
const mentioned = (data: Record<string, unknown>): unknown[] =>
  Array.isArray(data["mentions"]) ? data["mentions"] : [];

/** The agent's wake with the instruction, and why: the comment of its that made it wait. */
function wakeOf(w: WaitingAgent, ticket: string, human: string, ctx: PolicyContext): Proposal {
  const instruction = ctx.render(ctx.instruction ?? "", { person: w.agent });
  if ("skip" in instruction) {
    return { type: "drop", reason: `the instruction cannot be rendered: ${instruction.skip}` };
  }

  const comment = w.url ? ` (${w.url})` : "";
  return {
    type: "wake",
    person: w.agent,
    kind: KIND,
    instruction: instruction.value,
    reason: `${w.agent} waits on ${human} on ${ticket}: it mentioned them there at ${w.at}${comment}, after their last comment there`,
  };
}

export const policy = definePolicy({
  id: "ticket_comment_to_waiting_agent",
  summary:
    "A human's comment on a ticket, in any status, wakes every agent waiting on that human there: each agent that commented on the ticket after the human's last comment there, mentioning them. The comment is the human's answer to what the agent asked, so it can start new work.",
  on: ["ticket.commented"],
  when: { all: [HUMAN, { awaited_human: true }] },
  instruction: `{{actor.id}} commented on {{ticket}}, where you asked them something: this is their answer to you. Act on it: continue the work you held for it, on whichever ticket that is (for example the one you are blocked on, or a parent you were splitting), and say there what you did. It is a trusted human's word, so it starts new work a teammate's mention cannot, such as filing the tickets it confirms. If it does not answer what you asked, answer it on {{ticket}} and keep waiting. ${STATUS_NOW}`,
  decides: `wake each agent waiting on the human on the ticket (kind \`${KIND}\`), instead of the \`${MENTION_KIND}\` wake of one the comment also mentions`,
  decide: (event, ctx) => {
    // `awaited_human` held, so the event is about a ticket.
    const ticket = ctx.ticket!;
    const human = event.actor.id;
    const named = mentioned(event.data);
    return ctx.state.waitingOn(ticket, human, event.at).flatMap((w): Proposal[] => [
      wakeOf(w, ticket, human, ctx),
      // The human also mentions it: one run, with the answer's instruction, not a second of another kind.
      ...(named.includes(w.agent)
        ? [
            {
              type: "suppress" as const,
              person: w.agent,
              subject: { type: "ticket" as const, ref: ticket },
              kind: MENTION_KIND,
              reason: `the comment answers what ${w.agent} asked ${human} on ${ticket}: it is woken for the answer`,
            },
          ]
        : []),
    ]);
  },
});
